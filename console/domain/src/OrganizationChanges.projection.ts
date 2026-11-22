import * as HighAlch from "@lowalch/tanstack-db/server";
import { BillingRows } from "./Organization/Billing.rows.ts";
import { MemberRows } from "./Organization/Member.rows.ts";
import { OrganizationRows } from "./Organization/Organization.rows.ts";
import { OrganizationChanges } from "./OrganizationChanges.stream.ts";
import { ApiKeyRows } from "./Project/ApiKey.rows.ts";
import { ProjectRows } from "./Project/Project.rows.ts";
import { CommitRows, PullRows } from "./Project/Source.rows.ts";
import { ArtifactRows } from "./Run/Artifact.rows.ts";
import { ResultRows } from "./Run/Result.rows.ts";
import { RunRows } from "./Run/Run.rows.ts";
import { StoryRows } from "./Story/Story.rows.ts";
import { SubjectRows } from "./Subject/Subject.rows.ts";
import { SubjectResultRows } from "./Subject/SubjectResult.rows.ts";

/** The organisation feed's one writer: every entity on it, one line each. */
export class OrganizationChangesWriter extends HighAlch.Projection("OrganizationChangesWriter", {
  feed: OrganizationChanges,
  entities: [
    OrganizationRows,
    MemberRows,
    BillingRows,
    ProjectRows,
    ApiKeyRows,
    RunRows,
    ResultRows,
    ArtifactRows,
    SubjectRows,
    SubjectResultRows,
    CommitRows,
    PullRows,
    StoryRows,
  ],
}) {}
