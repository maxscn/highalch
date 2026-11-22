import { describe, it } from "vite-plus/test";
import { Db } from "@highalch/story/tanstack-db";
import { catalog, me, members, organizations, billing } from "../src/Console.collections.ts";
import { NotAllowed } from "../src/NotAllowed.rejection.ts";
import { OrganizationExists } from "../src/Organization/CreateOrganization.command.ts";
import { alice, bob, console, orgA, orgB, refused, session, signIn } from "./support.ts";

const createOrganization = organizations.create;

const owner = (user: typeof alice) => ({
  org: orgA,
  name: "Acme",
  owner: user.id,
  ownerEmail: user.email,
  ownerName: user.name,
});

describe("Organization", () => {
  it("is created by a signed-in user, who owns it and sees it everywhere", () =>
    console().with({ rules: Db.rules })(
      Db.then(me({}), [{ user: alice, organizations: [] }]),
      Db.when(createOrganization, owner(alice)),
      Db.settled("Committed"),
      Db.then(organizations.get({ org: orgA }), [{ org: orgA, name: "Acme", owner: alice.id }]),
      Db.then(members.list({ org: orgA }), [
        { user: alice.id, role: "owner", email: "alice@example.com", name: "Alice" },
      ]),
      Db.then(billing.get({ org: orgA }), [
        {
          plan: null,
          periodEnd: null,
          limits: null,
          usage: {
            storedBytes: 0,
            uploadedBytes: 0,
            artifacts: 0,
            resultRows: 0,
            runs: 0,
            activeRuns: 0,
          },
        },
      ]),
      Db.reload(me({})),
      Db.then(
        me({}),
        ([row]) =>
          row?.organizations.map((o) => `${o.org}:${o.name}:${o.role}`).join() ===
          "org-a:Acme:owner",
      ),
    ));

  it("is owned by whoever creates it, never by someone else, and only once", () =>
    console([[orgA, session(bob)]])(
      Db.when(createOrganization, owner(alice)),
      Db.rejected(new NotAllowed()),
      Db.when(createOrganization, owner(bob)),
      Db.settled("Committed"),
      signIn(orgA, session(alice)),
      Db.when(createOrganization, owner(alice)),
      Db.rejected(new OrganizationExists()),
      refused(
        "a command sent to another organisation than its input names",
        (api) => api.CreateOrganization(orgB, owner(alice)),
        "TargetMismatch",
      ),
    ));

  it("lists the plans for sale to anyone", () =>
    console([])(
      Db.then(
        catalog({}),
        ([row]) => row?.plans.map((plan) => plan.id).join() === "starter,team,business",
      ),
    ));
});
