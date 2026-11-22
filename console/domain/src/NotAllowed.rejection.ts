import * as Domain from "@alchemy.run/domain";

/** The caller may not do this to this instance (another organisation's, or the wrong role). */
export class NotAllowed extends Domain.Rejection("NotAllowed", {}, { httpApiStatus: 403 }) {}
