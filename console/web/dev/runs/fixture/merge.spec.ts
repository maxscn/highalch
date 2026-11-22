import { expect, test } from "@playwright/test";
import { origin, serve } from "./app.ts";

test.beforeEach(async ({ page }) => {
  await serve(page);
});

test.describe(
  "merge duplicates",
  { annotation: { type: "highalch:page", description: "customers/Duplicates" } },
  () => {
    test("finds duplicate customers", async ({ page }) => {
      await page.goto(`${origin}/customers`);
      await page.getByRole("button", { name: "Find duplicates" }).click();
      await expect(page.getByRole("heading", { name: "Possible duplicates" })).toBeVisible();
    });

    test("merges two customers", async ({ page }) => {
      await page.goto(`${origin}/customers`);
      await test.step("open duplicates", async () => {
        await page.getByRole("button", { name: "Find duplicates" }).click();
      });
      await test.step("merge", async () => {
        await page.getByRole("button", { name: "Merge customers" }).click({ timeout: 2000 });
        await expect(page.getByRole("status")).toHaveText("Merged 2 customers");
      });
    });

    test("duplicates panel matches the design", async ({ page }) => {
      await page.setViewportSize({ width: 720, height: 520 });
      await page.goto(`${origin}/customers`);
      await page.getByRole("button", { name: "Find duplicates" }).click();
      await expect(page.locator("#duplicates button")).toHaveScreenshot("merge-button.png", {
        maxDiffPixelRatio: 0.01,
      });
    });
  },
);
