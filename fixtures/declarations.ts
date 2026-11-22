import * as LowAlch from "@lowalch/tanstack-db/server";
import { Book, BookAggregate, NotebookChanges } from "./notebook";

export const DeclaredBookRows = LowAlch.Rows("DeclaredBookRows", {
  feed: NotebookChanges,
  row: Book,
  key: "BookId",
  from: [BookAggregate],
  scope: ({ event }) => event.book.account,
  on: {
    BookCreated: (event) => LowAlch.upserted(event.book),
    BookRenamed: (event) => LowAlch.upserted(event.book),
  },
});

export class DeclaredBookRowsClass extends LowAlch.Rows("DeclaredBookRowsClass", {
  feed: NotebookChanges,
  row: Book,
  key: "BookId",
  from: [BookAggregate],
  scope: ({ event }) => event.book.account,
  on: {
    BookCreated: (event) => LowAlch.upserted(event.book),
    BookRenamed: (event) => LowAlch.upserted(event.book),
  },
}) {}
