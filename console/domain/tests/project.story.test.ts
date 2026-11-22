import * as Digest from "effect/crypto/Digest";
import { Db } from "@highalch/story/tanstack-db";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";
import { makeApiKey } from "../src/Credentials.ts";
import {
  apiKeys,
  claimRepository,
  commits,
  projects,
  pulls,
  releaseRepository,
} from "../src/Console.collections.ts";
import { NotAllowed } from "../src/NotAllowed.rejection.ts";
import { ReleaseRepository, RepositoryTaken } from "../src/Project/ClaimRepository.command.ts";
import { ProjectExists } from "../src/Project/CreateProject.command.ts";
import { TooManyApiKeys } from "../src/Project/IssueApiKey.command.ts";
import { ProjectMissing } from "../src/Project/ProjectMissing.rejection.ts";
import { ApiKeyMissing } from "../src/Project/RevokeApiKey.command.ts";
import { RunCreated } from "../src/Run/CreateRun.command.ts";
import { Run } from "../src/Run/Run.aggregate.ts";
import { RunId } from "../src/Run/Run.id.ts";
import {
  acmeCrm,
  alice,
  apiKey,
  ask,
  bearer,
  asServer,
  bob,
  console,
  crm,
  existingProject,
  inModel,
  orgA,
  orgB,
  other,
  paidOrganization,
  session,
  Story,
} from "./support.ts";

const people = [
  [orgA, session(alice)],
  [orgB, session(bob)],
] as const;

const organizations = [paidOrganization(orgA, alice), paidOrganization(orgB, bob)];

const keyInput = (n: number, project = crm) => {
  const key = apiKey(project, `k${n}`);
  return { project, key: key.key, name: `key ${n}`, prefix: key.prefix, hash: key.hash };
};

describe("Project", () => {
  it("is created by a member of the organisation only, with a unique slug", () =>
    console(people).with({ rules: Db.rules })(
      ...organizations,
      Story.as(
        orgB,
        Db.when(projects.create, {
          slug: crm,
          org: orgA,
          repository: null,
          defaultBranch: "main",
        }),
        Db.rejected(new NotAllowed()),
      ),
      Db.when(projects.create, {
        slug: crm,
        org: orgA,
        repository: acmeCrm,
        defaultBranch: "main",
      }),
      Db.settled("Committed"),
      Db.then(projects.list({ org: orgA }), [
        { slug: crm, org: orgA, repository: acmeCrm, defaultBranch: "main" },
      ]),
      Story.as(
        orgB,
        Db.when(projects.create, {
          slug: crm,
          org: orgB,
          repository: null,
          defaultBranch: "main",
        }),
        Db.rejected(new ProjectExists()),
        Db.then(projects.list({ org: orgB }), []),
      ),
    ));

  it("issues keys to members, up to a cap, shows them without secrets, and revokes them", () =>
    console(people).with({ rules: Db.rules })(
      ...organizations,
      ...existingProject(crm, orgA),
      Story.as(orgB, Db.when(apiKeys.issue, keyInput(0)), Db.rejected(new NotAllowed())),
      ...Array.from({ length: 20 }, (_, n) => [
        Db.when(apiKeys.issue, keyInput(n)),
        Db.settled("Committed"),
      ]).flat(),
      Db.when(apiKeys.issue, keyInput(20)),
      Db.rejected(new TooManyApiKeys({ max: 20 })),
      Db.then(
        apiKeys.list({ project: crm }),
        (rows) =>
          rows.length === 20 &&
          rows.every((row) => !("hash" in row) && row.prefix.startsWith("highalch_live_")),
      ),
      Db.when(apiKeys.revoke, { project: crm, key: "k3" }),
      Db.settled("Committed"),
      Db.then(
        apiKeys.list({ project: crm }),
        (rows) => rows.length === 19 && !rows.some((row) => row.key === "k3"),
      ),
      Db.when(apiKeys.revoke, { project: crm, key: "k3" }),
      Db.rejected(new ApiKeyMissing()),
      Db.when(apiKeys.issue, keyInput(1, other)),
      Db.rejected(new ProjectMissing()),
    ));
});

