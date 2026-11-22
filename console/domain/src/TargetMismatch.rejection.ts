import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";

/**
 * The command names another instance in its input than the one it was sent to. Every command a
 * client sends carries its target's id in its input (HighAlch calls take input only).
 */
export class TargetMismatch extends Domain.Rejection(
  "TargetMismatch",
  {},
  { httpApiStatus: 400 },
) {}

/** Succeeds when the input names the instance the command was sent to. */
export const sameTarget = (named: string, id: string) =>
  named === id ? Effect.void : Effect.fail(new TargetMismatch());
