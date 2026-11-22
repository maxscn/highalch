import * as Schema from "effect/Schema";

/** A Better Auth user id. */
export const UserId = Schema.String.pipe(Schema.brand("UserId"));
export type UserId = typeof UserId.Type;

/** Epoch milliseconds (UTC). Events carry times as numbers so every store encodes them alike. */
export const Millis = Schema.Number;
export type Millis = typeof Millis.Type;

export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
