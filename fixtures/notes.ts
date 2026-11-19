import * as HighAlch from "@highalch/db";
import {
  address,
  BookRows,
  Books,
  CreateBook,
  CreateNote,
  DeleteNote,
  MoveNote,
  NoteById,
  NoteRows,
  Notes,
  NotesByBook,
  NotesByTitle,
  NoteStats,
  PinNote,
  RenameBook,
  RenameNote,
  TouchNote,
} from "./notebook";

/**
 * The module-level declarations every test reads and writes through. Every command is called with
 * its input only: `NoteRows` declares the target (`[scope, key]` as JSON).
 */
export const notes = HighAlch.collection(NoteRows, {
  queries: {
    list: Notes,
    get: HighAlch.one(NoteById, (row, input) => row.NoteId === input.NoteId),
    byBook: HighAlch.where(NotesByBook, (row, input) => row.BookId === input.BookId),
    page: HighAlch.windowed(NotesByTitle, (answer) => answer.Items),
    pageWithoutWindow: HighAlch.entries(NotesByTitle, (answer) => answer.Items),
  },
  commands: {
    // The key is a fresh client-generated id.
    create: HighAlch.inserts(CreateNote, {
      row: (input, key) => ({
        NoteId: key,
        account: input.account,
        BookId: input.BookId,
        title: input.title,
        pinned: false,
      }),
    }),
    // A declared key: the caller knows the new note's key from its input.
    file: HighAlch.inserts(CreateNote, {
      key: (input) => `${input.BookId}:${input.title}`,
      row: (input, key) => ({
        NoteId: key,
        account: input.account,
        BookId: input.BookId,
        title: input.title,
        pinned: false,
      }),
    }),
    rename: HighAlch.updates(RenameNote),
    move: HighAlch.updates(MoveNote),
    pin: HighAlch.edits(PinNote, {
      change: (draft, input) => {
        draft.pinned = input.pinned;
      },
    }),
    remove: HighAlch.deletes(DeleteNote),
    touch: TouchNote,
  },
});

/** The second entity: its view declares no target, so its commands address the row key. */
export const books = HighAlch.collection(BookRows, {
  queries: { list: Books },
  commands: {
    create: HighAlch.inserts(CreateBook, {
      row: (input, key) => ({ BookId: key, account: input.account, name: input.name }),
    }),
    rename: HighAlch.updates(RenameBook),
  },
});

/** Not an entity: one row per input, no feed. */
export const stats = HighAlch.query(NoteStats);

/** A command with no rows to edit: its target is declared from its input and the scope. */
export const touch = HighAlch.command(TouchNote, {
  target: (input, scope) => address(scope, input.NoteId),
});
