import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { Count, Millis } from "../Ids.ts";
import { BlobId } from "./Blob.id.ts";
import { BlobMissing, BlobStored, ConfirmBlob } from "./ConfirmBlob.command.ts";
import { BlobForgotten, ForgetBlob } from "./ForgetBlob.command.ts";
import { BlobReused, BlobUploadIssued, ReferenceBlob } from "./ReferenceBlob.command.ts";

export const BlobState = Schema.Struct({
  status: Schema.Literals(["absent", "pending", "stored"]),
  generation: Count,
  bytes: Count,
  lastReferencedAt: Millis,
});
export type BlobState = typeof BlobState.Type;

/** One stored body of one organisation. Only server code and policies send its commands. */
export class Blob extends Domain.Aggregate("Blob", {
  id: BlobId,
  state: BlobState,
  initial: { status: "absent", generation: 0, bytes: 0, lastReferencedAt: 0 },
  commands: [ReferenceBlob, ConfirmBlob, ForgetBlob],
  decide: {
    ReferenceBlob: (s, cmd, { now }) => {
      const at = DateTime.toEpochMillis(now);
      return s.status === "stored" && s.bytes === cmd.bytes
        ? [new BlobReused({ generation: s.generation, at })]
        : [new BlobUploadIssued({ generation: s.generation, bytes: cmd.bytes, at })];
    },
    ConfirmBlob: (s, cmd) => {
      if (cmd.generation !== s.generation || s.status === "absent") return [];
      if (cmd.ok)
        return s.status === "stored" ? [] : [new BlobStored({ generation: s.generation })];
      return s.status === "stored" ? [] : [new BlobMissing({ generation: s.generation })];
    },
    ForgetBlob: (s, cmd) =>
      s.status !== "absent" && s.lastReferencedAt < cmd.before
        ? [new BlobForgotten({ generation: s.generation })]
        : [],
  },
  evolve: {
    BlobReused: (s, e) => ({ ...s, lastReferencedAt: e.at }),
    BlobUploadIssued: (s, e) => ({
      ...s,
      status: s.status === "stored" ? ("stored" as const) : ("pending" as const),
      bytes: e.bytes,
      lastReferencedAt: e.at,
    }),
    BlobStored: (s) => ({ ...s, status: "stored" as const }),
    BlobMissing: (s) => ({ ...s, status: "absent" as const }),
    BlobForgotten: (s) => ({ ...s, status: "absent" as const, generation: s.generation + 1 }),
  },
  reply: {
    ReferenceBlob: (s, events) => ({
      upload: events.some((e) => e._tag === "BlobUploadIssued"),
      generation: s.generation,
    }),
    ForgetBlob: (s, events) => ({
      forgotten: events.length > 0,
      generation: events.length > 0 ? s.generation - 1 : s.generation,
    }),
  },
}) {}
