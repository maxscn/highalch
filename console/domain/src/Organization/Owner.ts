import type { Actor } from "../Actor.ts";

/** Only an organisation's owners pay for it and manage its billing. */
export const isOwner = (actor: Actor, org: string) =>
  actor._tag === "User" && actor.memberships.some((m) => m.org === org && m.role === "owner");
