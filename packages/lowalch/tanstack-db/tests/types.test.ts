import { expect, expectTypeOf, it } from "vite-plus/test";
import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";
import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as LowAlch from "@lowalch/tanstack-db";
import {
  type Book,
  CreateNote,
  NoteAggregate,
  NoteById,
  NotebookChanges,
  NoteRows,
  Note,
  Notes,
  NotesByBook,
  NotesByTitle,
  NotesByCursor,
  NoteStats,
  type NotesApi,
  PinNote,
  QueryRefused,
  RenameNote,
} from "../../../../fixtures/notebook";
import { notes } from "../../../../fixtures/notes";
import { EntryRows, NotYours } from "../../../../fixtures/ledger";

/**
 * The application registers its floor once: a live query whose projection drops the row marker
 * can fail with any read error of its Api.
 */
declare module "@lowalch/tanstack-db" {
  interface Register {
    readonly errors: LowAlch.ApiErrors<typeof NotesApi> | NotYours;
  }
}

type Read = QueryRefused | RpcClientError;

/** Type-level transitions only: none of these components is rendered. */
export function Recovered() {
  const from = useLiveQuery((q) => q.from({ note: notes.list({ account: "a" }) }));

  expectTypeOf<LowAlch.ErrorsOf<typeof from.data>>().toEqualTypeOf<Read>();

  const where = useLiveQuery((q) =>
    q
      .from({ note: notes.byBook({ BookId: "b" }) })
      .where(({ note }) => eq(note.pinned, true))
      .orderBy(({ note }) => note.title)
      .limit(3),
  );

  expectTypeOf<LowAlch.ErrorsOf<typeof where.data>>().toEqualTypeOf<Read>();

  const joined = useLiveQuery((q) =>
    q
      .from({ note: notes.list({ account: "a" }) })
      .leftJoin({ book: notes.byBook({ BookId: "b" }) }, ({ note, book }) =>
        eq(note.NoteId, book.NoteId),
      ),
  );

  expectTypeOf<LowAlch.ErrorsOf<typeof joined.data>>().toEqualTypeOf<Read>();

  const one = useLiveQuery((q) => q.from({ note: notes.get({ NoteId: "n" }) }).findOne());

  expectTypeOf<LowAlch.ErrorsOf<typeof one.data>>().toEqualTypeOf<Read>();

  const whole = useLiveQuery((q) =>
    q.from({ note: notes.list({ account: "a" }) }).select(({ note }) => note),
  );

  expectTypeOf<LowAlch.ErrorsOf<typeof whole.data>>().toEqualTypeOf<Read>();

  const spread = useLiveQuery((q) =>
    q
      .from({ note: notes.list({ account: "a" }) })
      .select(({ note }) => ({ ...note, heading: note.title })),
  );

  expectTypeOf<LowAlch.ErrorsOf<typeof spread.data>>().toEqualTypeOf<Read>();

  // A non-entity result whose field is an open record (a page cursor) keeps its own errors.
  type Page = LowAlch.Marked<
    { readonly Items: ReadonlyArray<Note>; readonly After?: Record<string, number> },
    Read
  >;

  expectTypeOf<LowAlch.ErrorsOf<Page | undefined>>().toEqualTypeOf<Read>();

  // A field projection drops the marker: the registered floor applies.
  const fields = useLiveQuery((q) =>
    q.from({ note: notes.list({ account: "a" }) }).select(({ note }) => ({ id: note.NoteId })),
  );

  expectTypeOf<LowAlch.Floor>().toEqualTypeOf<Read | NotYours>();
  expectTypeOf<LowAlch.ErrorsOf<typeof fields.data>>().toEqualTypeOf<Read | NotYours>();

  // @ts-expect-error dropping the marker means the extra floor rejection, NotYours, is required
  LowAlch.match(fields).on({
    Loading: () => null,
    Retrying: () => null,
    Ready: () => null,
    QueryRefused: () => null,
    RpcClientError: () => null,
  });

  // Exhaustive without `orElse`, with each error as its own state.
  LowAlch.match(from).on({
    Loading: () => null,
    Retrying: () => null,
    Ready: ({ data }) => data.length,
    QueryRefused: (error) => expectTypeOf(error).toEqualTypeOf<QueryRefused>(),
    RpcClientError: (_error, { retry }) => retry,
  });

  // @ts-expect-error a missing state is named: QueryRefused
  LowAlch.match(from).on({
    Loading: () => null,
    Retrying: () => null,
    Ready: () => null,
    RpcClientError: () => null,
  });

  // @ts-expect-error `Missing` is impossible for a many-row query
  LowAlch.match(from).on({
    Ready: () => null,
    Missing: () => null,
    orElse: () => null,
  });

  LowAlch.match(one).on({
    Ready: ({ data }) => expectTypeOf(data.title).toEqualTypeOf<string>(),
    Missing: () => null,
    orElse: () => null,
  });

  // @ts-expect-error a state named twice
  LowAlch.match(from).on({
    [LowAlch.anyOf("Loading", "Retrying")]: () => null,
    Ready: () => null,
    orElse: () => null,
    Loading: () => null,
  });

  // `Suspend` is the Loading handler whatever the others return; the result drops its `never`.
  const suspended = LowAlch.match(from).on({
    Loading: LowAlch.Suspend,
    Retrying: ({ data }) => data.length,
    Ready: ({ data }) => data.map((note) => note.title),
    QueryRefused: () => null,
    RpcClientError: () => "transport" as const,
  });

  expectTypeOf(suspended).toEqualTypeOf<number | Array<string> | null | "transport">();

  // It changes nothing else: still exhaustive, and with `orElse` too.
  // @ts-expect-error a missing state is named: QueryRefused
  LowAlch.match(from).on({
    Loading: LowAlch.Suspend,
    Retrying: () => null,
    Ready: () => null,
    RpcClientError: () => null,
  });

  LowAlch.match(one).on({ Loading: LowAlch.Suspend, Ready: () => null, orElse: () => null });

  // @ts-expect-error `Suspend` handles only `Loading`
  LowAlch.match(from).on({ Loading: () => null, Ready: LowAlch.Suspend, orElse: () => null });

  LowAlch.match(from).on({
    // @ts-expect-error nor a group naming another state
    [LowAlch.anyOf("Loading", "Retrying")]: LowAlch.Suspend,
    orElse: () => null,
  });

  LowAlch.match(from).on({
    Loading: () => null,
    Retrying: () => null,
    Ready: () => null,
    // @ts-expect-error nor `orElse`, which receives the typed errors
    orElse: LowAlch.Suspend,
  });

  return null;
}

