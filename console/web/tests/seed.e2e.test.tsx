import { join } from "node:path";
import { Run } from "@highalch/console-domain/Run/Run.aggregate";
import { RunId } from "@highalch/console-domain/Run/Run.id";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { expect, it } from "vite-plus/test";
import { host } from "../dev/backend.ts";
import { seed } from "../dev/seed.ts";

/** The development seed reaches the model whole: every write CI sent shows on its run. */
it("seeds every run with its results, at its own times", async () => {
  const { clock, platform, layer } = host("data");
  const runtime = ManagedRuntime.make(layer);
  await runtime.runPromise(
    seed(join(import.meta.dirname, "../.seed"))(clock, platform.control.idle),
  );
  const seeded = await runtime.runPromise(
    Effect.gen(function* () {
      const runs = yield* Run;
      return yield* Effect.forEach(
        Array.from({ length: 16 }, (_, n) => String(8801 + n)),
        (id) => Effect.map(runs.get(RunId.make(id)), (state) => ({ id, state })),
      );
    }),
  );
  await runtime.dispose();
  for (const { id, state } of seeded) {
    expect(state._tag, id).toBe("Run");
    if (state._tag !== "Run") continue;
    expect(state.status, id).toBe("completed");
    expect(state.reason, id).toBe("client");
    const rows =
      Object.values(state.summary.tests).reduce((n, v) => n + v, 0) +
      Object.values(state.summary.cases).reduce((n, v) => n + v, 0);
    // Story-only runs (8812–8816) report stories, not tests.
    if (Number(id) <= 8811) expect(rows, id).toBeGreaterThan(0);
    expect((state.completedAt ?? 0) - state.createdAt, id).toBe(
      state.kind === "playwright" ? 240_000 : 120_000,
    );
  }
});
