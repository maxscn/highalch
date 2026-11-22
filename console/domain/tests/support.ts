import { createHash } from "node:crypto";
import * as HighAlch from "@lowalch/tanstack-db";
import * as Story from "@highalch/story";
import { LowAlchDb } from "@highalch/story/lowalch";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type * as Schema from "effect/Schema";
import type { Actor } from "../src/Actor.ts";
import {
  CallerLive,
  GithubOidc,
  Sessions,
  type GithubClaims,
  type SessionUser,
} from "../src/Authentication.ts";
import { Blob } from "../src/Blob/Blob.aggregate.ts";
import { Caller } from "../src/Caller.middleware.ts";
import { ConsoleApi } from "../src/Console.api.ts";
import { ConsoleHandlers } from "../src/Console.model.ts";
import { apiKeyPrefix, displayPrefix, formatApiKey, sessionCookie } from "../src/Credentials.ts";
import { CurrentActor } from "../src/CurrentActor.context.ts";
import { UserId } from "../src/Ids.ts";
import { Organization } from "../src/Organization/Organization.aggregate.ts";
import { OrganizationId } from "../src/Organization/Organization.id.ts";
import { Project } from "../src/Project/Project.aggregate.ts";
import { ProjectId, RepositoryId } from "../src/Project/Project.id.ts";
import { Repository } from "../src/Project/Repository.aggregate.ts";
import { Run } from "../src/Run/Run.aggregate.ts";
import { RunId } from "../src/Run/Run.id.ts";
import type { Kind } from "../src/Run/Run.values.ts";
import { Storage } from "../src/Storage.external.ts";
import { Payments, type Purchase } from "../src/Payments.external.ts";
import { AppOrigin } from "../src/AppOrigin.ts";
import { PlanActivated } from "../src/Organization/ActivatePlan.command.ts";
import { OrganizationCreated } from "../src/Organization/CreateOrganization.command.ts";
import { RepositoryClaimed } from "../src/Project/ClaimRepository.command.ts";
import { ProjectCreated } from "../src/Project/CreateProject.command.ts";
import { ApiKeyIssued } from "../src/Project/IssueApiKey.command.ts";
import { DeclareArtifacts } from "../src/Organization/DeclareArtifacts.command.ts";
import { CompleteRun, OpenRun, RunOpened } from "../src/Organization/OpenRun.command.ts";
import { RunCreated } from "../src/Run/CreateRun.command.ts";
import { RecordResults } from "../src/Organization/RecordResults.command.ts";
import { RecordStory } from "../src/Story/RecordStory.command.ts";

/**
 * The Console hosted in memory for stories: the real model and handlers, an in-memory object
 * store behind `Storage`, and the real `CallerLive` behind each scope's client, fed the
 * credential that scope's requests carry (`Callers`) and fake identity providers.
 */

// ---------------------------------------------------------------- people and things

export const DAY = 86_400_000;
/** Stories run on the platform's clock (`Date.now`): times are relative to when they start. */
export const now = () => Date.now();

export const orgA = OrganizationId.make("org-a");
export const orgB = OrganizationId.make("org-b");
export const crm = ProjectId.make("crm");
export const other = ProjectId.make("other");
export const billingProject = ProjectId.make("billing");
export const run1 = RunId.make("run-1");
export const run2 = RunId.make("run-2");
export const acmeCrm = RepositoryId.make("acme/crm");

export const alice: SessionUser = {
  id: UserId.make("u-alice"),
  email: "alice@example.com",
  name: "Alice",
};
export const bob: SessionUser = { id: UserId.make("u-bob"), email: "bob@example.com", name: null };

/** Session tokens the fake identity provider knows. */
const users = new Map<string, SessionUser>([
  ["s-alice", alice],
  ["s-bob", bob],
]);

/** A browser request of a signed-in user. */
export const session = (user: SessionUser): Headers.Input => ({
  cookie: `theme=dark; ${sessionCookie}=s-${user.id.slice(2)}`,
});

/** A request with an API key (or anything else) as its bearer token. */
export const bearer = (token: string): Headers.Input => ({ authorization: `Bearer ${token}` });

/** A project API key: its token, and the hash its issuing records. */
export const apiKey = (project: string, keyId: string) => {
  const token = formatApiKey(project, keyId, `secret-${keyId}`);
  return {
    token,
    key: keyId,
    prefix: displayPrefix(token),
    hash: createHash("sha256").update(token).digest("hex"),
  };
};