class OptionalNotes extends Domain.Query("OptionalNotes", {
  input: { account: Schema.String },
  success: Schema.NullOr(Schema.Struct({ Items: Schema.Array(Note) })),
  rejects: [QueryRefused],
}) {}

class MaybeNotes extends Domain.Query("MaybeNotes", {
  input: { account: Schema.String },
  success: Schema.NullOr(Schema.Array(Note)),
  rejects: [QueryRefused],
}) {}

type ReadMethods<T> = Extract<keyof T, string>;

type SourceErrors<Accessor> = Accessor extends (...args: never) => LowAlch.Source<infer Row>
  ? LowAlch.ErrorsOf<Row>
  : never;

/** Every read step keeps the query's input and errors and uses the current entry type. */
export function ReadBuilder(otherRow: Book) {
  const start = LowAlch.read(Notes);
  const selected = LowAlch.read(NotesByTitle).rows((answer) => answer.Items);
  const all = start.all();
  const where = LowAlch.read(NotesByBook).where((row, input) => {
    expectTypeOf(row).toEqualTypeOf<Note>();
    expectTypeOf(input).toEqualTypeOf<LowAlch.QueryInput<typeof NotesByBook>>();

    return row.BookId === input.BookId;
  });
  const one = LowAlch.read(NoteById).one((row, input) => row.NoteId === input.NoteId);

  expectTypeOf<ReadMethods<typeof start>>().toEqualTypeOf<
    "rows" | "where" | "one" | "all" | "follows"
  >();
  expectTypeOf<ReadMethods<typeof selected>>().toEqualTypeOf<"where" | "one" | "all" | "follows">();
  expectTypeOf<ReadMethods<typeof all>>().toBeNever();
  expectTypeOf<ReadMethods<typeof where>>().toBeNever();
  expectTypeOf<ReadMethods<typeof one>>().toBeNever();

  const subsets = LowAlch.collection(NoteRows, {
    queries: {
      read: start,
      bare: Notes,
      page: selected,
      list: all,
      where,
      one,
      selectedAll: selected.all(),
      selectedWhere: selected.where((row, input) => {
        expectTypeOf(row).toEqualTypeOf<Note>();
        expectTypeOf(input).toEqualTypeOf<LowAlch.QueryInput<typeof NotesByTitle>>();

        return row.account === input.account;
      }),
      selectedOne: selected.one((row, input) => {
        expectTypeOf(row).toEqualTypeOf<Note>();
        expectTypeOf(input).toEqualTypeOf<LowAlch.QueryInput<typeof NotesByTitle>>();

        return row.account === input.account;
      }),
      optional: LowAlch.read(OptionalNotes).rows((answer) => {
        expectTypeOf(answer).toEqualTypeOf<{ readonly Items: ReadonlyArray<Note> }>();

        return answer.Items;
      }),
    },
  });

  expectTypeOf(subsets.list).toEqualTypeOf<LowAlch.Subsets<typeof NoteRows, typeof Notes>>();
  expectTypeOf(subsets.read).toEqualTypeOf<typeof subsets.bare>();
  expectTypeOf(subsets.page).toEqualTypeOf<LowAlch.Subsets<typeof NoteRows, typeof NotesByTitle>>();
  expectTypeOf(subsets.selectedAll).toEqualTypeOf<typeof subsets.page>();
  expectTypeOf(subsets.selectedWhere).toEqualTypeOf<typeof subsets.page>();
  expectTypeOf(subsets.selectedOne).toEqualTypeOf<typeof subsets.page>();

  type Subsets = typeof subsets;
  expectTypeOf<{ -readonly [K in keyof Subsets]: SourceErrors<Subsets[K]> }>().toEqualTypeOf<
    Record<keyof Subsets, Read>
  >();

  const combined = useLiveQuery((q) =>
    q.from({ note: subsets.selectedWhere({ account: "a", Offset: 0, Limit: 10 }) }),
  );

  LowAlch.match(combined).on({
    Loading: () => null,
    Retrying: () => null,
    Ready: ({ data }) => data.map((row) => row.NoteId),
    QueryRefused: (error) => expectTypeOf(error).toEqualTypeOf<QueryRefused>(),
    RpcClientError: (error) => expectTypeOf(error).toEqualTypeOf<RpcClientError>(),
  });

  // @ts-expect-error the selected and filtered read still requires its typed rejection
  LowAlch.match(combined).on({
    Loading: () => null,
    Retrying: () => null,
    Ready: () => null,
    RpcClientError: () => null,
  });

  // @ts-expect-error rows can be selected only once
  selected.rows(() => []);

  // @ts-expect-error all completes the declaration
  all.where(() => true);

  // @ts-expect-error where completes the declaration
  where.one(() => true);

  // @ts-expect-error one completes the declaration
  one.all();

  const cursor = LowAlch.read(NotesByCursor);
  const paged = cursor.rows((answer) => answer.entries);

  expectTypeOf<ReadMethods<typeof cursor>>().toEqualTypeOf<"rows" | "where" | "one" | "follows">();
  expectTypeOf<ReadMethods<typeof paged>>().toEqualTypeOf<"where" | "one" | "follows">();

  const pages = LowAlch.collection(NoteRows, {
    queries: { byCursor: paged.where((row, input) => row.account === input.account) },
  });

  expectTypeOf(pages.byCursor).toEqualTypeOf<
    LowAlch.Subsets<typeof NoteRows, typeof NotesByCursor>
  >();
  expectTypeOf<SourceErrors<typeof pages.byCursor>>().toEqualTypeOf<Read>();
  pages.byCursor({ account: "a" }, { after: "2", take: 10 });

  // @ts-expect-error a page cannot be the whole list
  cursor.all();

  // @ts-expect-error wrapping a page does not make it the whole list
  paged.all();

  // @ts-expect-error a note row has no Items field
  start.where((row) => row.Items.length > 0);

  // @ts-expect-error the input of Notes has no NoteId
  start.where((row, input) => row.NoteId === input.NoteId);

  // @ts-expect-error a rule must return a boolean
  start.one((row) => row.NoteId);

  // @ts-expect-error the rule reads the selected note, not the answer containing Items
  selected.where((row) => row.Items.length > 0);

  // @ts-expect-error the selector receives the wrapped answer, not a note
  LowAlch.read(OptionalNotes).rows((answer) => answer.title);

  // @ts-expect-error the selector only receives non-null answers
  LowAlch.read(OptionalNotes).rows((_answer: null) => []);

  // @ts-expect-error the selector must return an array of rows
  LowAlch.read(OptionalNotes).rows((answer) => answer.Items[0]);

  LowAlch.collection(NoteRows, {
    queries: {
      // @ts-expect-error the selected book does not belong to NoteRows
      wrongEntity: LowAlch.read(Notes).rows(() => [otherRow]),
    },
  });

  LowAlch.collection(NoteRows, {
    queries: {
      good: Notes,
      // @ts-expect-error the valid sibling does not mask selecting strings and adding a rule
      bad: LowAlch.read(NotesByTitle)
        .rows((answer) => answer.Items.map((row) => row.title))
        .where((row) => row.length > 0),
    },
  });

  LowAlch.collection(NoteRows, {
    queries: {
      // @ts-expect-error the default entry is still checked when using all
      bad: LowAlch.read(NoteStats).all(),
    },
  });
  LowAlch.collection(NoteRows, {
    queries: {
      // @ts-expect-error the feed delivers notes, which have no `extra` for the rule to read
      widened: LowAlch.read(NotesByTitle)
        .rows((answer) => answer.Items.map((row) => ({ ...row, extra: "x" })))
        .where((row) => row.extra.startsWith("x")),
    },
  });

  LowAlch.collection(NoteRows, {
    queries: {
      // @ts-expect-error a rule over another entity's row is not saved by selecting no rows
      empty: LowAlch.read(NotesByTitle)
        .rows(() => [])
        .where((row: Book) => row.name.length > 0),
    },
  });

  LowAlch.collection(NoteRows, {
    queries: {
      // @ts-expect-error the same holds for a single row
      widenedOne: LowAlch.read(NotesByTitle)
        .rows((answer) => answer.Items.map((row) => ({ ...row, extra: "x" })))
        .one((row) => row.extra === "x"),
    },
  });

  // Rows with extra fields are fine while the query decides: no rule reads them.
  LowAlch.collection(NoteRows, {
    queries: {
      widened: LowAlch.read(NotesByTitle).rows((answer) =>
        answer.Items.map((row) => ({ ...row, extra: "x" })),
      ),
      widenedAll: LowAlch.read(NotesByTitle)
        .rows((answer) => answer.Items.map((row) => ({ ...row, extra: "x" })))
        .all(),
      // An answer that may be `null` holds the same rows as one that may not.
      maybe: MaybeNotes,
      maybeAll: LowAlch.read(MaybeNotes).all(),
    },
  });
}

