import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { serve } from "@highalch/console-client/testing";

/** Helpers shared by the reporter tests and its end-to-end test. */

const here = dirname(fileURLToPath(import.meta.url));

/** A solid-color RGB PNG. */
export const png = (rgb: readonly [number, number, number], size = 4) => {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([
    Buffer.from([0]),
    ...Array.from({ length: size }, () => Buffer.from(rgb)),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

export const playwright = (env: Record<string, string>) =>
  new Promise<{ code: number | null; output: string }>((resolve) => {
    const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
    execFile(
      process.execPath,
      [cli, "test", "-c", join(here, "e2e", "playwright.config.ts")],
      { cwd: join(here, ".."), env: { ...process.env, CI: "", ...env }, timeout: 120_000 },
      (error, stdout, stderr) =>
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          output: stdout + stderr,
        }),
    );
  });

/** The local Console for one test, closed afterwards. */
export const withConsole = async <A>(
  f: (local: Effect.Success<ReturnType<typeof serve>>) => Promise<A>,
) => {
  const scope = await Effect.runPromise(Scope.make());
  try {
    return await f(await Effect.runPromise(serve().pipe(Scope.provide(scope))));
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
};
