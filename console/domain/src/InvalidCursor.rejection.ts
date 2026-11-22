import * as Domain from "@alchemy.run/domain";

/** The page cursor is not one this query returned. */
export class InvalidCursor extends Domain.Rejection("InvalidCursor", {}, { httpApiStatus: 400 }) {}
