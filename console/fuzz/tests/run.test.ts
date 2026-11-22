import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import { Fuzz } from "../src/index.ts";

const subject = { kind: "component", name: "test" } as const;

type State = { readonly count: number; readonly log: ReadonlyArray<string> };
type Action = { readonly type: "inc" } | { readonly type: "dec" } | { readonly type: "reset" };

const actions: Fuzz.JsonSchema<Action> = {
  oneOf: [
    { type: "object", properties: { type: { const: "inc" } }, required: ["type"] },
    { type: "object", properties: { type: { const: "dec" } }, required: ["type"] },
    { type: "object", properties: { type: { const: "reset" } }, required: ["type"] },
  ],
};
const step = (state: State, action: Action): State => ({
  count: action.type === "inc" ? state.count + 1 : action.type === "dec" ? state.count - 1 : 0,
  log: [...state.log, action.type],
});
const initial: State = { count: 0, log: [] };

describe("Fuzz.run", () => {
  it("records a full deterministic trace with a capture after every step", async () => {
    const options = {
      subject,
      seed: 20260922,
      steps: 50,
      runs: 20,
      initial,
      actions,
      step,
      capture: (state: State, ctx: Fuzz.CaseContext): Fuzz.Capture => ({
        kind: "html",
        mime: "text/html",
        body: `<p>${state.count}</p>`,
        meta: { step: ctx.index },
      }),
    };
    const a = await Fuzz.run(options);
    const b = await Fuzz.run(options);
    expect(a.failure).toBeNull();
    expect(a.trace).toHaveLength(50);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    a.trace.forEach((entry, index) => {
      expect(entry.index).toBe(index);
      expect(entry.state.log).toHaveLength(index + 1);
      expect(entry.capture?.body).toBe(`<p>${entry.state.count}</p>`);
    });
  });

  it("returns fast-check's shrunk counterexample, a replayable path and the trace up to the failure", async () => {
    const result = await Fuzz.run({
      subject,
      seed: 7,
      steps: 30,
      initial,
      actions,
      step,
      invariant: (state) => {
        if (state.count < -1) throw new RangeError(`count went to ${state.count}`);
      },
    });
    const failure = result.failure;
    if (!failure) throw new Error("expected a failure");
    expect(failure.message).toBe("count went to -2");
    expect(failure.error).toBeInstanceOf(RangeError);
    expect(failure.counterexample).toEqual([{ type: "dec" }, { type: "dec" }]);
    expect(failure.index).toBe(1);
    expect(failure.shrinks).toBeGreaterThan(0);
    expect(result.trace.map((s) => s.state.count)).toEqual([-1, -2]);

    let replayed: ReadonlyArray<Action> | undefined;
    const check = fc.check(
      fc.property(Fuzz.sequence(actions, 30), (sequence) => {
        let state = initial;
        for (const action of sequence) {
          state = step(state, action);
          if (state.count < -1) {
            replayed = sequence;
            return false;
          }
        }
        return true;
      }),
      { seed: failure.seed, path: failure.path },
    );
    expect(check.failed).toBe(true);
    expect(replayed).toEqual(failure.counterexample);
  });

  it("treats a throwing step as the failing step, without a state for it", async () => {
    const result = await Fuzz.run({
      subject,
      seed: 3,
      steps: 10,
      initial,
      actions: fc.constantFrom<Action>({ type: "inc" }, { type: "reset" }),
      step: (state: State, action: Action) => {
        if (action.type === "reset" && state.count > 0) throw new Error("reset after inc");
        return step(state, action);
      },
    });
    expect(result.failure?.counterexample).toEqual([{ type: "inc" }, { type: "reset" }]);
    expect(result.failure?.index).toBe(1);
    expect(result.trace).toHaveLength(1);
  });
});

describe("Fuzz.assertRun", () => {
  it("resolves with the run when every sequence passes", async () => {
    const result = await Fuzz.assertRun({
      subject,
      seed: 1,
      steps: 5,
      runs: 5,
      initial,
      actions,
      step,
    });
    expect(result.failure).toBeNull();
    expect(result.trace).toHaveLength(5);
  });

  it("throws a typed error carrying the shrunk run, seed and path", async () => {
    const options = {
      subject,
      seed: 7,
      steps: 30,
      initial,
      actions,
      step,
      invariant: (state: State) => {
        if (state.count < -1) throw new RangeError(`count went to ${state.count}`);
      },
    };
    const error = await Fuzz.assertRun(options).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(Fuzz.RunFailed);
    if (!(error instanceof Fuzz.RunFailed)) throw new Error("expected RunFailed");
    const plain = await Fuzz.run(options);
    expect(error._tag).toBe("RunFailed");
    expect(error.seed).toBe(7);
    expect(error.path).toBe(plain.failure?.path);
    expect(error.counterexample).toEqual([{ type: "dec" }, { type: "dec" }]);
    expect(error.run.trace.map((s) => (s.state as State).count)).toEqual([-1, -2]);
    expect(error.cause).toBeInstanceOf(RangeError);
    expect(error.message).toContain("seed: 7");
    expect(error.message).toContain("count went to -2");
  });
});
