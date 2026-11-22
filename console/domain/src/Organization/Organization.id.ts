import * as Schema from "effect/Schema";

export const OrganizationId = Schema.String.pipe(Schema.brand("OrganizationId"));
export type OrganizationId = typeof OrganizationId.Type;
