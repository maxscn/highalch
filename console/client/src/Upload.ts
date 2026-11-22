import { parseApiKey } from "@highalch/console-domain/Credentials";
import { maxArtifactsPerBatch } from "@highalch/console-domain/Organization/DeclareArtifacts.command";
import type { OrganizationId } from "@highalch/console-domain/Organization/Organization.id";
import { maxPartBytes } from "@highalch/console-domain/Organization/RecordResults.command";
import { ProjectId } from "@highalch/console-domain/Project/Project.id";
import { RunId } from "@highalch/console-domain/Run/Run.id";
import type { Kind } from "@highalch/console-domain/Run/Run.values";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";
import { detect, type Env } from "./Ci.ts";
import {
  connect,
  retrying,
  type Connection,
  type Credential,
  type RetryOptions,
} from "./Connection.ts";
import {
  InvalidItem,
  ItemTooLarge,
  ProjectMismatch,
  SettingMissing,
  UploadRefused,
  WriteFailed,
} from "./Errors.ts";
import { CaseItem, countsOf, TestItem, TraceItem, type Items } from "./Results.ts";
import { recordOf, type StoryFiles } from "./Stories.ts";

/** Options shared by every HighAlch Console reporter. Each falls back to an environment variable. */
export interface Options {
  /** HighAlch Console's origin. Default `HIGHALCH_URL`; without it nothing is uploaded. */
  readonly url?: string;
  /** Project API key (`highalch_live_…`). Default `HIGHALCH_API_KEY`, else GitHub Actions OIDC. */
  readonly apiKey?: string | Redacted.Redacted<string>;
  /**
   * Project slug. Default `HIGHALCH_PROJECT`, else the API key's project. Uploads go to the
   * credential's project; a different one configured here is refused (`ProjectMismatch`).
   */
  readonly project?: string;
  readonly commit?: string;
  readonly branch?: string;
  /** Overrides the detected pull request number; `null` forces "no PR". */
  readonly pr?: number | null;
  readonly source?: string;
  /** Overrides the detected pull request base branch (the snapshot baseline). */
  readonly baseBranch?: string;
  /** Offline output directory, relative to `cwd`. Default `.highalch`. */
  readonly dir?: string;
  readonly cwd?: string;
  readonly env?: Env;
  /** Fetch implementation behind the HttpClient. Default global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Attempts per request including the first (default 4); first backoff in ms (default 250). */
  readonly retry?: { readonly attempts?: number; readonly delay?: number };
}

/** A body to upload as an artifact. */
export interface File {
  readonly name: string;
  readonly mime: string;
  readonly body: Uint8Array | string;
}

export type LocalReason = "no-url" | "no-credentials";

export type Outcome =
  | { readonly mode: "remote"; readonly runId: string; readonly org: string }
  | {
      readonly mode: "local";
      readonly runId: string;
      readonly dir: string;
      readonly reason: LocalReason;
    };

/** What `open` needs from the platform (`NodeServices.layer` in Node) and a scope for the connection. */
export type Requirements =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | Scope.Scope;

const encoder = new TextEncoder();
const bytesOf = (body: Uint8Array | string) =>
  typeof body === "string" ? encoder.encode(body) : body;

const sha256 = (body: Uint8Array) =>
  Effect.flatMap(Digest.Digest, (digest) => digest.digestHex(Digest.sha256, body));

interface Prepared {
  readonly name: string;
  readonly mime: string;
  readonly body: Uint8Array;
  readonly sha256: string;
}

const prepare = (file: File) =>
  Effect.map(sha256(bytesOf(file.body)), (sha): Prepared => ({
    name: file.name.slice(0, 512) || "artifact",
    mime: file.mime.slice(0, 255),
    body: bytesOf(file.body),
    sha256: sha,
  }));

const chunk = <A>(items: ReadonlyArray<A>, size: number) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, n) =>
    items.slice(n * size, (n + 1) * size),
  );

