import * as HighAlch from "@lowalch/tanstack-db";
import { Catalog } from "./Billing/Catalog.query.ts";
import { CreateOrganization } from "./Organization/CreateOrganization.command.ts";
import { BindRepository } from "./Project/BindRepository.command.ts";
import { ClaimRepository, ReleaseRepository } from "./Project/ClaimRepository.command.ts";
import { CreateProject } from "./Project/CreateProject.command.ts";
import { IssueApiKey } from "./Project/IssueApiKey.command.ts";
import { RevokeApiKey } from "./Project/RevokeApiKey.command.ts";
import { ArtifactLinks } from "./Run/ArtifactLinks.query.ts";
import { CheckoutLink } from "./Organization/CheckoutLink.query.ts";
import { PortalLink } from "./Organization/PortalLink.query.ts";
import { ResultPartLinks } from "./Run/ResultPartLinks.query.ts";
import { Billing } from "./Organization/Billing.query.ts";
import { BillingRows } from "./Organization/Billing.rows.ts";
import { Me } from "./Organization/Me.query.ts";
import { MemberRows } from "./Organization/Member.rows.ts";
import { Members } from "./Organization/Members.query.ts";
import { OrganizationRows } from "./Organization/Organization.rows.ts";
import { OrganizationById } from "./Organization/OrganizationById.query.ts";
import { ApiKeyRows } from "./Project/ApiKey.rows.ts";
import { ApiKeys } from "./Project/ApiKeys.query.ts";
import { Commits } from "./Project/Commits.query.ts";
import { ProjectRows } from "./Project/Project.rows.ts";
import { Projects } from "./Project/Projects.query.ts";
import { Pulls } from "./Project/Pulls.query.ts";
import { CommitRows, PullRows } from "./Project/Source.rows.ts";
import { ArtifactRows } from "./Run/Artifact.rows.ts";
import { Artifacts } from "./Run/Artifacts.query.ts";
import { ResultParts } from "./Run/ResultParts.query.ts";
import { ResultRows } from "./Run/Result.rows.ts";
import { RunRows } from "./Run/Run.rows.ts";
import { RunById } from "./Run/RunById.query.ts";
import { Runs } from "./Run/Runs.query.ts";
import { Stories } from "./Story/Stories.query.ts";
import { StoryRows } from "./Story/Story.rows.ts";
import { SubjectRows } from "./Subject/Subject.rows.ts";
import { SubjectHistory } from "./Subject/SubjectHistory.query.ts";
import { SubjectResultRows } from "./Subject/SubjectResult.rows.ts";
import { Subjects } from "./Subject/Subjects.query.ts";

/**
 * The client side of every row: one TanStack DB collection declaration per `*Rows` entity,
 * with the queries that load its subsets. A browser's `HighAlch.make({ api: ConsoleApi, scope:
 * org })` follows `OrganizationChanges` of that organisation. Browser code only: it imports
 * `@lowalch/tanstack-db` (TanStack DB); the server never imports this module.
 *
 * A `where` / `one` rule places a row the feed delivers into the subsets it belongs to; a
 * query without one (the paged run list) reloads instead. Every command names its target in
 * its input; one with a row to edit edits it optimistically.
 */

export const me = HighAlch.query(Me);

export const catalog = HighAlch.query(Catalog);

/** Signed GET links to a run's artifacts (frames, attachments, traces). Not rows: no feed. */
export const artifactLinks = HighAlch.query(ArtifactLinks);

/** Signed GET links to a run's results objects; the browser fetches their items from storage. */
export const resultPartLinks = HighAlch.query(ResultPartLinks);

/** A checkout page for a plan or a top-up, and the billing portal: for owners, not rows. */
export const checkoutLink = HighAlch.query(CheckoutLink);

export const portalLink = HighAlch.query(PortalLink);

/** A repository has no row: claiming and releasing it addresses it from the input. */
export const claimRepository = HighAlch.command(ClaimRepository, {
  target: (input) => input.repository,
});

export const releaseRepository = HighAlch.command(ReleaseRepository, {
  target: (input) => input.repository,
});

export const organizations = HighAlch.collection(OrganizationRows, {
  queries: { get: HighAlch.read(OrganizationById).one((row, input) => row.org === input.org) },
  // the new organisation's rows arrive on its own feed, not the creating client's
  commands: { create: HighAlch.sends(CreateOrganization, { target: (input) => input.org }) },
});

export const members = HighAlch.collection(MemberRows, {
  queries: { list: HighAlch.read(Members).where((row, input) => row.org === input.org) },
});

export const billing = HighAlch.collection(BillingRows, {
  queries: { get: HighAlch.read(Billing).one((row, input) => row.org === input.org) },
});

export const projects = HighAlch.collection(ProjectRows, {
  queries: { list: HighAlch.read(Projects).where((row, input) => row.org === input.org) },
  commands: {
    create: HighAlch.sends(CreateProject, { target: (input) => input.slug }),
    bind: HighAlch.updates(BindRepository, {
      key: (input) => input.project,
      target: (input) => input.project,
    }),
  },
});

export const apiKeys = HighAlch.collection(ApiKeyRows, {
  queries: { list: HighAlch.read(ApiKeys).where((row, input) => row.project === input.project) },
  commands: {
    /** Issue the key `makeApiKey` made in the browser: only its id, prefix and hash are sent. */
    issue: HighAlch.sends(IssueApiKey, { target: (input) => input.project }),
    revoke: HighAlch.deletes(RevokeApiKey, { target: (input) => input.project }),
  },
});

export const runs = HighAlch.collection(RunRows, {
  queries: {
    list: Runs,
    get: HighAlch.read(RunById).one((row, input) => row.id === input.run),
  },
});

export const results = HighAlch.collection(ResultRows, {
  queries: { list: HighAlch.read(ResultParts).where((row, input) => row.run === input.run) },
});

export const artifacts = HighAlch.collection(ArtifactRows, {
  queries: { list: HighAlch.read(Artifacts).where((row, input) => row.run === input.run) },
});

export const subjects = HighAlch.collection(SubjectRows, {
  queries: {
    list: HighAlch.read(Subjects).where(
      (row, input) =>
        row.project === input.project && (input.kind === undefined || row.kind === input.kind),
    ),
  },
});

export const subjectHistory = HighAlch.collection(SubjectResultRows, {
  queries: {
    list: HighAlch.read(SubjectHistory).where(
      (row, input) =>
        row.project === input.project &&
        row.subject === input.subject &&
        (input.branch === undefined || row.branch === input.branch),
    ),
  },
});

export const commits = HighAlch.collection(CommitRows, {
  queries: { list: HighAlch.read(Commits).where((row, input) => row.project === input.project) },
});

export const pulls = HighAlch.collection(PullRows, {
  queries: { list: HighAlch.read(Pulls).where((row, input) => row.project === input.project) },
});

export const stories = HighAlch.collection(StoryRows, {
  queries: { list: HighAlch.read(Stories).where((row, input) => row.run === input.run) },
});
