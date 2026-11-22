import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { runExpiryHours } from "../Billing/Plan.ts";
import { Organization } from "../Organization/Organization.aggregate.ts";
import { CloseRun } from "../Organization/OpenRun.command.ts";
import { ExpireRun, RunCompleted } from "./FinishRun.command.ts";
import { RunCreated } from "./CreateRun.command.ts";
import { Run } from "./Run.aggregate.ts";
import { RunId } from "./Run.id.ts";

/**
 * Every run ends: arm its expiry when it starts, and free its organisation's run slot when it
 * completes (by the client or by expiry).
 */
export class RunLifecycle extends Domain.Policy("RunLifecycle", {
  from: Run,
  on: [RunCreated, RunCompleted],
}) {}

export const RunLifecycleLive = RunLifecycle.toLayer(
  Effect.gen(function* () {
    const runs = yield* Run;
    const organizations = yield* Organization;
    return Effect.fn(function* ({ source, event }) {
      if (event._tag === "RunCreated") {
        yield* runs.schedule(source, new ExpireRun({}), {
          after: `${runExpiryHours} hours`,
          commandId: `expire:${source.id}`,
        });
        return;
      }
      yield* organizations.send(event.org, new CloseRun({ run: RunId.make(source.id) }));
    });
  }),
);
