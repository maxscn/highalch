import { OrganizationId } from "@highalch/console-domain/Organization/Organization.id";
import { Payments } from "@highalch/console-domain/Payments.external";
import * as Effect from "effect/Effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Schema from "effect/Schema";
import { systemApi } from "./System.ts";

const LinkCustomerRequest = Schema.Struct({
  org: Schema.String,
  name: Schema.String,
  email: Schema.String,
});

/**
 * Local stage only: gives an organisation created before the `BillingAccount` policy existed
 * its payment customer (`Payments.createCustomer`, then `LinkCustomer` as the `System` actor).
 * `POST /api/local/link-customer {"org","name","email"}`. The Worker serves it only when
 * `HIGHALCH_PAYMENTS=local`; deployed stages have no such route.
 */
export const linkCustomer = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.method !== "POST")
    return HttpServerResponse.text("Method not allowed", { status: 405 });
  const input = yield* Effect.flatMap(
    request.json,
    Schema.decodeUnknownEffect(LinkCustomerRequest),
  );
  const payments = yield* Payments;
  const { customer } = yield* payments.createCustomer(input);
  const api = yield* systemApi("local-admin");
  const org = OrganizationId.make(input.org);
  yield* api.LinkCustomer(org, { customer }, { commandId: `link-customer:${org}` });
  return yield* HttpServerResponse.json({ org, customer });
}).pipe(
  Effect.scoped,
  Effect.catchTags({
    SchemaError: (error) => Effect.succeed(HttpServerResponse.text(error.message, { status: 400 })),
    OrganizationMissing: () =>
      Effect.succeed(HttpServerResponse.text("Unknown organisation", { status: 404 })),
  }),
  // the System actor is never refused; the in-process client has no transport to fail
  Effect.orDie,
);
