import { useRef } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import * as LowAlch from "@lowalch/tanstack-db";
import { notes } from "../../../fixtures/notes";

/**
 * Example: **a rejected rename stays on screen.**
 *
 * The broken row remembers the optimistic title it saw while the rename was pending and keeps
 * showing it, so when the server rejects the rename (`NoteLocked`) and TanStack DB rolls the row
 * back, the screen still says "locked". The approved row shows what the collection holds now,
 * with a badge while a write is pending.
 *
 * Caught by: `List.check` after `Db.rejected(...)` reads the title the screen shows; `Db.then`
 * shows the collection itself was rolled back, so the bug is in the view.
 */
type Row = {
  readonly NoteId: string;
  readonly title: string;
  readonly $hasPendingWrites?: boolean;
};

function BrokenTitle({ note }: { readonly note: Row }) {
  const optimistic = useRef<string | undefined>(undefined);

  if (note.$hasPendingWrites) optimistic.current = note.title;

  return (
    <li className={note.$hasPendingWrites ? "note pending" : "note"}>
      <span className="title">{optimistic.current ?? note.title}</span>
      {note.$hasPendingWrites && <span className="badge">saving</span>}
    </li>
  );
}

function ApprovedTitle({ note }: { readonly note: Row }) {
  return (
    <li className={note.$hasPendingWrites ? "note pending" : "note"}>
      <span className="title">{note.title}</span>
      {note.$hasPendingWrites && <span className="badge">saving</span>}
    </li>
  );
}

const titles =
  (Title: (props: { readonly note: Row }) => React.JSX.Element) =>
  ({ account }: { readonly account: string }) => {
    const result = useLiveQuery((q) =>
      q.from({ note: notes.list({ account }) }).orderBy(({ note }) => note.NoteId),
    );

    return (
      <section className="notes">
        <h1>Notes</h1>
        {LowAlch.match(result).on({
          Loading: () => <p className="status loading">Loading notes…</p>,
          Retrying: ({ error, attempt }) => (
            <p className="status retrying">
              Reconnecting after {error._tag} (attempt {attempt})…
            </p>
          ),
          Ready: ({ data }) => (
            <ul>
              {data.map((note) => (
                <Title key={note.NoteId} note={note} />
              ))}
            </ul>
          ),
          orElse: (error) => <p className="status error">Could not load notes: {error._tag}</p>,
        })}
      </section>
    );
  };

export const BrokenTitles = titles(BrokenTitle);

export const ApprovedTitles = titles(ApprovedTitle);

export { css } from "../../../fixtures/note-list";
