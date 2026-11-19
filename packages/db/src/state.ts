import { Cause, Data } from "effect";

/** The errors a HighAlch read or command may fail with: tagged values, like `Schema.TaggedError` classes. */
export type TaggedFailure = Readonly<Record<"_tag", string>>;

export const clientClosedMessage = "HighAlch client is closing or closed";

/** An attempted read from a closing or closed HighAlch client. */
export class ClientClosed extends Data.TaggedError("HighAlch.ClientClosed") {
  override get message() {
    return clientClosedMessage;
  }
}

/**
 * A failure that is not one of the operation's typed errors: a bug, an undecodable response or an
 * unexpected interruption. It is never a state; `match` throws it to the nearest error boundary.
 */
export class Defect extends Data.TaggedError("HighAlch.Defect")<{
  readonly name: string;
  readonly cause: Cause.Cause<unknown>;
}> {
  override get message() {
    return `${this.name} failed unexpectedly`;
  }
}
