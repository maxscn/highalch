import * as Domain from "@alchemy.run/domain";
import * as Layer from "effect/Layer";
import { Catalog, CatalogLive } from "./Billing/Catalog.query.ts";
import { Blob } from "./Blob/Blob.aggregate.ts";
import { Billing, BillingLive } from "./Organization/Billing.query.ts";
import {
  CustomerOrganization,
  CustomerOrganizationLive,
} from "./Organization/CustomerOrganization.view.ts";
import { Me, MeLive } from "./Organization/Me.query.ts";
import { BillingAccount, BillingAccountLive } from "./Organization/BillingAccount.policy.ts";
import { CheckoutLink, CheckoutLinkLive } from "./Organization/CheckoutLink.query.ts";
import { PortalLink, PortalLinkLive } from "./Organization/PortalLink.query.ts";
import { Credential, CredentialLive } from "./Credential.query.ts";
import { Members, MembersLive } from "./Organization/Members.query.ts";
import { Organization } from "./Organization/Organization.aggregate.ts";
import { OrganizationById, OrganizationByIdLive } from "./Organization/OrganizationById.query.ts";
import { OrganizationDirectory } from "./Organization/OrganizationDirectory.stream.ts";
import {
  OrganizationDirectoryIndex,
  OrganizationDirectoryIndexLive,
} from "./Organization/OrganizationDirectoryIndex.projection.ts";
import { OrganizationOverview } from "./Organization/OrganizationOverview.view.ts";
import { RetentionPurge, RetentionPurgeLive } from "./Organization/RetentionPurge.policy.ts";
import {
  RetentionSchedule,
  RetentionScheduleLive,
} from "./Organization/RetentionSchedule.policy.ts";
import { UserOrganizations } from "./Organization/UserOrganizations.view.ts";
import { OrganizationChangesWriter } from "./OrganizationChanges.projection.ts";
import { OrganizationChanges, OrganizationChangesLive } from "./OrganizationChanges.stream.ts";
import { ApiKeys, ApiKeysLive } from "./Project/ApiKeys.query.ts";
import { Commits, CommitsLive } from "./Project/Commits.query.ts";
import { OrganizationProjects } from "./Project/OrganizationProjects.view.ts";
import { Project } from "./Project/Project.aggregate.ts";
import { Projects, ProjectsLive } from "./Project/Projects.query.ts";
import { Pulls, PullsLive } from "./Project/Pulls.query.ts";
import { Repository } from "./Project/Repository.aggregate.ts";
import { SourceHistory } from "./Project/SourceHistory.view.ts";
import { Artifacts, ArtifactsLive } from "./Run/Artifacts.query.ts";
import {
  OrganizationRunIndex,
  OrganizationRunIndexLive,
} from "./Run/OrganizationRunIndex.projection.ts";
import { OrganizationRuns } from "./Run/OrganizationRuns.stream.ts";
import { ResultParts, ResultPartsLive } from "./Run/ResultParts.query.ts";
import { Run } from "./Run/Run.aggregate.ts";
import { RunArtifacts } from "./Run/RunArtifacts.stream.ts";
import { RunById, RunByIdLive } from "./Run/RunById.query.ts";
import { RunDetail } from "./Run/RunDetail.view.ts";
import { RunIndex, RunIndexLive } from "./Run/RunIndex.projection.ts";
import { RunLifecycle, RunLifecycleLive } from "./Run/RunLifecycle.policy.ts";
import { RunIntake, RunIntakeLive } from "./Run/RunIntake.policy.ts";
import { UploadLinks, UploadLinksLive } from "./Run/UploadLinks.query.ts";
import { ArtifactLinks, ArtifactLinksLive } from "./Run/ArtifactLinks.query.ts";
import { ResultPartLinks, ResultPartLinksLive } from "./Run/ResultPartLinks.query.ts";
import { RunResults } from "./Run/RunResults.stream.ts";
import { Runs, RunsLive } from "./Run/Runs.query.ts";
import { SnapshotComparison, SnapshotComparisonLive } from "./Run/SnapshotComparison.policy.ts";
import { UploadDeadlines, UploadDeadlinesLive } from "./Run/UploadDeadlines.policy.ts";
import { UploadVerification, UploadVerificationLive } from "./Run/UploadVerification.policy.ts";
import { RunStories } from "./Story/RunStories.stream.ts";
import { Stories, StoriesLive } from "./Story/Stories.query.ts";
import { StoryIndex, StoryIndexLive } from "./Story/StoryIndex.projection.ts";
import { ProjectSubjects } from "./Subject/ProjectSubjects.view.ts";
import { SubjectHistory, SubjectHistoryLive } from "./Subject/SubjectHistory.query.ts";
import { SubjectIndex, SubjectIndexLive } from "./Subject/SubjectIndex.projection.ts";
import { SubjectResults } from "./Subject/SubjectResults.stream.ts";
import { Subjects, SubjectsLive } from "./Subject/Subjects.query.ts";

