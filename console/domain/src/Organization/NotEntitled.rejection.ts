import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/** No paid period is current, or payment failed / was refunded / disputed. */
export class NotEntitled extends Domain.Rejection(
  "NotEntitled",
  { reason: Schema.Literals(["no_entitlement", "suspended"]) },
  { httpApiStatus: 402 },
) {}
