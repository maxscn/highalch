import * as Domain from "@alchemy.run/domain";

export class ProjectMissing extends Domain.Rejection(
  "ProjectMissing",
  {},
  { httpApiStatus: 404 },
) {}
