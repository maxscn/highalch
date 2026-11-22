import { expect, test } from "@playwright/test";
import { origin, serve, step } from "./app.ts";

test.beforeEach(async ({ page }) => {
  await serve(page);
});

test.describe(
  "customers",
  { annotation: { type: "highalch:page", description: "customers/List" } },
  () => {
    test("lists every customer", { tag: "@smoke" }, async ({ page }) => {
      await page.goto(`${origin}/customers`);
      await expect(page.getByRole("heading", { name: "Customers" })).toBeVisible();
      await expect(page.locator("tbody tr")).toHaveCount(6);
    });

    test("search filters the table", async ({ page }) => {
      await page.goto(`${origin}/customers`);
      await test.step("type a query", async () => {
        await page.getByLabel("Search customers").fill("grace");
      });
      // Commits 2 and 3 shipped a debounce that raced the first assertion.
      const flaky = (step === 2 || step === 3) && test.info().retry === 0;
      await expect(page.locator("tbody tr:visible")).toHaveCount(flaky ? 2 : 1, { timeout: 1500 });
    });

    test("shows plan badges", async ({ page }) => {
      await page.goto(`${origin}/customers`);
      await expect(page.locator(".badge").first()).toHaveText("Enterprise");
    });

    test("exports customers as CSV", async ({ page }) => {
      test.skip(step < 5, "export lands in the last commit");
      await page.goto(`${origin}/customers`);
      await expect(page.locator("tbody tr")).toHaveCount(6);
    });
  },
);
