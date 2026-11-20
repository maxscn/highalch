import * as LowAlch from "@lowalch/tanstack-db";
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
  NotesByCursor,
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
export const notes = LowAlch.collection(NoteRows, {
  queries: {
    list: LowAlch.read(Notes).all(),
    get: LowAlch.read(NoteById).one((row, input) => row.NoteId === input.NoteId),
    byBook: LowAlch.read(NotesByBook).where((row, input) => row.BookId === input.BookId),
    cursor: NotesByCursor,
    page: LowAlch.read(NotesByTitle).rows((answer) => answer.Items),
  },
  commands: {
    // The key is a fresh client-generated id.
    create: LowAlch.inserts(CreateNote, {
      row: (input, key) => ({
        NoteId: key,
        account: input.account,
        BookId: input.BookId,
        title: input.title,
        pinned: false,
      }),
    }),
    // A declared key: the caller knows the new note's key from its input.
    file: LowAlch.inserts(CreateNote, {
      key: (input) => `${input.BookId}:${input.title}`,
      row: (input, key) => ({
        NoteId: key,
        account: input.account,
        BookId: input.BookId,
        title: input.title,
        pinned: false,
      }),
    }),
    rename: LowAlch.updates(RenameNote),
    move: LowAlch.updates(MoveNote),
    pin: LowAlch.edits(PinNote, {
      change: (draft, input) => {
        draft.pinned = input.pinned;
      },
    }),
    remove: LowAlch.deletes(DeleteNote),
    touch: TouchNote,
  },
});

/** The second entity: its view declares no target, so its commands address the row key. */
export const books = LowAlch.collection(BookRows, {
  queries: { list: LowAlch.read(Books).all() },
  commands: {
    create: LowAlch.inserts(CreateBook, {
      row: (input, key) => ({ BookId: key, account: input.account, name: input.name }),
    }),
    rename: LowAlch.updates(RenameBook),
  },
});

/** Not an entity: one row per input, no feed. */
export const stats = LowAlch.query(NoteStats);

/** A command with no rows to edit: its target is declared from its input and the scope. */
export const touch = LowAlch.command(TouchNote, {
  target: (input, scope) => address(scope, input.NoteId),
});
