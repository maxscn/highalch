import * as Domain from "@alchemy.run/domain";

export class OrganizationMissing extends Domain.Rejection(
  "OrganizationMissing",
  {},
  { httpApiStatus: 404 },
) {}
