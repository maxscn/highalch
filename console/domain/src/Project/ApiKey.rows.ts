import * as HighAlch from "@lowalch/tanstack-db/server";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { Millis } from "../Ids.ts";
import { OrganizationChanges } from "../OrganizationChanges.stream.ts";
import { OrganizationId } from "../Organization/Organization.id.ts";
import { Project, type ActiveProject, type ApiKeyRecord } from "./Project.aggregate.ts";
import { ProjectId } from "./Project.id.ts";

/** An active project API key: never its secret or hash. `key` is the key's id. */
export const ApiKeyRow = Schema.Struct({
  key: Schema.String,
  project: ProjectId,
  org: OrganizationId,
  name: Schema.String,
  /** The start of the token, for recognising a key. */
  prefix: Schema.String,
  createdAt: Millis,
});
export type ApiKeyRow = typeof ApiKeyRow.Type;

export const apiKeyRow = (project: ProjectId, p: ActiveProject, k: ApiKeyRecord): ApiKeyRow => ({
  key: k.key,
  project,
  org: p.org,
  name: k.name,
  prefix: k.prefix,
  createdAt: k.createdAt,
});

/** The active API keys of an organisation's projects, from the projects' own events. */
export class ApiKeyRows extends HighAlch.Rows("ApiKeyRows", {
  feed: OrganizationChanges,
  row: ApiKeyRow,
  key: "key",
  from: [Project],
  scope: ({ event }) =>
    event._tag === "ApiKeyIssued" || event._tag === "ApiKeyRevoked" ? event.org : undefined,
  on: {
    ApiKeyIssued: (event, { source, envelope }) =>
      HighAlch.upserted({
        key: event.key,
        project: source.id,
        org: event.org,
        name: event.name,
        prefix: event.prefix,
        createdAt: DateTime.toEpochMillis(envelope.at),
      }),
    ApiKeyRevoked: (event) => HighAlch.removed(event.key),
  },
}) {}
