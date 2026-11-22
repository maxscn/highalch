import * as Domain from "@alchemy.run/domain";

export class RunMissing extends Domain.Rejection("RunMissing", {}, { httpApiStatus: 404 }) {}