/** GitHub OIDC tokens the fake verifier accepts, and their claims. */
export const oidc: Record<string, GithubClaims> = {
  "gh-main": { repository: "Acme/CRM", sha: "c0ffee0", ref: "refs/heads/main" },
  "gh-pr7": {
    repository: "acme/crm",
    sha: "f00d000",
    ref: "refs/pull/7/merge",
    head_ref: "feature",
    base_ref: "release",
  },
  "gh-elsewhere": { repository: "acme/unbound", sha: "c0ffee0", ref: "refs/heads/main" },
};

export { apiKeyPrefix };

// ---------------------------------------------------------------- the host

/** The headers each scope's requests carry, by scope; a step changes them mid-story. */
export class Callers extends Context.Service<Callers, Map<string, Headers.Input>>()(
  "Test/Callers",
) {}

/** The object store behind `Storage`: bodies by key, and what `inspect` finds per key. */
export class Objects extends Context.Service<
  Objects,
  {
    readonly json: Map<string, unknown>;
    readonly uploads: Map<string, "ok" | "missing" | "mismatch">;
    readonly removed: Array<string>;
    /** Every `readItems`, with the most items it asked for. */
    readonly reads: Array<{ readonly key: string; readonly limit: number }>;
  }
>()("Test/Objects") {}

const StorageMemory = Storage.toLayer(
  Effect.gen(function* () {
    const objects = yield* Objects;
    return {
      inspect: ({ key }) => Effect.succeed({ status: objects.uploads.get(key) ?? "missing" }),
      readItems: ({ key, limit }) =>
        Effect.sync(() => {
          const stored = objects.json.get(key);
          const items: ReadonlyArray<Schema.Json> = Array.isArray(stored) ? stored : [];
          objects.reads.push({ key, limit });
          return { items: items.slice(0, limit), total: items.length };
        }),
      writeJson: ({ key, value }) =>
        Effect.sync(() => {
          objects.json.set(key, value);
          return { bytes: JSON.stringify(value).length };
        }),
      remove: ({ keys }) =>
        Effect.sync(() => {
          for (const key of keys) {
            objects.json.delete(key);
            objects.removed.push(key);
          }
          return {};
        }),
      presignPut: ({ key, mime, bytes, sha256, seconds }) =>
        Effect.succeed({
          url: `memory://put/${key}?bytes=${bytes}&ttl=${seconds}`,
          headers: { "content-type": mime, "x-amz-checksum-sha256": sha256 },
        }),
      presignGet: ({ key, seconds }) =>
        Effect.succeed({ url: `memory://get/${key}?ttl=${seconds}` }),
    };
  }),
);

/** The fake payment provider: its customers by organisation, and every page it made. */
export class Stripe extends Context.Service<
  Stripe,
  {
    readonly customers: Map<string, string>;
    readonly checkouts: Array<{
      readonly customer: string;
      readonly org: string;
      readonly purchase: Purchase;
    }>;
  }
>()("Test/Stripe") {}

const PaymentsFake = Payments.toLayer(
  Effect.gen(function* () {
    const stripe = yield* Stripe;
    return {
      createCustomer: ({ org }) =>
        Effect.sync(() => {
          const customer = stripe.customers.get(org) ?? `cus_${org}`;
          stripe.customers.set(org, customer);
          return { customer };
        }),
      checkout: ({ customer, org, purchase, successUrl }) =>
        Effect.sync(() => {
          stripe.checkouts.push({ customer, org, purchase });
          return {
            url: `https://checkout.stripe.test/${stripe.checkouts.length}?then=${successUrl}`,
          };
        }),
      portal: ({ customer, returnUrl }) =>
        Effect.succeed({ url: `https://billing.stripe.test/${customer}?then=${returnUrl}` }),
    };
  }),
);

const identity = Layer.mergeAll(
  Layer.succeed(Sessions, {
    user: (token) => Effect.succeed(Option.fromNullishOr(users.get(Redacted.value(token)))),
  }),
  Layer.succeed(GithubOidc, {
    verify: (token) => Effect.succeed(Option.fromNullishOr(oidc[Redacted.value(token)])),
  }),
  Digest.layerWebCrypto,
);

/** Each story's fresh services: who each scope is, the object store, the identity providers. */
const services = (callers: ReadonlyArray<readonly [string, Headers.Input]>) => () =>
  Layer.mergeAll(
    Layer.sync(Callers, () => new Map(callers)),
    StorageMemory.pipe(
      Layer.provideMerge(
        Layer.sync(Objects, () => ({
          json: new Map(),
          uploads: new Map(),
          removed: [],
          reads: [],
        })),
      ),
    ),
    identity,
    Layer.succeed(AppOrigin, { origin: "https://app.test" }),
    PaymentsFake.pipe(
      Layer.provideMerge(Layer.sync(Stripe, () => ({ customers: new Map(), checkouts: [] }))),
    ),
  );