/** Commands: input-only calls typed from the Domain definitions, `onRejected` checked. */
export function Commands() {
  type Errors = LowAlch.ErrorOf<typeof RenameNote>;

  expectTypeOf<Errors["_tag"]>().toEqualTypeOf<"NoteMissing" | "NoteLocked" | "RpcClientError">();

  notes.rename(
    { NoteId: "n", title: "t" },
    {
      onRejected: {
        NoteLocked: (error) => expectTypeOf(error.title).toEqualTypeOf<string>(),
        [LowAlch.anyOf("NoteMissing", "RpcClientError")]: () => null,
      },
    },
  );

  notes.rename(
    { NoteId: "n", title: "t" },
    // @ts-expect-error missing rejections without `orElse`: NoteMissing, RpcClientError
    { onRejected: { NoteLocked: () => null } },
  );

  notes.rename(
    { NoteId: "n", title: "t" },
    // @ts-expect-error a rejection RenameNote cannot fail with
    { onRejected: { NoteExists: () => null, orElse: () => null } },
  );

  // @ts-expect-error the target is declared on the Rows entity, never passed at a call site
  notes.rename({ NoteId: "n", title: "t", target: "n" });

  // @ts-expect-error the previous `{ target, input }` call shape is gone
  notes.rename({ target: "n", input: { NoteId: "n", title: "t" } });

  // @ts-expect-error the input of CreateNote requires a title
  notes.create({ account: "a", BookId: "b" });

  // @ts-expect-error the input of NoteById is `{ NoteId }`
  notes.get({ id: "n" });

  // A create's transaction holds the created key; other transactions do not claim one.
  const created = notes.create({ account: "a", BookId: "b", title: "t" });

  expectTypeOf(LowAlch.created(created)).toEqualTypeOf<string>();

  // @ts-expect-error only an `inserts` transaction holds a created key
  LowAlch.created(notes.rename({ NoteId: "n", title: "t" }));

  expectTypeOf(notes.rename.effect)
    .parameter(0)
    .toEqualTypeOf<LowAlch.InputOf<typeof RenameNote>>();

  expectTypeOf(notes.rename.effect).returns.toEqualTypeOf<
    import("effect").Effect.Effect<LowAlch.Settled<void>, Errors>
  >();

  return null;
}

