import * as Schema from "effect/Schema";

/** A project is keyed by its slug, unique across HighAlch Console. */
export const ProjectId = Schema.String.pipe(Schema.brand("ProjectId"));
export type ProjectId = typeof ProjectId.Type;

/** `owner/name`, lower-cased. */
export const RepositoryId = Schema.String.pipe(Schema.brand("RepositoryId"));
export type RepositoryId = typeof RepositoryId.Type;
