import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Count } from "../Ids.ts";
import { BlobId } from "./Blob.id.ts";

export class BlobStored extends Domain.Event("BlobStored", { generation: Count }) {}
export class BlobMissing extends Domain.Event("BlobMissing", { generation: Count }) {}

/** Upload verification saw the object (`ok`: right size and digest) or not. */
export class ConfirmBlob extends Domain.Command("ConfirmBlob", {
  target: BlobId,
  input: { generation: Count, ok: Schema.Boolean },
  events: [BlobStored, BlobMissing],
  rejects: [],
}) {}
