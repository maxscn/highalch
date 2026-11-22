import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { uploadStories } from "@highalch/console-client";
import { ConsoleApi } from "@highalch/console-domain/Console.api";
import { makeApiKey } from "@highalch/console-domain/Credentials";
import { OrganizationId } from "@highalch/console-domain/Organization/Organization.id";
import { ProjectId, RepositoryId } from "@highalch/console-domain/Project/Project.id";
import { RunId } from "@highalch/console-domain/Run/Run.id";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
  apiWith,
  appOrigin,
  artifactOrigin,
  deliverStripeEvent,
  signUp,
  start,
  type Running,
} from "./local.ts";

/**
 * The Worker on the local stage, end to end: a user signs up through Better Auth, creates an
 * organisation, a project and an API key through ConsoleApi, a signed Stripe event pays for the
 * plan, then CI uploads a real Playwright run and a folder of story reports with
 * `@highalch/console-client`, and the owner reads both back, over HTTP, over a WebSocket
 * (the session cookie), and through signed links on the artifact origin.
 */

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect));

/** Retries a read until it answers what `ok` accepts (projections are eventually consistent). */
const eventually = <A, E>(read: Effect.Effect<A, E>, ok: (a: A) => boolean) =>
  read.pipe(
    Effect.filterOrFail(ok),
    Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 150 }),
  );

const id = randomBytes(4).toString("hex");
const org = OrganizationId.make(`org-${id}`);
const project = ProjectId.make(`proj-${id}`);
const repository = RepositoryId.make(`acme/repo-${id}`);

let worker: Running;
let owner: Awaited<ReturnType<typeof signUp>>;
let apiKey: string;

beforeAll(async () => {
  worker = await start();
  owner = await signUp();
}, 180_000);

afterAll(() => worker?.stop());

const asOwner = () => apiWith({ cookie: owner.cookie });

