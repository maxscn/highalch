import * as Domain from "@alchemy.run/domain";

/**
 * The organisation has no such open run: it was never opened there, or it already completed
 * or expired. Uploads only go to an open run.
 */
export class RunNotOpen extends Domain.Rejection("RunNotOpen", {}, { httpApiStatus: 409 }) {}
