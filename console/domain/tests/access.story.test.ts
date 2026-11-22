import { describe, expect, it } from "vite-plus/test";
import { Db } from "@highalch/story/tanstack-db";
import { CredentialMissing } from "../src/Caller.middleware.ts";
import { apiKeys, billing, me, members, projects, runs } from "../src/Console.collections.ts";
import { NotAllowed } from "../src/NotAllowed.rejection.ts";
import {
  acmeCrm,
  alice,
  apiKey,
  ask,
  bearer,
  bob,
  console,
  crm,
  existingProject,
  orgA,
  orgB,
  other,
  paidOrganization,
  refused,
  run1,
  run2,
  session,
  signIn,
  Story,
  billingProject,
  type Api,
} from "./support.ts";

const crmKey = apiKey(crm, "k1");
const otherKey = apiKey(other, "k2");

const history = [
  paidOrganization(orgA, alice),
  paidOrganization(orgB, bob),
  ...existingProject(crm, orgA, { repository: acmeCrm, keys: [crmKey] }),
  ...existingProject(other, orgA, { keys: [otherKey] }),
  ...existingProject(billingProject, orgB),
];

const created = (run: typeof run1, pr: number | null) => ({
  org: orgA,
  run,
  project: crm,
  commit: "1234567",
  branch: "spoofed",
  pr,
  source: "github-actions",
  kind: "fuzz" as const,
  baseBranch: "main",
  commitInfo: null,
  pull: null,
});

describe("Organisations are isolated", () => {
  it("a member sees their organisation's rows and nothing of another's", () =>
    console([
      [orgA, session(alice)],
      [orgB, session(alice)],
    ])(
      ...history,
      Db.then(projects.list({ org: orgA }), [{ slug: crm }, { slug: other }]),
      Story.as(
        orgB,
        Db.open(projects.list({ org: orgB })),
        Db.then(projects.list({ org: orgB }), { state: new NotAllowed() }),
        Db.open(members.list({ org: orgB })),
        Db.then(members.list({ org: orgB }), { state: new NotAllowed() }),
        Db.open(billing.get({ org: orgB })),
        Db.then(billing.get({ org: orgB }), { state: new NotAllowed() }),
      ),
      refused("org-b's runs", (api) => api.Runs({ org: orgB }), "NotAllowed"),
      refused(
        "org-b's project commits",
        (api) => api.Commits({ project: billingProject }),
        "NotAllowed",
      ),
      refused("org-b's run", (api) => api.Stories({ run: run2 }), "RunMissing"),
    ));

  it("a project key reads its own project only, through queries, and never follows the feed", () =>
    console([[orgA, bearer(crmKey.token)]])(
      ...history,
      ask(
        "its projects",
        (api) => api.Projects({ org: orgA }),
        (rows) => expect(rows.map((p) => p.slug)).toEqual([crm]),
      ),
      ask(
        "its runs",
        (api) => api.Runs({ org: orgA }, { take: 10 }),
        (page) => expect(page.entries).toEqual([]),
      ),
      refused(
        "another project's runs",
        (api) => api.Runs({ org: orgA, project: other }),
        "NotAllowed",
      ),
      refused("the members", (api) => api.Members({ org: orgA }), "NotAllowed"),
      refused("the billing", (api) => api.Billing({ org: orgA }), "NotAllowed"),
      refused("the keys", (api) => api.ApiKeys({ project: crm }), "NotAllowed"),
      refused(
        "another organisation's projects",
        (api) => api.Projects({ org: orgB }),
        "NotAllowed",
      ),
      refused("who it is", (api) => api.Me({}), "NotAllowed"),
      Db.open(runs.list({ org: orgA, project: crm })),
      Db.then(runs.list({ org: orgA, project: crm }), { state: new NotAllowed() }),
    ));
});

describe("Credentials", () => {
  it("tell CI which organisation and project it uploads to, and its verified commit", () =>
    console([
      ["ci", bearer(crmKey.token)],
      ["gh", bearer("gh-pr7")],
      [orgA, session(alice)],
    ])(
      ...history,
      ask(
        "as the key",
        (api) => api.Credential({}),
        (answer) => expect(answer).toEqual({ org: orgA, project: crm, context: null }),
        { as: "ci" },
      ),
      ask(
        "as the OIDC token",
        (api) => api.Credential({}),
        (answer) =>
          expect(answer).toEqual({
            org: orgA,
            project: crm,
            context: { commit: "f00d000", branch: "feature", pr: 7, baseBranch: "release" },
          }),
        { as: "gh" },
      ),
      refused("as a browser session", (api) => api.Credential({}), "NotAllowed"),
    ));

  it("names why a request is refused: none, an unknown session, a bad or revoked key", () =>
    console([[orgA, {}]])(
      ...history,
      Db.open(me({})),
      Db.then(me({}), { state: new CredentialMissing() }),
      signIn(orgA, { cookie: "highalch_session=s-mallory" }),
      refused("an unknown session", (api) => api.Me({}), "SessionInvalid"),
      signIn(orgA, { cookie: "other_session=s-alice" }),
      refused("another cookie", (api) => api.Me({}), "CredentialMissing"),
      signIn(orgA, bearer(`${crmKey.token}x`)),
      refused("a wrong secret", (api) => api.Projects({ org: orgA }), "ApiKeyInvalid"),
      signIn(orgA, bearer("highalch_live_garbage")),
      refused("a malformed key", (api) => api.Projects({ org: orgA }), "ApiKeyInvalid"),
      signIn(orgA, bearer(crmKey.token)),
      ask(
        "the key",
        (api) => api.Projects({ org: orgA }),
        (rows) => expect(rows).toHaveLength(1),
      ),
      signIn(orgA, session(alice)),
      Db.when(apiKeys.revoke, { project: crm, key: crmKey.key }),
      Db.settled("Committed"),
      signIn(orgA, bearer(crmKey.token)),
      refused("a revoked key", (api) => api.Projects({ org: orgA }), "ApiKeyInvalid"),
      signIn(orgA, session(bob)),
      Db.reload(me({})),
      Db.then(me({}), ([row]) => row?.user.id === bob.id && row.organizations.length === 1),
    ));

  it("takes a GitHub OIDC upload's project and commit from the verified token", () =>
    console([[orgA, bearer("gh-pr7")]])(
      ...history,
      Story.remote("create a run with spoofed context", (api: Api) =>
        api.OpenRun(orgA, created(run1, null)),
      ),
      signIn(orgA, session(alice)),
      Db.then(runs.get({ run: run1 }), [
        { commit: "f00d000", branch: "feature", pr: 7, baseBranch: "release" },
      ]),
      signIn(orgA, bearer("gh-main")),
      Story.remote("create a run on main", (api: Api) => api.OpenRun(orgA, created(run2, 3))),
      signIn(orgA, session(alice)),
      Db.then(runs.get({ run: run2 }), [
        { commit: "c0ffee0", branch: "main", pr: null, baseBranch: "main" },
      ]),
      signIn(orgA, bearer("gh-elsewhere")),
      refused("an unbound repository", (api) => api.Projects({ org: orgA }), "RepositoryNotBound"),
      signIn(orgA, bearer("gh-forged")),
      refused("an invalid token", (api) => api.Projects({ org: orgA }), "OidcTokenInvalid"),
    ));
});