/** A command whose input has no field named like the note key. */
class Retitle extends Domain.Command("Retitle", {
  target: Schema.String,
  input: { title: Schema.String },
}) {}

/** A command whose target type is branded: a plain string target does not fit it. */
const Address = Schema.String.pipe(Schema.brand("NoteAddress"));

class BrandedRename extends Domain.Command("BrandedRename", {
  target: Address,
  input: { NoteId: Schema.String, title: Schema.String },
}) {}

/** A singleton aggregate's command: its target schema is one literal. */
class RefreshAll extends Domain.Command("RefreshAll", {
  target: Schema.Literal("all"),
}) {}

/** Declarations: rows, queries, keys and targets are checked against the entity. */
export const Declarations = () => {
  LowAlch.collection(NoteRows, {
    queries: {
      // @ts-expect-error NoteStats answers `{ count }`, not notes
      stats: NoteStats,
    },
  });

  LowAlch.collection(NoteRows, {
    queries: { get: NoteById },
    commands: {
      // @ts-expect-error the pending row is missing note fields
      create: LowAlch.inserts(CreateNote, { row: (input) => ({ title: input.title }) }),
    },
  });

  LowAlch.collection(NoteRows, {
    queries: { get: NoteById },
    commands: {
      // @ts-expect-error Retitle's input has no NoteId and declares no `key`
      retitle: LowAlch.updates(Retitle),
      // @ts-expect-error the same for a delete
      drop: LowAlch.deletes(Retitle),
      // @ts-expect-error the same for a custom edit
      edit: LowAlch.edits(Retitle, { change: (draft) => draft }),
      // @ts-expect-error the same for a bare command
      bare: Retitle,
      // A declared key (or target) is enough.
      keyed: LowAlch.updates(Retitle, { key: (input) => input.title }),
      sent: LowAlch.sends(Retitle, { key: (input) => input.title }),
      // An `inserts` key is a fresh id by default: no key field is needed.
      create: LowAlch.inserts(Retitle, {
        row: (input, key) => ({
          NoteId: key,
          account: "a",
          BookId: "b",
          title: input.title,
          pinned: false,
        }),
      }),
    },
  });

  LowAlch.collection(NoteRows, {
    queries: { get: NoteById },
    commands: {
      // @ts-expect-error the entity's target is a plain string, not BrandedRename's NoteAddress
      rename: LowAlch.updates(BrandedRename),
      // A per-command target of the command's own target type is accepted.
      renamed: LowAlch.updates(BrandedRename, {
        target: (input, scope) => Address.make(JSON.stringify([scope, input.NoteId])),
      }),
    },
  });

  // @ts-expect-error a per-command target must return the command's target type
  LowAlch.updates(RenameNote, { target: () => 1 });

  // @ts-expect-error a key reads the command's input: PinNote has no title
  LowAlch.edits(PinNote, { key: (input) => input.title, change: () => {} });

  // @ts-expect-error `updates` takes `key` and `target` only
  LowAlch.updates(RenameNote, { keys: () => "n" });

  LowAlch.Rows("BadTarget", {
    feed: NotebookChanges,
    row: Note,
    key: "NoteId",
    from: [NoteAggregate],
    scope: () => undefined,
    // @ts-expect-error an entity's target is a string
    target: (key: string) => key.length,
    on: {},
  });

  LowAlch.Projection("Elsewhere", {
    feed: NotebookChanges,
    // @ts-expect-error every entity of a feed's projection is on that feed
    entities: [NoteRows, EntryRows],
  });

  // A guarded feed's read errors reach its entity's rows: its rejections and transport.
  expectTypeOf<LowAlch.FeedError<typeof EntryRows>>().toEqualTypeOf<NotYours | RpcClientError>();

  // An unguarded feed fails only in transport.
  expectTypeOf<LowAlch.FeedError<typeof NoteRows>>().toEqualTypeOf<RpcClientError>();

  // @ts-expect-error a command outside an entity declares its target
  LowAlch.command(RenameNote);

  LowAlch.command(RenameNote, { target: (input, scope) => `${scope}/${input.NoteId}` });

  // @ts-expect-error the target function returns the command's target type
  LowAlch.command(BrandedRename, { target: (input) => input.NoteId });

  // A singleton aggregate's one literal target needs no declaration.
  LowAlch.command(RefreshAll);

  return null;
};

it("type-level transitions compile", () => {
  expect([Recovered, ReadBuilder, Commands, Declarations]).toHaveLength(4);
});