/**
 * A scope's client authenticates through the real `CallerLive`, with the headers `Callers`
 * holds for the scope when each request runs.
 */
const caller = (scope: string) =>
  Layer.effect(
    Caller,
    Effect.gen(function* () {
      const live = yield* Caller;
      const callers = yield* Callers;
      return (effect, options) =>
        live(effect, { ...options, headers: Headers.fromInput(callers.get(scope) ?? {}) });
    }),
  ).pipe(Layer.provide(CallerLive));

/**
 * A story runner over the Console, starting as a client of `org-a`, with the credentials each
 * scope (an organisation) uses: alice's session for `org-a` unless a story says otherwise.
 */
export const console = (
  callers: ReadonlyArray<readonly [string, Headers.Input]> = [[orgA, session(alice)]],
) =>
  Story.make(
    LowAlchDb.memory({
      api: ConsoleApi,
      layer: () => ConsoleHandlers,
      services: services(callers),
      // SAFETY: the session runs on the host's context, which holds `Callers`, the identity
      // providers and the model's aggregates and views that `CallerLive` reads.
      session: (scope) => caller(scope) as unknown as Layer.Layer<Caller>,
    }),
    { scope: orgA },
  );

// ---------------------------------------------------------------- steps

/** From now on, requests of `scope` carry these headers. */
export const signIn = (scope: string, headers: Headers.Input) =>
  Story.check(`${scope} authenticates as ${JSON.stringify(headers)}`, async (world) => {
    const callers = await world.host.service?.(Callers);
    callers?.set(scope, headers);
  });

/** The model's aggregates, as trusted server code reaches them. */
export interface Model {
  readonly organizations: (typeof Organization)["Service"];
  readonly projects: (typeof Project)["Service"];
  readonly repositories: (typeof Repository)["Service"];
  readonly runs: (typeof Run)["Service"];
  readonly blobs: (typeof Blob)["Service"];
}

const modelOf = async (world: Story.World): Promise<Model> => {
  const service = world.host.service;
  if (!service) throw new Error("this host has no services");
  return {
    organizations: await service(Organization),
    projects: await service(Project),
    repositories: await service(Repository),
    runs: await service(Run),
    blobs: await service(Blob),
  };
};

const server: Actor = { _tag: "System", name: "story" };

/**
 * Trusted server code acts (a payment webhook, the upload integration): an Effect over the
 * model's aggregates as the `System` actor. It must succeed; then the world settles.
 */
export const asServer = <A, E>(
  label: string,
  act: (model: Model) => Effect.Effect<A, E, CurrentActor>,
) =>
  Story.step(`the server: ${label}`, async (world) => {
    const model = await modelOf(world);
    await Effect.runPromise(Effect.provideService(Effect.asVoid(act(model)), CurrentActor, server));
    await world.settle();
  });

/** Reads the model as trusted server code, for a check. */
export const inModel = <A, E>(
  world: Story.World,
  read: (model: Model) => Effect.Effect<A, E, CurrentActor>,
) =>
  modelOf(world).then((model) =>
    Effect.runPromise(Effect.provideService(read(model), CurrentActor, server)),
  );

/** The object store, for a check. */
export const objectsOf = async (world: Story.World) => {
  const objects = await world.host.service?.(Objects);
  if (!objects) throw new Error("this host has no object store");
  return objects;
};

export { HighAlch, Story };

// ---------------------------------------------------------------- history

/** The paid period `paidOrganization` starts: it began a day before the tests, for 31 days. */
export const periodStart = now() - DAY;

/** An organisation `owner` created, on a paid starter period that is current. */
export const paidOrganization = (org: OrganizationId, owner: SessionUser, plan = "starter") =>
  Story.given(
    Organization.ref(org),
    new OrganizationCreated({
      name: org === orgA ? "Acme" : "Beta",
      owner: owner.id,
      ownerEmail: owner.email,
      ownerName: owner.name,
    }),
    new PlanActivated({
      plan,
      periodStart,
      periodEnd: periodStart + 31 * DAY,
      liftsSuspension: false,
    }),
  );

/** A project of `org`, bound to `repository`, with these API keys issued. */
export const existingProject = (
  slug: ProjectId,
  org: OrganizationId,
  options: {
    readonly repository?: RepositoryId;
    readonly keys?: ReadonlyArray<ReturnType<typeof apiKey>>;
  } = {},
) => [
  Story.given(
    Project.ref(slug),
    new ProjectCreated({ org, repository: options.repository ?? null, defaultBranch: "main" }),
    ...(options.keys ?? []).map(
      (k) =>
        new ApiKeyIssued({ org, key: k.key, name: `key ${k.key}`, prefix: k.prefix, hash: k.hash }),
    ),
  ),
  ...(options.repository === undefined
    ? []
    : [
        Story.given(
          Repository.ref(options.repository),
          new RepositoryClaimed({ project: slug, org }),
        ),
      ]),
];