/** One results object: a JSON array of one part's items. */
interface ResultObject {
  readonly part: "tests" | "cases" | "traces";
  readonly items: ReadonlyArray<unknown>;
  readonly body: Uint8Array;
  readonly sha256: string;
}

const schemas = { tests: TestItem, cases: CaseItem, traces: TraceItem } as const;

/** Encodes each part's items and packs them into JSON arrays of at most `maxPartBytes`. */
const objectsOf = Effect.fn("Upload.objects")(function* (items: Items) {
  const objects: Array<ResultObject> = [];
  for (const part of ["tests", "cases", "traces"] as const) {
    const list: ReadonlyArray<unknown> = items[part] ?? [];
    let current: Array<unknown> = [];
    let encoded: Array<string> = [];
    const flush = Effect.gen(function* () {
      if (current.length === 0) return;
      const body = encoder.encode(`[${encoded.join(",")}]`);
      objects.push({ part, items: current, body, sha256: yield* sha256(body) });
      current = [];
      encoded = [];
    });
    for (const item of list) {
      const json = JSON.stringify(
        yield* Schema.encodeUnknownEffect(schemas[part] as Schema.Codec<unknown, unknown>)(
          item,
        ).pipe(Effect.mapError((error) => new InvalidItem({ part, message: error.message }))),
      );
      const bytes = encoder.encode(json).byteLength;
      if (bytes + 2 > maxPartBytes)
        return yield* new ItemTooLarge({ part, bytes, max: maxPartBytes });
      const size = encoded.reduce((sum, e) => sum + encoder.encode(e).byteLength + 1, 1);
      if (size + bytes + 1 > maxPartBytes) yield* flush;
      current.push(item);
      encoded.push(json);
    }
    yield* flush;
  }
  return objects;
});

/** Items of one batch of objects, by part, for its counts. */
const itemsOf = (objects: ReadonlyArray<ResultObject>): Items => ({
  tests: objects.flatMap((o) => (o.part === "tests" ? (o.items as Array<TestItem>) : [])),
  cases: objects.flatMap((o) => (o.part === "cases" ? (o.items as Array<CaseItem>) : [])),
  traces: objects.flatMap((o) => (o.part === "traces" ? (o.items as Array<TraceItem>) : [])),
});

