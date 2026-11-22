import { expect, test } from "@playwright/test";
import { origin, serve } from "./app.ts";

test.beforeEach(async ({ page }) => {
  await serve(page);
});

test.describe(
  "settings",
  { annotation: { type: "highalch:page", description: "settings/Notifications" } },
  () => {
    test("saves notification settings", async ({ page }) => {
      await page.goto(`${origin}/settings`);
      await page.getByLabel("Weekly digest").check();
      await page.getByRole("button", { name: "Save settings" }).click();
      await expect(page.getByRole("status")).toHaveText("Saved");
    });

    test("configures single sign-on", async () => {
      test.skip(true, "SSO needs an identity provider");
    });
  },
);
