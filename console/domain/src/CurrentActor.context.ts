import * as Domain from "@alchemy.run/domain";
import { Actor } from "./Actor.ts";

/** Who is asking. The server's Caller middleware provides it; policies provide `system`. */
export class CurrentActor extends Domain.RequestContext<CurrentActor>()(
  "Console/CurrentActor",
  Actor,
) {}
