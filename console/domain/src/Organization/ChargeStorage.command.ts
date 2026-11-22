import * as Domain from "@alchemy.run/domain";
import { Count } from "../Ids.ts";
import { RunId } from "../Run/Run.id.ts";
import { OrganizationId } from "./Organization.id.ts";

export class StorageCharged extends Domain.Event("StorageCharged", { run: RunId, bytes: Count }) {}

/**
 * Derived data the server stored for a run (its snapshot comparison) counts against the
 * stored-bytes cap like uploads. Never refused: it is written after the fact; the next
 * reservation sees it.
 */
export class ChargeStorage extends Domain.Command("ChargeStorage", {
  target: OrganizationId,
  input: { run: RunId, bytes: Count },
  events: [StorageCharged],
  rejects: [],
}) {}
