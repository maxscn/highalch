import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { createActorAtoms } from "@xstate/effect/atom";
import { Layer } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import type { SnapshotFrom } from "xstate";
import { editor } from "./editor";

/** The runtime the demo's machines run in: they need no services of their own. */
const runtime = Atom.runtime(Layer.empty);

/**
 * One editor actor per note, as atoms: the actor starts when a component first reads them and
 * stops when the last one unmounts. A story reaches the same actor with
 * `Machine.mounted(editing("n1"))`.
 */
export const editing = Atom.family((NoteId: string) =>
  createActorAtoms(runtime, editor, { input: { NoteId } }),
);

type Editor = SnapshotFrom<typeof editor>;

const states = ["Idle", "Editing", "Saving", "Saved", "Failed", "Stale"] as const;

const stateOf = (snapshot: Editor) => states.find((state) => snapshot.matches(state)) ?? "Idle";

const messages = {
  Idle: "Nothing to save",
  Editing: "Unsaved changes",
  Saving: "Saving…",
  Saved: "Saved",
  Failed: "Could not save",
  Stale: "This note was deleted",
} as const;

/**
 * A demo view for screen stories: a note's title editor, reading its machine through atoms with
 * stock `@effect/atom-react` hooks. Every state it paints is the machine's.
 */
export function NoteEditor({ NoteId }: { readonly NoteId: string }) {
  const atoms = editing(NoteId);
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
        {snapshot.context.problem ? `: ${snapshot.context.problem}` : null}
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

/** The demo's stylesheet: plain CSS, as a compiled app stylesheet would be supplied. */
export const css = `
.editor { display: flex; flex-direction: column; gap: 10px; padding: 16px; width: 100%; height: 100%; background: #f7f7f2; color: #1d2433; font-size: 15px; }
h1 { font-size: 20px; margin: 0; }
.field { display: flex; padding: 8px 12px; min-height: 36px; background: #ffffff; border: 1px solid #d8dbe2; border-radius: 6px; }
.status { margin: 0; padding: 8px 12px; border-radius: 6px; }
.idle { background: #eceef2; color: #4a5263; }
.editing { background: #e8edf7; color: #2a4a8a; }
.saving { background: #fff8e1; color: #8a5a00; }
.saved { background: #e3f4e6; color: #1f6b33; }
.failed { background: #fbe0e0; color: #8a1f1f; }
.stale { background: #fbe0e0; color: #8a1f1f; }
.loading { background: #e8edf7; color: #2a4a8a; }
.save { display: flex; justify-content: center; padding: 8px 12px; background: #2a4a8a; color: #ffffff; border-radius: 6px; }
`;
