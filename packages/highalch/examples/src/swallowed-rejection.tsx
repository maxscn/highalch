import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { setupEffect } from "@xstate/effect";
import { createActorAtoms } from "@xstate/effect/atom";
import { Layer, Match, Predicate } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { types, type SnapshotFrom } from "xstate";
import { invoke, rejection } from "@lowalch/tanstack-db/xstate";
import type { Editing } from "../../../../fixtures/editor";
import { notes } from "../../../../fixtures/notes";

/**
 * Example: **a rejected save says "Saved".**
 *
 * The broken editor machine treats any end of the rename as success: when the server rejects the
 * title (`NoteLocked`), it goes to `Saved`, so the screen tells the user their change is safe
 * while TanStack DB has rolled it back. The approved machine (the fixture `editor`'s logic) goes
 * to `Failed` with the rejection's tag.
 *
 * Caught by: `Machine.then({ state: "Failed" })` after `Db.rejected(...)`; the frame shows the
 * screen the user would have seen.
 */
const editorOf = (onRejection: "report" | "swallow") =>
  setupEffect({
    schemas: {
      input: types<{ readonly NoteId: string }>(),
      context: types<Editing>(),
      events: {
        Edit: types<{ readonly title: string }>(),
        Save: types<void>(),
      },
    },
    actors: { rename: invoke(notes.rename) },
  }).createMachine({
    id: "editor",
    context: ({ input }) => ({ NoteId: input.NoteId, draft: "", problem: undefined }),
    initial: "Idle",
    states: {
      Idle: {
        on: {
          Edit: ({ context, event }) => ({
            target: "Editing",
            context: { ...context, draft: event.title },
          }),
        },
      },
      Editing: {
        on: {
          Edit: ({ context, event }) => ({ context: { ...context, draft: event.title } }),
          Save: () => ({ target: "Saving" }),
        },
      },
      Saving: {
        invoke: {
          src: "rename",
          input: ({ context }) => ({ NoteId: context.NoteId, title: context.draft }),
          onDone: ({ context }) => ({
            target: "Saved",
            context: { ...context, problem: undefined },
          }),
          onError: ({ context, event }) => {
            if (onRejection === "swallow")
              return { target: "Saved", context: { ...context, problem: undefined } };

            const problem = Match.value(rejection(event.error)).pipe(
              Match.when(Predicate.isTagged("NoteMissing"), () => "NoteMissing"),
              Match.when(Predicate.isTagged("NoteLocked"), () => "NoteLocked"),
              Match.orElse(() => "Unknown"),
            );

            return { target: "Failed", context: { ...context, problem } };
          },
        },
      },
      Saved: {
        on: {
          Edit: ({ context, event }) => ({
            target: "Editing",
            context: { ...context, draft: event.title },
          }),
        },
      },
      Failed: {
        on: {
          Edit: ({ context, event }) => ({
            target: "Editing",
            context: { ...context, draft: event.title, problem: undefined },
          }),
        },
      },
    },
  });

export const brokenEditor = editorOf("swallow");

export const approvedEditor = editorOf("report");

const runtime = Atom.runtime(Layer.empty);

/** One broken editor actor per note, as atoms (`Machine.mounted(brokenEditing("n1"))`). */
export const brokenEditing = Atom.family((NoteId: string) =>
  createActorAtoms(runtime, brokenEditor, { input: { NoteId } }),
);

/** One approved editor actor per note, as atoms. */
export const approvedEditing = Atom.family((NoteId: string) =>
  createActorAtoms(runtime, approvedEditor, { input: { NoteId } }),
);

type Editor = SnapshotFrom<typeof approvedEditor>;

const states = ["Idle", "Editing", "Saving", "Saved", "Failed"] as const;

const stateOf = (snapshot: Editor) => states.find((state) => snapshot.matches(state)) ?? "Idle";

const messages = {
  Idle: "Nothing to save",
  Editing: "Unsaved changes",
  Saving: "Saving…",
  Saved: "Saved",
  Failed: "Could not save",
} as const;

/** The editor's view: every state it paints is its machine's (the same view for both). */
export function EditorView({ atoms }: { readonly atoms: ReturnType<typeof approvedEditing> }) {
  const result = useAtomValue(atoms.snapshot);
  const send = useAtomSet(atoms.send);

  if (!AsyncResult.isSuccess(result)) return <p className="status loading">Starting the editor…</p>;

  const snapshot = result.value;
  const state = stateOf(snapshot);

  return (
    <section className="editor">
      <h1>Rename note</h1>
      <input
        className="field"
        value={snapshot.context.draft}
        onChange={(event) => send({ type: "Edit", title: event.target.value })}
      />
      <p className={`status ${state.toLowerCase()}`}>
        {messages[state]}
        {snapshot.context.problem && `: ${snapshot.context.problem}`}
      </p>
      <button
        className="save"
        disabled={state !== "Editing"}
        onClick={() => send({ type: "Save" })}
      >
        Save
      </button>
    </section>
  );
}

export { css } from "../../../../fixtures/note-editor";