/** The Api client a scope's requests go through. */
export type Api = typeof ConsoleApi.Client.Service;

/** The Api client of a scope's requests, unwrapped ("another client" of that scope). */
const apiOf = async (world: Story.World, scope = world.scope) =>
  // SAFETY: the story's host serves `ConsoleApi`, so a scope's raw client is its client.
  (await world.raw(scope)) as unknown as Api;

/** Asks the Api as the scope's client, outside any collection (as CI does). */
export const ask = <A, E>(
  label: string,
  call: (api: typeof ConsoleApi.Client.Service) => Effect.Effect<A, E>,
  check: (answer: A) => void,
  options: { readonly as?: string } = {},
) =>
  Story.step(`ask ${label}`, async (world) => {
    check(await Effect.runPromise(call(await apiOf(world, options.as))));
  });

/** Asks the Api as the scope's client and expects this typed failure. */
export const refused = <A, E extends { readonly _tag: string }>(
  label: string,
  call: (api: typeof ConsoleApi.Client.Service) => Effect.Effect<A, E>,
  tag: E["_tag"],
  options: { readonly as?: string } = {},
) =>
  Story.step(`refused ${label}`, async (world) => {
    const failed = await Effect.runPromise(Effect.flip(call(await apiOf(world, options.as))));
    if (failed._tag !== tag)
      throw new Story.Mismatch(`expected ${tag}`, [`observed ${JSON.stringify(failed)}`]);
  });

// ---------------------------------------------------------------- runs

/**
 * The commands CI sends, declared once: each names its organisation in its input, which is the
 * aggregate that decides it (quota, who may write, whether the run is open).
 */
export const ci = {
  open: HighAlch.command(OpenRun, { target: (input) => input.org }),
  declare: HighAlch.command(DeclareArtifacts, { target: (input) => input.org }),
  record: HighAlch.command(RecordResults, { target: (input) => input.org }),
  story: HighAlch.command(RecordStory, { target: (input) => input.org }),
  complete: HighAlch.command(CompleteRun, { target: (input) => input.org }),
};

/** A fuzz run of crm on `branch` (a pull request's when `pr` is set). */
export const runContext = (
  options: {
    readonly org?: OrganizationId;
    readonly project?: ProjectId;
    readonly branch?: string;
    readonly baseBranch?: string;
    readonly pr?: number | null;
    readonly kind?: Kind;
  } = {},
) => ({
  org: options.org ?? orgA,
  project: options.project ?? crm,
  commit: "abcdef0",
  branch: options.branch ?? "main",
  pr: options.pr ?? null,
  source: "ci",
  kind: options.kind ?? ("fuzz" as const),
  baseBranch: options.baseBranch ?? options.branch ?? "main",
  commitInfo: null,
  pull: null,
});

/** No test, case or trace counted. */
export const noCounts = {
  tests: { passed: 0, failed: 0, flaky: 0, skipped: 0 },
  cases: { ok: 0, overflow: 0, crash: 0, a11y: 0 },
  traces: { passed: 0, failed: 0 },
};

/** History: `org` admitted `run` and `RunIntake` created it (seeded, so no policy runs). */
export const openedRun = (run: RunId, options: Parameters<typeof runContext>[0] = {}) => {
  const { org, ...context } = runContext(options);
  return [
    Story.given(Organization.ref(org), new RunOpened({ run, period: periodStart, ...context })),
    Story.given(Run.ref(run), new RunCreated({ org, ...context })),
  ];
};

/**
 * Every upload `org` accepted for `run` either reached the run or was given back and recorded:
 * the run applied `applied` of them and the organisation dropped `dropped`, `accepted` in all.
 */
export const everyUploadAccounted = (
  org: OrganizationId,
  run: RunId,
  expected: { readonly applied: number; readonly dropped: number },
) =>
  Story.check(
    `every upload of ${run} reached it or was given back (${expected.applied} + ${expected.dropped})`,
    async (world) => {
      const [state, organization] = await inModel(world, ({ runs, organizations }) =>
        Effect.all([runs.get(run), organizations.get(org)]),
      );
      const applied = state._tag === "Run" ? state.applied : 0;
      const dropped = organization._tag === "Active" ? organization.droppedWrites : 0;
      if (applied !== expected.applied || dropped !== expected.dropped)
        throw new Story.Mismatch("uploads were lost", [
          `expected ${expected.applied} applied, ${expected.dropped} dropped`,
          `observed ${applied} applied, ${dropped} dropped`,
        ]);
    },
  );
