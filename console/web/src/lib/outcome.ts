import type { RunRow } from "@highalch/console-domain/Run/Run.rows";
import type { Status } from "../components/ui/status.tsx";

/**
 * A run's outcome as one status: running while open; failed when any test failed, a fuzz case
 * crashed or a trace failed; flaky when tests only flaked; else passed.
 */
export const runStatus = (run: Pick<RunRow, "outcome" | "summary">): Status => {
  if (run.outcome !== "passed") return run.outcome;
  return run.summary.tests.flaky > 0 ? "flaky" : "passed";
};

/** "3 failed, 2 flaky" / "418 passed": a run's result in a few words. */
/** An open run asked to complete, still waiting for uploads its organisation accepted. */
export const waitingFor = (run: Pick<RunRow, "status" | "closing" | "applied">) =>
  run.status === "running" && run.closing !== null ? Math.max(0, run.closing - run.applied) : null;

export const runResult = (
  run: Pick<RunRow, "status" | "summary" | "kind" | "closing" | "applied">,
) => {
  const waiting = waitingFor(run);
  if (waiting !== null)
    return `Completing · waiting for ${waiting} ${waiting === 1 ? "upload" : "uploads"}`;
  if (run.status === "running") return "Running";
  const { tests, cases, traces, stories } = run.summary;
  const storyCount = stories.passed + stories.failed;
  const storyPart =
    storyCount === 0
      ? null
      : stories.failed > 0
        ? `${stories.failed} ${stories.failed === 1 ? "story" : "stories"} failed`
        : `${storyCount} ${storyCount === 1 ? "story" : "stories"} passed`;
  if (run.kind === "stories") {
    const differ = stories.frames.mismatch + stories.frames.missing;
    return (
      [
        storyPart,
        differ > 0 ? `${differ} ${differ === 1 ? "frame differs" : "frames differ"}` : null,
      ]
        .filter((part) => part !== null)
        .join(" · ") || "No stories"
    );
  }
  if (run.kind === "fuzz") {
    const total = cases.ok + cases.overflow + cases.crash + cases.a11y;
    const bad = [
      cases.crash > 0 ? `${cases.crash} crashed` : null,
      traces.failed > 0 ? `${traces.failed} traces failed` : null,
    ].filter((part) => part !== null);
    return bad.length > 0 ? bad.join(", ") : `${total} cases`;
  }
  const bad = [
    tests.failed > 0 ? `${tests.failed} failed` : null,
    tests.flaky > 0 ? `${tests.flaky} flaky` : null,
    stories.failed > 0 ? storyPart : null,
  ].filter((part) => part !== null);
  if (bad.length > 0) return bad.join(", ");
  const total = tests.passed + tests.failed + tests.flaky + tests.skipped;
  const passed = total === 0 ? "No tests" : `${tests.passed} passed`;
  return storyPart === null ? passed : `${passed} · ${storyPart}`;
};