const remote = Effect.fn("Upload.remote")(function* (
  connection: Connection,
  org: OrganizationId,
  run: RunId,
  kind: Kind,
  retry: RetryOptions,
) {
  const { api, call } = connection;
  const http = retrying(yield* HttpClient.HttpClient, retry);
  const context = yield* Effect.context<Digest.Digest | SecureRandom.SecureRandom>();
  const known = yield* Ref.make(new Map<string, string>());
  const commandId = Effect.map(
    Effect.flatMap(SecureRandom.SecureRandom, (random) => random.randomBytes(12)),
    Hex.encode,
  );

  /** PUTs a body through its signed link; a refusal is `UploadRefused`. */
  const put = (
    name: string,
    link: { readonly url: string; readonly headers: Readonly<Record<string, string>> },
    body: Uint8Array,
  ) =>
    http
      .execute(
        HttpClientRequest.put(link.url).pipe(
          HttpClientRequest.setHeaders(link.headers),
          HttpClientRequest.bodyUint8Array(body, link.headers["content-type"]),
        ),
      )
      .pipe(
        Effect.asVoid,
        Effect.catchTag("HttpClientError", (error) =>
          Effect.fail(
            new UploadRefused({
              name,
              status: error.reason._tag === "StatusCodeError" ? error.reason.response.status : 0,
            }),
          ),
        ),
      );

  /** PUTs, asking for a fresh link once when the first one expired on the way (403). */
  const send = <E>(
    name: string,
    link: { readonly url: string; readonly headers: Readonly<Record<string, string>> },
    body: Uint8Array,
    again: Effect.Effect<
      { readonly url: string; readonly headers: Readonly<Record<string, string>> } | null,
      E
    >,
  ) =>
    put(name, link, body).pipe(
      Effect.catchTag("UploadRefused", (refused) =>
        refused.status === 403
          ? Effect.flatMap(again, (fresh) =>
              fresh === null ? Effect.void : put(name, fresh, body),
            )
          : Effect.fail(refused),
      ),
    );

  /** Declares one batch, asks for its links at the declaration's receipt, PUTs what is new. */
  const declare = Effect.fn("Upload.declare")(function* (batch: ReadonlyArray<Prepared>) {
    const receipt = yield* call(
      "DeclareArtifacts",
      api.DeclareArtifacts(
        org,
        {
          org,
          run,
          artifacts: batch.map(({ name, mime, body, sha256 }) => ({
            name,
            mime,
            bytes: body.byteLength,
            sha256,
          })),
        },
        { commandId: yield* commandId },
      ),
    );
    const ids = receipt.reply.ids;
    const links = yield* call(
      "UploadLinks",
      api.UploadLinks(
        { run, artifacts: ids, results: [] },
        { atLeast: { stream: receipt.stream, version: receipt.version } },
      ),
    );
    yield* Effect.forEach(
      links.artifacts,
      ({ id, link }, index) => {
        const entry = batch[index];
        if (link === null || entry === undefined) return Effect.void;
        const fresh = Effect.map(
          call("UploadLinks", api.UploadLinks({ run, artifacts: [id], results: [] })),
          (answer) => answer.artifacts[0]?.link ?? null,
        );
        return send(entry.name, link, entry.body, fresh);
      },
      { concurrency: 4 },
    );
    return ids;
  });

  const artifacts = (files: ReadonlyArray<File>) =>
    Effect.gen(function* () {
      const prepared = yield* Effect.forEach(files, prepare);
      const seen = yield* Ref.get(known);
      const fresh = prepared.filter(
        (entry, index) =>
          !seen.has(entry.sha256) &&
          prepared.findIndex((other) => other.sha256 === entry.sha256) === index,
      );
      for (const batch of chunk(fresh, maxArtifactsPerBatch)) {
        const ids = yield* declare(batch);
        yield* Ref.update(known, (map) => {
          const next = new Map(map);
          batch.forEach((entry, index) => next.set(entry.sha256, ids[index] ?? ""));
          return next;
        });
      }
      const all = yield* Ref.get(known);
      return prepared.map((entry) => all.get(entry.sha256) ?? "");
    }).pipe(Effect.provide(context));

  const results = (items: Items) =>
    Effect.gen(function* () {
      const objects = yield* objectsOf(items);
      for (const batch of chunk(objects, 3)) {
        const receipt = yield* call(
          "RecordResults",
          api.RecordResults(
            org,
            {
              org,
              run,
              kind,
              parts: batch.map((o) => ({
                part: o.part,
                sha256: o.sha256,
                bytes: o.body.byteLength,
                count: o.items.length,
              })),
              ...countsOf(itemsOf(batch)),
            },
            { commandId: yield* commandId },
          ),
        );
        const links = yield* call(
          "UploadLinks",
          api.UploadLinks(
            { run, artifacts: [], results: receipt.reply.keys },
            { atLeast: { stream: receipt.stream, version: receipt.version } },
          ),
        );
        yield* Effect.forEach(
          links.results,
          ({ key, link }, index) => {
            const object = batch[index];
            if (link === null || object === undefined) return Effect.void;
            const fresh = Effect.map(
              call("UploadLinks", api.UploadLinks({ run, artifacts: [], results: [key] })),
              (answer) => answer.results[0]?.link ?? null,
            );
            return send(`${object.part} results`, link, object.body, fresh);
          },
          { concurrency: 3 },
        );
      }
    }).pipe(Effect.provide(context));

  /**
   * Each report: its `story.json` and frames declared and uploaded first (their artifact ids),
   * then `RecordStory` with the header and the summary of its steps.
   */
  const stories = (reports: ReadonlyArray<StoryFiles>) =>
    Effect.forEach(
      reports,
      (story) =>
        Effect.gen(function* () {
          const frames = [...story.frames];
          const ids = yield* artifacts([
            { name: `${story.report.slug}/story.json`, mime: "application/json", body: story.body },
            ...frames.map(([file, body]) => ({
              name: `${story.report.slug}/${file}`,
              mime: "image/png",
              body,
            })),
          ]);
          const record = recordOf(story.report, {
            report: ids[0] ?? "",
            frames: new Map(frames.map(([file], index) => [file, ids[index + 1] ?? ""])),
          });
          yield* call(
            "RecordStory",
            api.RecordStory(org, { org, run, ...record }, { commandId: yield* commandId }),
          );
        }),
      { discard: true },
    ).pipe(Effect.provide(context));

  const complete = () =>
    Effect.gen(function* () {
      yield* call(
        "CompleteRun",
        api.CompleteRun(org, { org, run }, { commandId: `complete:${run}` }),
      );
      return { mode: "remote", runId: run, org } satisfies Outcome;
    });

  return { mode: "remote" as const, runId: run, artifacts, results, stories, complete };
});

