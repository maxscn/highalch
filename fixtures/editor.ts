import { setupEffect } from "@xstate/effect";
import { Match, Predicate } from "effect";
import { types } from "xstate";
import { invoke, rejection } from "@highalch/tanstack-db/xstate";
import { notes } from "./notes";

/** What the editor holds: the note it edits, the draft title, and the last problem's tag. */
export type Editing = {
  readonly NoteId: string;
  readonly draft: string;
  readonly problem: string | undefined;
};

/**
 * A note title editor: Idle → Editing → Saving → Saved | Stale | Failed. Saving invokes the
 * declared `notes.rename` command through `invoke`, so its output is the command's `Settled` value
 * and its error the typed rejection: `NoteMissing` (the note is gone) makes it Stale, any other
 * rejection Failed, where an edit starts again.
 */
export const editor = setupEffect({
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
      tags: ["pending-write"],
      invoke: {
        src: "rename",
        input: ({ context }) => ({ NoteId: context.NoteId, title: context.draft }),
        onDone: ({ context }) => ({ target: "Saved", context: { ...context, problem: undefined } }),
        onError: ({ context, event }) => {
          const problem = Match.value(rejection(event.error)).pipe(
            Match.when(Predicate.isTagged("NoteMissing"), () => "NoteMissing"),
            Match.when(Predicate.isTagged("NoteLocked"), () => "NoteLocked"),
            Match.orElse(() => "Unknown"),
          );

          return {
            target: problem === "NoteMissing" ? "Stale" : "Failed",
            context: { ...context, problem },
          };
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
    Stale: {},
  },
});
