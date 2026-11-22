import * as Domain from "@alchemy.run/domain";
import { Count } from "../Ids.ts";
import { RunId } from "./Run.id.ts";

export class UploadForfeited extends Domain.Event("UploadForfeited", { bytes: Count }) {}

/**
 * Verification found these bytes missing or mismatched and released their quota: the run no
 * longer holds them, so retention does not release them twice.
 */
export class ForfeitUpload extends Domain.Command("ForfeitUpload", {
  target: RunId,
  input: { bytes: Count },
  events: [UploadForfeited],
  rejects: [],
}) {}
