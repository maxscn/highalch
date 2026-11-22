import { describe, it } from "vite-plus/test";
import { page, phone } from "./support.tsx";

/**
 * Every finished screen against the seeded Console, in light and dark: one reviewed frame each
 * (`tests/baselines`, written with UPDATE_SCREENS=1; the run's filmstrips in artifacts/stories).
 */
const screens = [
  ["sign in", "/sign-in"],
  ["runs", "/acme/crm/runs"],
  ["pull requests", "/acme/crm/pulls"],
  ["run overview", "/acme/crm/runs/8807"],
  ["test detail", "/acme/crm/runs/8807/tests/5e3a37b56b676e344f92-682b4d4db61be8058258"],
  ["stories", "/acme/notes-app/stories"],
  ["story", "/acme/notes-app/runs/8816/stories/rename-is-rejected?step=4"],
  ["story failure", "/acme/notes-app/runs/8816/stories/rename-settles"],
  ["settings", "/acme/crm/settings"],
] as const;

describe("screens", () => {
  for (const [name, url] of screens)
    for (const theme of ["light", "dark"] as const)
      it(`${name} (${theme})`, () => page(name, url, theme), 300_000);
});

/** The narrow layout: the shell and the main screens at 390 px. */
const narrow = [
  ["stories", "/acme/notes-app/stories"],
  ["runs", "/acme/crm/runs"],
  ["run overview", "/acme/crm/runs/8807"],
  ["story", "/acme/notes-app/runs/8816/stories/rename-is-rejected?step=4"],
] as const;

describe("screens on a phone", () => {
  for (const [name, url] of narrow)
    it(`${name} (phone)`, () => page(name, url, "light", phone), 300_000);
});
