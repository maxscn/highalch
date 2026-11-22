import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Count, Millis } from "../Ids.ts";
import { BlobId } from "./Blob.id.ts";

export class BlobForgotten extends Domain.Event("BlobForgotten", { generation: Count }) {}

/**
 * Retention: forget the body if nothing referenced it since `before`. The next reference
 * uploads a new generation (a new object key), so a late reference can never point at an
 * object being deleted.
 */
export class ForgetBlob extends Domain.Command("ForgetBlob", {
  target: BlobId,
  input: { before: Millis },
  events: [BlobForgotten],
  rejects: [],
  reply: { forgotten: Schema.Boolean, generation: Count },
}) {}
