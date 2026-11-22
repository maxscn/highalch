import { system } from "@highalch/console-domain/Actor";
import { Caller } from "@highalch/console-domain/Caller.middleware";
import { ConsoleSystemApi } from "@highalch/console-domain/Console.api";
import { CurrentActor } from "@highalch/console-domain/CurrentActor.context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * `ConsoleSystemApi` in process, as trusted server code named `name` (the `System` actor): what
 * the payment webhook and local admin routes send commands through. Build it per request.
 */
export const systemApi = (name: string) =>
  ConsoleSystemApi.clientInProcess.pipe(
    Effect.provide(
      Layer.succeed(Caller, (effect) => Effect.provideService(effect, CurrentActor, system(name))),
    ),
  );
