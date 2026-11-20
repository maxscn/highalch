import { Suspense } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import * as LowAlch from "@lowalch/tanstack-db";
import { notes } from "./notes";

/** A demo view for screen stories: one account's notes, read with stock `useLiveQuery`. */
export function NoteList({ account }: { readonly account: string }) {
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
        Ready: ({ data }) => <Items notes={data} />,
        orElse: (error) => <p className="status error">Could not load notes: {error._tag}</p>,
      })}
    </section>
  );
}

type Row = {
  readonly NoteId: string;
  readonly title: string;
  readonly $hasPendingWrites?: boolean;
};

function Items({ notes: rows }: { readonly notes: ReadonlyArray<Row> }) {
  return (
    <ul>
      {rows.map((note) => (
        <li key={note.NoteId} className={note.$hasPendingWrites ? "note pending" : "note"}>
          <span className="title">{note.title}</span>
          {note.$hasPendingWrites ? <span className="badge">saving</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** The same notes read with `Loading: LowAlch.Suspend`: the first load suspends. */
function SuspendingItems({ account }: { readonly account: string }) {
  const result = useLiveQuery((q) =>
    q.from({ note: notes.list({ account }) }).orderBy(({ note }) => note.NoteId),
  );

  return LowAlch.match(result).on({
    Loading: LowAlch.Suspend,
    Retrying: ({ error, attempt }) => (
      <p className="status retrying">
        Reconnecting after {error._tag} (attempt {attempt})…
      </p>
    ),
    Ready: ({ data }) => <Items notes={data} />,
    orElse: (error) => <p className="status error">Could not load notes: {error._tag}</p>,
  });
}

/** A demo view whose list suspends to a `<Suspense>` fallback until its first load ends. */
export function SuspendingNoteList({ account }: { readonly account: string }) {
  return (
    <section className="notes">
      <h1>Notes</h1>
      <Suspense fallback={<p className="status loading">Waiting for notes…</p>}>
        <SuspendingItems account={account} />
      </Suspense>
    </section>
  );
}

/** The demo's stylesheet: plain CSS, as a compiled app stylesheet would be supplied. */
export const css = `
.notes { display: flex; flex-direction: column; gap: 10px; padding: 16px; width: 100%; height: 100%; background: #f7f7f2; color: #1d2433; font-size: 15px; }
h1 { font-size: 20px; margin: 0; }
ul { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; }
.note { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: #ffffff; border: 1px solid #d8dbe2; border-radius: 6px; }
.note.pending { border-color: #e0a100; background: #fff8e1; }
.badge { font-size: 12px; color: #8a5a00; background: #ffe7a3; padding: 2px 8px; border-radius: 10px; }
.status { margin: 0; padding: 10px 12px; border-radius: 6px; }
.loading { background: #e8edf7; color: #2a4a8a; }
.retrying { background: #fdebd3; color: #8a4b00; }
.error { background: #fbe0e0; color: #8a1f1f; }
`;