const extensions: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "text/html": "html",
  "video/webm": "webm",
  "application/zip": "zip",
  "application/json": "json",
  "text/plain": "txt",
};
const extension = (mime: string) => extensions[mime.split(";")[0]?.trim() ?? ""] ?? "bin";

/** Without a URL or a credential: the same payloads as files under `<dir>/runs/<runId>/`. */
const local = Effect.fn("Upload.local")(function* (
  root: string,
  run: RunId,
  opening: unknown,
  reason: LocalReason,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* Effect.context<Digest.Digest>();
  const dir = path.join(root, "runs", run);
  const write = (file: string, body: string | Uint8Array) =>
    fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(
      Effect.andThen(
        typeof body === "string" ? fs.writeFileString(file, body) : fs.writeFile(file, body),
      ),
      Effect.mapError((error) => new WriteFailed({ path: file, message: error.message })),
    );
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const declared = yield* Ref.make<ReadonlyArray<Omit<Prepared, "body"> & { readonly id: string }>>(
    [],
  );
  const batches = yield* Ref.make(0);
  yield* write(path.join(dir, "open.json"), json(opening));

  const artifacts = (files: ReadonlyArray<File>) =>
    Effect.forEach(files, (file) =>
      Effect.gen(function* () {
        const entry = yield* prepare(file);
        const id = `local-${entry.sha256}`;
        if ((yield* Ref.get(declared)).some((d) => d.sha256 === entry.sha256)) return id;
        yield* write(
          path.join(dir, "artifacts", `${entry.sha256}.${extension(entry.mime)}`),
          entry.body,
        );
        yield* Ref.update(declared, (list) => [
          ...list,
          { name: entry.name, mime: entry.mime, sha256: entry.sha256, id },
        ]);
        return id;
      }),
    ).pipe(
      Effect.tap(() =>
        Effect.flatMap(Ref.get(declared), (list) =>
          write(path.join(dir, "artifacts.json"), json(list)),
        ),
      ),
      Effect.provide(context),
    );

  const results = (items: Items) =>
    Effect.gen(function* () {
      for (const object of yield* objectsOf(items)) {
        const n = yield* Ref.updateAndGet(batches, (x) => x + 1);
        yield* write(
          path.join(dir, "results", `${String(n).padStart(4, "0")}.${object.part}.json`),
          object.body,
        );
      }
    }).pipe(Effect.provide(context));

  const stories = (reports: ReadonlyArray<StoryFiles>) =>
    Effect.forEach(
      reports,
      (story) =>
        Effect.gen(function* () {
          yield* write(path.join(dir, "stories", story.report.slug, "story.json"), story.body);
          for (const [file, body] of story.frames)
            yield* write(path.join(dir, "stories", story.report.slug, file), body);
        }),
      { discard: true },
    );

  const complete = () =>
    write(path.join(dir, "complete.json"), json({ reason })).pipe(
      Effect.as<Outcome>({ mode: "local", runId: run, dir, reason }),
    );

  return { mode: "local" as const, runId: run, artifacts, results, stories, complete };
});