describe("API keys made in the browser", () => {
  it("authenticate CI with a secret the server never saw", async () => {
    const made = await Effect.runPromise(
      makeApiKey(crm, "ci").pipe(
        Effect.provide(Layer.mergeAll(SecureRandom.layerWebCrypto, Digest.layerWebCrypto)),
      ),
    );
    const token = Redacted.value(made.token);
    expect(token.startsWith("highalch_live_")).toBe(true);
    expect(JSON.stringify(made.input)).not.toContain(token.split(".").at(-1));
    await console([...people, ["ci", bearer(token)]])(
      ...organizations,
      ...existingProject(crm, orgA),
      Db.when(apiKeys.issue, made.input),
      Db.settled("Committed"),
      Db.then(apiKeys.list({ project: crm }), [{ key: made.input.key, prefix: made.input.prefix }]),
      ask(
        "as CI, with the key",
        (api) => api.Projects({ org: orgA }),
        (rows) => expect(rows.map((row) => row.slug)).toEqual([crm]),
        { as: "ci" },
      ),
    );
  });
});

describe("Repository", () => {
  it("binds to one project; another organisation cannot take it", () =>
    console(people)(
      ...organizations,
      Db.when(claimRepository, { repository: acmeCrm, project: crm, org: orgA }),
      Db.settled("Committed"),
      Db.when(claimRepository, { repository: acmeCrm, project: crm, org: orgA }),
      Db.settled("Committed"),
      Story.as(
        orgB,
        Db.when(claimRepository, { repository: acmeCrm, project: other, org: orgB }),
        Db.rejected(new RepositoryTaken()),
        Db.when(claimRepository, { repository: acmeCrm, project: other, org: orgA }),
        Db.rejected(new NotAllowed()),
        Db.when(releaseRepository, { repository: acmeCrm, project: crm }),
        Db.rejected(new NotAllowed()),
      ),
      asServer("releases the repository", ({ repositories }) =>
        repositories.send(acmeCrm, new ReleaseRepository({ repository: acmeCrm, project: crm })),
      ),
      Story.check("the repository is free", async (world) => {
        const state = await inModel(world, ({ repositories }) => repositories.get(acmeCrm));
        expect(state).toEqual({ _tag: "Free" });
      }),
    ));

  it("rebinds a project for members only", () =>
    console(people)(
      ...organizations,
      ...existingProject(crm, orgA),
      Story.as(
        orgB,
        Db.when(projects.bind, { project: crm, repository: acmeCrm }),
        Db.rejected(new NotAllowed()),
      ),
      Db.when(projects.bind, { project: crm, repository: acmeCrm }),
      Db.settled("Committed"),
      Db.then(projects.list({ org: orgA }), [{ slug: crm, repository: acmeCrm }]),
      Db.when(projects.bind, { project: crm, repository: null }),
      Db.settled("Committed"),
      Db.then(projects.list({ org: orgA }), [{ slug: crm, repository: null }]),
    ));
});

describe("Source history", () => {
  const person = { login: "sam", name: "Sam" };
  const created = (id: string, commit: string, message: string, at: string, pr: number | null) =>
    Story.given(
      Run.ref(RunId.make(id)),
      new RunCreated({
        org: orgA,
        project: crm,
        commit,
        branch: pr === null ? "main" : "feature",
        pr,
        source: "github-actions",
        kind: "fuzz",
        baseBranch: "main",
        commitInfo: { message, author: person, committedAt: at },
        pull:
          pr === null
            ? null
            : {
                title: "Add cards",
                author: person,
                base: "main",
                baseSha: "0000000",
                state: "open",
              },
      }),
    );

  it("collects a project's commits and pull requests from its runs, live", () =>
    console(people)(
      ...organizations,
      ...existingProject(crm, orgA),
      created("r1", "aaaaaaa", "first", "2026-01-01T00:00:00Z", null),
      created("r2", "bbbbbbb", "second", "2026-01-02T00:00:00Z", 4),
      Db.then(commits.list({ project: crm }), [{ sha: "aaaaaaa" }, { sha: "bbbbbbb" }]),
      Db.then(pulls.list({ project: crm }), [
        { number: 4, title: "Add cards", branch: "feature", commits: ["bbbbbbb"] },
      ]),
      created("r3", "ccccccc", "third", "2026-01-03T00:00:00Z", 4),
      created("r4", "ccccccc", "third", "2026-01-03T00:00:00Z", 4),
      Db.then(
        commits.list({ project: crm }),
        (rows) =>
          rows
            .map((row) => row.message)
            .sort()
            .join() === "first,second,third",
      ),
      Db.then(pulls.list({ project: crm }), [{ number: 4, commits: ["bbbbbbb", "ccccccc"] }]),
      Story.as(
        orgB,
        Db.open(commits.list({ project: crm })),
        Db.then(commits.list({ project: crm }), { state: new NotAllowed() }),
      ),
    ));
});