/**
 * HighAlch Console: organisations and their quota, projects and keys, runs and their results,
 * story reports. Clients read rows on `OrganizationChanges` through the queries; the views
 * and streams beside it are internal stores and row sources.
 */
export class Console extends Domain.Model("Console", {
  aggregates: [Organization, Project, Repository, Run, Blob],
  views: [
    OrganizationOverview,
    UserOrganizations,
    OrganizationProjects,
    RunDetail,
    ProjectSubjects,
    SourceHistory,
    CustomerOrganization,
  ],
  streams: [
    OrganizationChanges,
    RunArtifacts,
    RunResults,
    OrganizationRuns,
    OrganizationDirectory,
    SubjectResults,
    RunStories,
  ],
  projections: [
    OrganizationChangesWriter,
    RunIndex,
    OrganizationRunIndex,
    OrganizationDirectoryIndex,
    SubjectIndex,
    StoryIndex,
  ],
  policies: [
    BillingAccount,
    RunIntake,
    RunLifecycle,
    UploadDeadlines,
    UploadVerification,
    SnapshotComparison,
    RetentionSchedule,
    RetentionPurge,
  ],
  queries: [
    Me,
    Catalog,
    OrganizationById,
    Members,
    Billing,
    Projects,
    ApiKeys,
    Commits,
    Pulls,
    Runs,
    RunById,
    ResultParts,
    Artifacts,
    Subjects,
    SubjectHistory,
    Stories,
    UploadLinks,
    ArtifactLinks,
    ResultPartLinks,
    Credential,
    CheckoutLink,
    PortalLink,
  ],
}) {}

/**
 * Every query, guard, projection and policy implementation, as one Layer. Needs `Storage`,
 * `Payments` and `AppOrigin`.
 */
export const ConsoleHandlers = Layer.mergeAll(
  OrganizationChangesWriter.layer,
  OrganizationChangesLive,
  CustomerOrganizationLive,
  RunIndexLive,
  OrganizationRunIndexLive,
  OrganizationDirectoryIndexLive,
  SubjectIndexLive,
  StoryIndexLive,
  RunIntakeLive,
  RunLifecycleLive,
  UploadDeadlinesLive,
  UploadVerificationLive,
  SnapshotComparisonLive,
  RetentionScheduleLive,
  RetentionPurgeLive,
  MeLive,
  CatalogLive,
  OrganizationByIdLive,
  MembersLive,
  BillingLive,
  ProjectsLive,
  ApiKeysLive,
  CommitsLive,
  PullsLive,
  RunsLive,
  RunByIdLive,
  ResultPartsLive,
  ArtifactsLive,
  SubjectsLive,
  SubjectHistoryLive,
  StoriesLive,
  UploadLinksLive,
  ArtifactLinksLive,
  ResultPartLinksLive,
  CredentialLive,
  CheckoutLinkLive,
  PortalLinkLive,
  BillingAccountLive,
);