describe("the Worker on the local stage", () => {
  it("lets a signed-up owner create an organisation, a project and an API key", async () => {
    await run(
      Effect.gen(function* () {
        const api = yield* asOwner();
        yield* api.CreateOrganization(org, {
          org,
          name: "Acme",
          owner: owner.user as never,
          ownerEmail: owner.email,
          ownerName: "Owner",
        });
        yield* eventually(api.Me({}), (me) => me.organizations.some((o) => o.org === org));
        yield* api.CreateProject(project, {
          slug: project,
          org,
          repository,
          defaultBranch: "main",
        });
        yield* api.ClaimRepository(repository, { repository, project, org });
        const key = yield* makeApiKey(project, "ci").pipe(
          Effect.provide(Layer.mergeAll(Digest.layerWebCrypto, SecureRandom.layerWebCrypto)),
        );
        yield* api.IssueApiKey(project, key.input);
        apiKey = Redacted.value(key.token);
      }),
    );
    expect(apiKey.startsWith("highalch_live_")).toBe(true);
  }, 60_000);

  it("answers a checkout page and activates the plan from a signed Stripe event", async () => {
    const checkout = await run(
      Effect.gen(function* () {
        const api = yield* asOwner();
        // the BillingAccount policy links the organisation's (local) customer
        return yield* api
          .CheckoutLink({
            org,
            purchase: { plan: "starter" },
            successUrl: `${appOrigin}/billing?paid`,
            cancelUrl: `${appOrigin}/billing`,
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "BillingAccountPending",
              schedule: Schedule.spaced("200 millis"),
              times: 50,
            }),
          );
      }),
    );
    expect(checkout.url.startsWith(`${appOrigin}/local/checkout?`)).toBe(true);
    const foreign = await run(
      Effect.flatMap(asOwner(), (api) =>
        Effect.flip(
          api.CheckoutLink({
            org,
            purchase: { plan: "starter" },
            successUrl: "https://evil.example/paid",
            cancelUrl: `${appOrigin}/billing`,
          }),
        ),
      ),
    );
    expect(foreign).toMatchObject({ _tag: "ReturnUrlRefused", url: "https://evil.example/paid" });

    const now = Math.floor(Date.now() / 1000);
    const delivered = await deliverStripeEvent("invoice.paid", {
      id: `in_${id}`,
      object: "invoice",
      status: "paid",
      currency: "eur",
      amount_paid: 5_900,
      customer: `cus_local_${org}`,
      parent: { subscription_details: { metadata: { org, purchase: "starter" } } },
      lines: { data: [{ period: { start: now - 60, end: now + 30 * 86_400 } }] },
    });
    expect(delivered.status).toBe(200);
    const forged = await fetch(`${appOrigin}/api/billing/stripe-webhook`, {
      method: "POST",
      headers: { "stripe-signature": "t=1,v1=00" },
      body: "{}",
    });
    expect(forged.status).toBe(401);
    const billing = await run(
      Effect.flatMap(asOwner(), (api) =>
        eventually(api.Billing({ org }), (row) => row?.plan === "starter"),
      ),
    );
    expect(billing?.plan).toBe("starter");
  }, 60_000);

  it("takes a real Playwright run from the reporter", async () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const e2e = join(here, "../../playwright/tests/e2e");
    const snapshots = await mkdtemp(join(tmpdir(), "highalch-worker-snap-"));
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
        "1f15c4890000000d4944415478da63f8cfc0f01f0005000201a0b5d3a30000000049454e44ae426082",
      "hex",
    );
    await writeFile(join(snapshots, "swatch.png"), png);
    await writeFile(join(snapshots, "blue.png"), png);
    const cli = createRequire(join(e2e, "playwright.config.ts")).resolve("@playwright/test/cli");
    const output = await new Promise<string>((resolve) =>
      execFile(
        process.execPath,
        [cli, "test", "-c", join(e2e, "playwright.config.ts")],
        {
          cwd: join(e2e, "../.."),
          timeout: 120_000,
          env: {
            ...process.env,
            CI: "",
            HIGHALCH_URL: appOrigin,
            HIGHALCH_API_KEY: apiKey,
            E2E_SNAPSHOTS: snapshots,
            E2E_OUTPUT: join(snapshots, "out"),
          },
        },
        (_error, stdout, stderr) => resolve(stdout + stderr),
      ),
    );
    const runs = await run(
      Effect.flatMap(asOwner(), (api) =>
        eventually(api.Runs({ org, project }), (page) => page.entries.length > 0),
      ),
    );
    const uploaded = runs.entries[0];
    expect(uploaded, output).toMatchObject({ kind: "playwright", pr: 7, branch: "main" });
    const detail = await run(
      Effect.flatMap(asOwner(), (api) =>
        eventually(
          api.RunById({ run: RunId.make(uploaded?.id ?? "") }),
          (row) => row?.status === "completed",
        ),
      ),
    );
    expect(detail?.summary.tests).toMatchObject({ passed: 1, failed: 2, flaky: 1, skipped: 1 });
  }, 180_000);

  it("takes a folder of story reports and serves its frames on the artifact origin", async () => {
    const folder = await mkdtemp(join(tmpdir(), "highalch-worker-stories-"));
    await mkdir(join(folder, "rename-settles"));
    const frame = Buffer.from("<svg onload=alert(1)>", "utf8");
    await writeFile(join(folder, "rename-settles", "01-render.png"), frame);
    await writeFile(
      join(folder, "rename-settles", "story.json"),
      JSON.stringify({
        format: "highalch.story/1",
        name: "rename settles",
        slug: "rename-settles",
        status: "passed",
        durationMs: 12,
        host: "memory",
        scope: "acc-1",
        clock: "manual",
        rules: [],
        steps: [
          {
            n: 1,
            kind: "Render",
            label: "the list",
            status: "passed",
            frame: { file: "01-render.png", status: "created", sha256: "ab".repeat(32) },
            rules: [],
          },
        ],
        histories: [],
        feeds: [],
      }),
    );
    const uploaded = await Effect.runPromise(
      uploadStories({
        folder,
        url: appOrigin,
        apiKey,
        commit: "c0ffee0",
        branch: "main",
        pr: null,
        env: {},
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    const runId = RunId.make(uploaded.outcome.runId);
    const storyRun = await run(
      Effect.flatMap(asOwner(), (api) =>
        eventually(api.RunById({ run: runId }), (row) => row?.status === "completed"),
      ),
    );
    expect(storyRun).toMatchObject({
      kind: "stories",
      outcome: "passed",
      summary: { stories: { passed: 1, failed: 0, frames: { created: 1 } } },
    });
    const links = await run(
      Effect.gen(function* () {
        const api = yield* asOwner();
        const stories = yield* eventually(api.Stories({ run: runId }), (page) =>
          JSON.stringify(page).includes("rename-settles"),
        );
        const artifacts = yield* api.Artifacts({ run: runId });
        const ids = artifacts.entries.map((artifact) => artifact.id);
        expect(stories.entries[0]).toMatchObject({
          slug: "rename-settles",
          steps: { passed: 1, failed: 0, notRun: 0 },
          kinds: ["Render"],
        });
        // bodies are linked once verification found them intact, when their upload links expired
        return yield* api.ArtifactLinks({ run: runId, ids }).pipe(
          Effect.filterOrFail((links) => links.every((entry) => entry.link !== null)),
          Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 60 }),
        );
      }),
    );
    const urls = links.map((entry) => entry.link?.url ?? "");
    expect(urls.every((url) => url.startsWith(`${artifactOrigin}/o/`))).toBe(true);
    const responses = await Promise.all(urls.map((url) => fetch(url)));
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toContain("sandbox");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
    // the same link on the app origin, or with another type, is refused
    const forged = new URL(urls[0] ?? "");
    forged.searchParams.set("m", "text/html");
    expect((await fetch(forged)).status).toBe(403);
    expect((await fetch(urls[0]?.replace(artifactOrigin, appOrigin) ?? "")).status).toBe(404);
  }, 180_000);

  it("authenticates a live read over WebSocket with the session cookie", async () => {
    /** Node's WebSocket (undici) sends headers on the upgrade, as a browser sends its cookies. */
    const withCookie = (cookie: string | undefined) =>
      Layer.succeed(
        Socket.WebSocketConstructor,
        (url: string, options?: Socket.WebSocketConstructorOptions) =>
          new WebSocket(url, {
            protocols:
              typeof options === "object" && !Array.isArray(options) ? options.protocols : options,
            headers: cookie === undefined ? {} : { cookie },
          } as unknown as string),
      );
    const feed = (cookie: string | undefined) =>
      Effect.gen(function* () {
        const api = yield* ConsoleApiWebSocket;
        return yield* api.OrganizationChanges.events(org).pipe(Stream.take(1), Stream.runCollect);
      }).pipe(Effect.provide(withCookie(cookie)));
    const entries = await run(feed(owner.cookie).pipe(Effect.timeout("20 seconds")));
    expect(entries.length).toBe(1);
    const refused = await run(Effect.flip(feed(undefined).pipe(Effect.timeout("20 seconds"))));
    expect(refused._tag).toBe("CredentialMissing");
  }, 60_000);
});

/** ConsoleApi as a browser reaches it: calls over HTTP, live reads over WebSocket. */
const ConsoleApiWebSocket = ConsoleApi.clientWebSocket(`${appOrigin}/api/console`).pipe(
  Effect.provide(FetchHttpClient.layer),
);
