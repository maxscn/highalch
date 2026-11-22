import type { SessionUser } from "@highalch/console-domain/Authentication";
import { UserId } from "@highalch/console-domain/Ids";

/**
 * The development user and session (development test values, used only by the in-memory
 * backend): Jamie Lee, as the generated seed has them.
 */
export const developer: SessionUser & { readonly password: string } = {
  id: UserId.make("usr_jlee"),
  email: "jamie@acme.test",
  name: "Jamie Lee",
  password: "highalch-dev-password",
};

/** The `highalch_session` value of the development session. */
export const sessionToken = "dev-session-jlee";
