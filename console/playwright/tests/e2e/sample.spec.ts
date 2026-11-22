import { readFile, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const swatch = async (name: string) => readFile(`${process.env.E2E_SNAPSHOTS}/${name}`);

test.describe("checkout", () => {
  test(
    "passes with steps and attachments",
    { tag: "@smoke", annotation: { type: "highalch:page", description: "checkout" } },
    async () => {
      const info = test.info();
      await test.step("outer", async () => {
        await test.step("inner", async () => {
          expect(1 + 1).toBe(2);
        });
      });
      await info.attach("screenshot", { body: await swatch("blue.png"), contentType: "image/png" });
      await info.attach("video", { body: Buffer.from("webm"), contentType: "video/webm" });
      const trace = info.outputPath("trace.zip");
      await writeFile(trace, "zip");
      await info.attach("trace", { path: trace, contentType: "application/zip" });
      console.log("hello from stdout");
    },
  );

  test("is flaky", async () => {
    expect(test.info().retry, "fails on the first attempt").toBe(1);
  });

  test("fails", async () => {
    expect("actual", "a failing assertion").toBe("expected");
  });

  test("is skipped", async () => {
    test.skip(true, "not today");
  });

  test("snapshot mismatch", async () => {
    expect(await swatch("blue.png")).toMatchSnapshot("swatch.png");
  });
});