/**
 * Opens a run of `kind`. Uploads when a URL and a credential are available (an API key, or
 * GitHub Actions OIDC); otherwise writes the same payloads to `<dir>/runs/<runId>/`.
 * Credentials are `Redacted` and never logged.
 */
export const open = Effect.fn("Upload.open")(function* (options: Options, kind: Kind) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const key = options.apiKey ?? env.HIGHALCH_API_KEY;
  const apiKey =
    key === undefined || key === ""
      ? undefined
      : Redacted.isRedacted(key)
        ? key
        : Redacted.make(key);
  const configured =
    options.project ??
    env.HIGHALCH_PROJECT ??
    (apiKey !== undefined
      ? Option.getOrUndefined(
          Option.map(parseApiKey(Redacted.value(apiKey)), (parsed) => parsed.project),
        )
      : undefined);
  const detected = yield* detect(env, cwd);
  const pr = options.pr === undefined ? (detected.pr ?? null) : options.pr;
  const branch = options.branch ?? detected.branch;
  const contextOf = (project: string) => ({
    project: ProjectId.make(project),
    commit: options.commit ?? detected.commit,
    branch,
    pr,
    source: options.source ?? detected.source,
    kind,
    baseBranch: options.baseBranch ?? detected.baseBranch ?? branch,
    commitInfo: detected.commitInfo ?? null,
    pull: pr === null ? null : (detected.pull ?? null),
  });
  const platform = Layer.mergeAll(
    FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, options.fetch ?? globalThis.fetch)),
    ),
    Digest.layerWebCrypto,
    SecureRandom.layerWebCrypto,
  );
  return yield* Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const run = RunId.make(`r-${Hex.encode(yield* random.randomBytes(10))}`);
    const url = options.url ?? env.HIGHALCH_URL;
    const credential: Credential | undefined =
      apiKey !== undefined
        ? { _tag: "ApiKey", token: apiKey }
        : env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
          ? {
              _tag: "GithubActions",
              url: env.ACTIONS_ID_TOKEN_REQUEST_URL,
              token: Redacted.make(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN),
            }
          : undefined;
    if (!url || credential === undefined) {
      if (!configured) return yield* new SettingMissing({ setting: "HIGHALCH_PROJECT" });
      const path = yield* Path.Path;
      return yield* local(
        path.resolve(cwd, options.dir ?? ".highalch"),
        run,
        { run, ...contextOf(configured) },
        url ? "no-credentials" : "no-url",
      );
    }
    const retry = { attempts: options.retry?.attempts ?? 4, delay: options.retry?.delay ?? 250 };
    const connection = yield* connect(url, credential, retry);
    // where the credential uploads to: its organisation and project
    const bound = yield* connection.call("Credential", connection.api.Credential({}));
    if (configured !== undefined && configured !== bound.project)
      return yield* new ProjectMismatch({ configured, credential: bound.project });
    yield* connection.call(
      "OpenRun",
      connection.api.OpenRun(
        bound.org,
        { org: bound.org, run, ...contextOf(bound.project) },
        { commandId: `open:${run}` },
      ),
    );
    return yield* remote(connection, bound.org, run, kind, retry);
  }).pipe(Effect.provide(platform));
});

/**
 * One run being reported: `artifacts` (bodies, deduplicated by SHA-256, answering their ids in
 * order), `results` (items packed into objects of at most 1 MB), `stories` (story reports with
 * their `story.json` and frames as artifacts), `complete`. Every method fails with a tagged
 * error: the client's own (`Errors.ts`) or what HighAlch Console refused.
 */
export type Upload =
  | Effect.Success<ReturnType<typeof remote>>
  | Effect.Success<ReturnType<typeof local>>;

type MethodErrors<U> = {
  [K in keyof U]: U[K] extends (...args: never) => Effect.Effect<unknown, infer E, unknown>
    ? E
    : never;
}[keyof U];

/** Everything opening, uploading and completing a run can fail with. */
export type Failure = Effect.Error<ReturnType<typeof open>> | MethodErrors<Upload>;
