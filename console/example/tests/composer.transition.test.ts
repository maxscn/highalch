import { Schema } from "effect";
import { afterAll, expect, it } from "vite-plus/test";
import { Console, Fuzz } from "@highalch/console-fuzz";
import { fromEffect } from "@highalch/console-fuzz/effect";
import { ComposerAction, ComposerState, initial, invariant, transition } from "../src/index.ts";

// One reporter per test file; it uploads with HIGHALCH_URL + credentials, otherwise writes .highalch/.
const report = Console.reporter({ project: "crm-example" });
afterAll(async () => {
  await report.flush();
});

// Actions come from the Effect Schema: JSON Schema -> fast-check arbitrary -> decoded action.
const actions = Fuzz.arbitrary(fromEffect(ComposerAction)).map(
  Schema.decodeUnknownSync(Schema.toCodecJson(ComposerAction)),
);

it("f(composer, seeded action sequence) keeps every state valid and serializable", async () => {
  const encode = Schema.encodeSync(Schema.toCodecJson(ComposerState));
  const run = await Fuzz.run({
    name: "composer",
    subject: { kind: "part", name: "composer" },
    seed: 20260922,
    steps: 50,
    runs: 200,
    initial,
    actions,
    step: transition,
    invariant: (state) => {
      invariant(state);
      // Round-trips through its JSON encoding, like the CRM's serialized-snapshot replay.
      expect(Schema.decodeUnknownSync(Schema.toCodecJson(ComposerState))(encode(state))).toEqual(
        state,
      );
    },
  });
  report.trace(run);
  expect(run.failure).toBeNull();
  expect(run.trace).toHaveLength(50);
});

it("reports the shrunk counterexample with seed and path when an invariant breaks", async () => {
  const run = await Fuzz.run({
    name: "composer-retry-limit",
    subject: { kind: "part", name: "composer" },
    seed: 20260922,
    steps: 50,
    initial,
    actions,
    step: transition,
    // A deliberately strict invariant: no more than two delivery attempts.
    invariant: (state) => {
      if ("attempts" in state && state.attempts > 2) throw new Error("third delivery attempt");
    },
  });
  report.trace(run);
  expect(run.failure?.message).toBe("third delivery attempt");
  // Minimal sequence: type, send, fail, send, fail, send.
  expect(run.failure?.counterexample.map((action) => action._tag)).toEqual([
    "Type",
    "Send",
    "DeliveryFailed",
    "Send",
    "DeliveryFailed",
    "Send",
  ]);
  expect(run.trace.at(-1)?.state).toMatchObject({ _tag: "Sending", attempts: 3 });
});
