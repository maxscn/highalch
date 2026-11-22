import { useLiveQuery } from "@tanstack/react-db";
import { notes } from "../../../../fixtures/notes";

/**
 * Example: **the list claims to be empty while it loads.**
 *
 * The broken list reads `result.data` directly and treats "no rows" as "no notes", so until the
 * first query answers it tells the user they have none. The approved list renders each state the
 * live query is in, as `LowAlch.match` makes a view do (the fixture `NoteList`).
 *
 * Caught by: `List.check` after `Story.hold()` keeps the first answer back, so the frame shows the
 * list before its data arrives.
 */
export function BrokenNoteList({ account }: { readonly account: string }) {
  const { data } = useLiveQuery((q) =>
    q.from({ note: notes.list({ account }) }).orderBy(({ note }) => note.NoteId),
  );

  return (
    <section className="notes">
      <h1>Notes</h1>
      {data.length === 0 && <p className="status empty">No notes yet</p>}
      <ul>
        {data.map((note) => (
          <li key={note.NoteId} className="note">
            <span className="title">{note.title}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export { NoteList as ApprovedNoteList, css } from "../../../../fixtures/note-list";
