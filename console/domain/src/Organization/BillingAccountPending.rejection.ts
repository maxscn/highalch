import * as Domain from "@alchemy.run/domain";

/** The organisation's payment customer is not created yet (`BillingAccount`); ask again shortly. */
export class BillingAccountPending extends Domain.Rejection(
  "BillingAccountPending",
  {},
  { httpApiStatus: 409 },
) {}
