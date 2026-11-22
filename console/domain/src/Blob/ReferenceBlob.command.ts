import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Count, Millis } from "../Ids.ts";
import { BlobId } from "./Blob.id.ts";

export class BlobReused extends Domain.Event("BlobReused", { generation: Count, at: Millis }) {}

export class BlobUploadIssued extends Domain.Event("BlobUploadIssued", {
  generation: Count,
  bytes: Count,
  at: Millis,
}) {}

/**
 * A run declares a body. If the organisation already stores it (verified, same size), it is
 * reused and nothing is uploaded; otherwise an upload is issued for the current generation.
 * Either way the reference keeps the body from retention until it ages out.
 */
export class ReferenceBlob extends Domain.Command("ReferenceBlob", {
  target: BlobId,
  input: { bytes: Count },
  events: [BlobReused, BlobUploadIssued],
  rejects: [],
  reply: { upload: Schema.Boolean, generation: Count },
}) {}
