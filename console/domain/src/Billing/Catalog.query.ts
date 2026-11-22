import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Count } from "../Ids.ts";
import { LimitsRow } from "../Organization/Billing.ts";
import { plans, topUps } from "./Plan.ts";

const Price = Schema.Struct({ amount: Count, currency: Schema.Literal("eur") });

/** What HighAlch Console sells: its monthly plans and prepaid top-ups. */
export const CatalogRow = Schema.Struct({
  plans: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      price: Price,
      interval: Schema.Literal("month"),
      limits: LimitsRow,
    }),
  ),
  topUps: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      price: Price,
      adds: Schema.Struct({ uploadedBytes: Count, artifacts: Count, resultRows: Count }),
    }),
  ),
});

/** The price list. Public: it needs no credential. */
export class Catalog extends Domain.Query(
  "Catalog",
  { input: {}, success: CatalogRow },
  { description: "The plans and top-ups on sale, with their prices and limits." },
) {}

export const CatalogLive = Catalog.toLayer(Effect.succeed(() => Effect.succeed({ plans, topUps })));
