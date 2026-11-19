import { expect, expectTypeOf, it } from "vite-plus/test";
import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";
import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as HighAlch from "@highalch/db";
import {
  Books,
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
} from "../../../fixtures/notebook";
import { notes } from "../../../fixtures/notes";
import { EntryRows, NotYours } from "../../../fixtures/ledger";

/**
 * The application registers its floor once: a live query whose projection drops the row marker
 * can fail with any read error of its Api.
 */
declare module "@highalch/db" {
  interface Register {
    readonly errors: HighAlch.ApiErrors<typeof NotesApi> | NotYours;
  }
}

type Read = QueryRefused | RpcClientError;

/** Type-level transitions only: none of these components is rendered. */
export function Recovered() {
  const from = useLiveQuery((q) => q.from({ note: notes.list({ account: "a" }) }));

  expectTypeOf<HighAlch.ErrorsOf<typeof from.data>>().toEqualTypeOf<Read>();

  const where = useLiveQuery((q) =>
    q
      .from({ note: notes.byBook({ BookId: "b" }) })
      .where(({ note }) => eq(note.pinned, true))
      .orderBy(({ note }) => note.title)
      .limit(3),
  );

  expectTypeOf<HighAlch.ErrorsOf<typeof where.data>>().toEqualTypeOf<Read>();

  const joined = useLiveQuery((q) =>
    q
      .from({ note: notes.list({ account: "a" }) })
      .leftJoin({ book: notes.byBook({ BookId: "b" }) }, ({ note, book }) =>
        eq(note.NoteId, book.NoteId),
      ),
  );

  expectTypeOf<HighAlch.ErrorsOf<typeof joined.data>>().toEqualTypeOf<Read>();

  const one = useLiveQuery((q) => q.from({ note: notes.get({ NoteId: "n" }) }).findOne());

  expectTypeOf<HighAlch.ErrorsOf<typeof one.data>>().toEqualTypeOf<Read>();

  const whole = useLiveQuery((q) =>
    q.from({ note: notes.list({ account: "a" }) }).select(({ note }) => note),
  );

  expectTypeOf<HighAlch.ErrorsOf<typeof whole.data>>().toEqualTypeOf<Read>();

  const spread = useLiveQuery((q) =>
    q
      .from({ note: notes.list({ account: "a" }) })
      .select(({ note }) => ({ ...note, heading: note.title })),
  );

  expectTypeOf<HighAlch.ErrorsOf<typeof spread.data>>().toEqualTypeOf<Read>();

  // A non-entity result whose field is an open record (a page cursor) keeps its own errors.
  type Page = HighAlch.Marked<
    { readonly Items: ReadonlyArray<Note>; readonly After?: Record<string, number> },
    Read
  >;

  expectTypeOf<HighAlch.ErrorsOf<Page | undefined>>().toEqualTypeOf<Read>();

  // A field projection drops the marker: the registered floor applies.
  const fields = useLiveQuery((q) =>
    q.from({ note: notes.list({ account: "a" }) }).select(({ note }) => ({ id: note.NoteId })),
  );

  expectTypeOf<HighAlch.Floor>().toEqualTypeOf<Read | NotYours>();
  expectTypeOf<HighAlch.ErrorsOf<typeof fields.data>>().toEqualTypeOf<Read | NotYours>();

  // @ts-expect-error dropping the marker means the extra floor rejection, NotYours, is required
  HighAlch.match(fields).on({
    Loading: () => null,
    Retrying: () => null,
    Ready: () => null,
    QueryRefused: () => null,
    RpcClientError: () => null,
  });

  // Exhaustive without `orElse`, with each error as its own state.
  HighAlch.match(from).on({
    Loading: () => null,
    Retrying: () => null,
    Ready: ({ data }) => data.length,
    QueryRefused: (error) => expectTypeOf(error).toEqualTypeOf<QueryRefused>(),
    RpcClientError: (_error, { retry }) => retry,
  });

  // @ts-expect-error a missing state is named: QueryRefused
  HighAlch.match(from).on({
    Loading: () => null,
    Retrying: () => null,
    Ready: () => null,
    RpcClientError: () => null,
  });

  // @ts-expect-error `Missing` is impossible for a many-row query
  HighAlch.match(from).on({
    Ready: () => null,
    Missing: () => null,
    orElse: () => null,
  });

  HighAlch.match(one).on({
    Ready: ({ data }) => expectTypeOf(data.title).toEqualTypeOf<string>(),
    Missing: () => null,
    orElse: () => null,
  });

  // @ts-expect-error a state named twice
  HighAlch.match(from).on({
    [HighAlch.anyOf("Loading", "Retrying")]: () => null,
    Ready: () => null,
    orElse: () => null,
    Loading: () => null,
  });

  // `Suspend` is the Loading handler whatever the others return; the result drops its `never`.
  const suspended = HighAlch.match(from).on({
    Loading: HighAlch.Suspend,
    Retrying: ({ data }) => data.length,
    Ready: ({ data }) => data.map((note) => note.title),
    QueryRefused: () => null,
    RpcClientError: () => "transport" as const,
  });

  expectTypeOf(suspended).toEqualTypeOf<number | Array<string> | null | "transport">();

  // It changes nothing else: still exhaustive, and with `orElse` too.
  // @ts-expect-error a missing state is named: QueryRefused
  HighAlch.match(from).on({
    Loading: HighAlch.Suspend,
    Retrying: () => null,
    Ready: () => null,
    RpcClientError: () => null,
  });

  HighAlch.match(one).on({ Loading: HighAlch.Suspend, Ready: () => null, orElse: () => null });

  // @ts-expect-error `Suspend` handles only `Loading`
  HighAlch.match(from).on({ Loading: () => null, Ready: HighAlch.Suspend, orElse: () => null });

  HighAlch.match(from).on({
    // @ts-expect-error nor a group naming another state
    [HighAlch.anyOf("Loading", "Retrying")]: HighAlch.Suspend,
    orElse: () => null,
  });

  HighAlch.match(from).on({
    Loading: () => null,
    Retrying: () => null,
    Ready: () => null,
    // @ts-expect-error nor `orElse`, which receives the typed errors
    orElse: HighAlch.Suspend,
  });

  return null;
}

class OptionalNotes extends Domain.Query("OptionalNotes", {
  input: { account: Schema.String },
  success: Schema.NullOr(Schema.Struct({ Items: Schema.Array(Note) })),
  rejects: [QueryRefused],
}) {}

type ReadMethod = "rows" | "where" | "one" | "all";
type ReadMethods<T> = Extract<keyof T, ReadMethod>;

type SourceErrors<Accessor> = Accessor extends (...args: never) => HighAlch.Source<infer Row>
  ? HighAlch.ErrorsOf<Row>
  : never;

/** Every read step keeps the query's input and errors and uses the current entry type. */
export function ReadBuilder() {
  const start = HighAlch.read(Notes);
  const selected = HighAlch.read(NotesByTitle).rows((answer) => answer.Items);
  const all = start.all();
  const where = HighAlch.read(NotesByBook).where((row, input) => {
    expectTypeOf(row).toEqualTypeOf<Note>();
    expectTypeOf(input).toEqualTypeOf<HighAlch.QueryInput<typeof NotesByBook>>();

    return row.BookId === input.BookId;
  });
  const one = HighAlch.read(NoteById).one((row, input) => row.NoteId === input.NoteId);

  expectTypeOf<ReadMethods<typeof start>>().toEqualTypeOf<ReadMethod>();
  expectTypeOf<ReadMethods<typeof selected>>().toEqualTypeOf<"where" | "one" | "all">();
  expectTypeOf<ReadMethods<typeof all>>().toBeNever();
  expectTypeOf<ReadMethods<typeof where>>().toBeNever();
  expectTypeOf<ReadMethods<typeof one>>().toBeNever();

  const subsets = HighAlch.collection(NoteRows, {
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
        expectTypeOf(input).toEqualTypeOf<HighAlch.QueryInput<typeof NotesByTitle>>();

        return row.account === input.account;
      }),
      selectedOne: selected.one((row, input) => {
        expectTypeOf(row).toEqualTypeOf<Note>();
        expectTypeOf(input).toEqualTypeOf<HighAlch.QueryInput<typeof NotesByTitle>>();

        return row.account === input.account;
      }),
      optional: HighAlch.read(OptionalNotes).rows((answer) => {
        expectTypeOf(answer).toEqualTypeOf<{ readonly Items: ReadonlyArray<Note> }>();

        return answer.Items;
      }),
    },
  });

  expectTypeOf(subsets.list).toEqualTypeOf<HighAlch.Subsets<typeof NoteRows, typeof Notes>>();
  expectTypeOf(subsets.read).toEqualTypeOf<typeof subsets.bare>();
  expectTypeOf(subsets.page).toEqualTypeOf<
    HighAlch.Subsets<typeof NoteRows, typeof NotesByTitle>
  >();
  expectTypeOf(subsets.selectedAll).toEqualTypeOf<typeof subsets.page>();
  expectTypeOf(subsets.selectedWhere).toEqualTypeOf<typeof subsets.page>();
  expectTypeOf(subsets.selectedOne).toEqualTypeOf<typeof subsets.page>();

  type Subsets = typeof subsets;
  expectTypeOf<{ -readonly [K in keyof Subsets]: SourceErrors<Subsets[K]> }>().toEqualTypeOf<
    Record<keyof Subsets, Read>
  >();

  // @ts-expect-error rows can be selected only once
  selected.rows(() => []);

  // @ts-expect-error all completes the declaration
  all.where(() => true);

  // @ts-expect-error where completes the declaration
  where.one(() => true);

  // @ts-expect-error one completes the declaration
  one.all();

  const cursor = HighAlch.read(NotesByCursor);
  const paged = cursor.rows((answer) => answer.entries);

  expectTypeOf<ReadMethods<typeof cursor>>().toEqualTypeOf<"rows" | "where" | "one">();
  expectTypeOf<ReadMethods<typeof paged>>().toEqualTypeOf<"where" | "one">();

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
  HighAlch.read(OptionalNotes).rows((answer) => answer.title);

  // @ts-expect-error the selector must return an array of rows
  HighAlch.read(OptionalNotes).rows((answer) => answer.Items[0]);

  HighAlch.collection(NoteRows, {
    queries: {
      // @ts-expect-error Books selects another entity's rows
      wrongEntity: HighAlch.read(Books).rows((answer) => answer),
    },
  });

  HighAlch.collection(NoteRows, {
    queries: {
      good: Notes,
      // @ts-expect-error the valid sibling does not mask selecting strings and adding a rule
      bad: HighAlch.read(NotesByTitle)
        .rows((answer) => answer.Items.map((row) => row.title))
        .where((row) => row.length > 0),
    },
  });

  HighAlch.collection(NoteRows, {
    queries: {
      // @ts-expect-error the default entry is still checked when using all
      bad: HighAlch.read(NoteStats).all(),
    },
  });
}

/** Commands: input-only calls typed from the Domain definitions, `onRejected` checked. */
export function Commands() {
  type Errors = HighAlch.ErrorOf<typeof RenameNote>;

  expectTypeOf<Errors["_tag"]>().toEqualTypeOf<"NoteMissing" | "NoteLocked" | "RpcClientError">();

  notes.rename(
    { NoteId: "n", title: "t" },
    {
      onRejected: {
        NoteLocked: (error) => expectTypeOf(error.title).toEqualTypeOf<string>(),
        [HighAlch.anyOf("NoteMissing", "RpcClientError")]: () => null,
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

  expectTypeOf(HighAlch.created(created)).toEqualTypeOf<string>();

  // @ts-expect-error only an `inserts` transaction holds a created key
  HighAlch.created(notes.rename({ NoteId: "n", title: "t" }));

  expectTypeOf(notes.rename.effect)
    .parameter(0)
    .toEqualTypeOf<HighAlch.InputOf<typeof RenameNote>>();

  expectTypeOf(notes.rename.effect).returns.toEqualTypeOf<
    import("effect").Effect.Effect<HighAlch.Settled<void>, Errors>
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
  // @ts-expect-error NoteStats answers `{ count }`, not notes
  HighAlch.collection(NoteRows, { queries: { stats: NoteStats } });

  HighAlch.collection(NoteRows, {
    queries: { get: NoteById },
    commands: {
      // @ts-expect-error the pending row is missing note fields
      create: HighAlch.inserts(CreateNote, { row: (input) => ({ title: input.title }) }),
    },
  });

  HighAlch.collection(NoteRows, {
    queries: { get: NoteById },
    commands: {
      // @ts-expect-error Retitle's input has no NoteId and declares no `key`
      retitle: HighAlch.updates(Retitle),
      // @ts-expect-error the same for a delete
      drop: HighAlch.deletes(Retitle),
      // @ts-expect-error the same for a custom edit
      edit: HighAlch.edits(Retitle, { change: (draft) => draft }),
      // @ts-expect-error the same for a bare command
      bare: Retitle,
      // A declared key (or target) is enough.
      keyed: HighAlch.updates(Retitle, { key: (input) => input.title }),
      sent: HighAlch.sends(Retitle, { key: (input) => input.title }),
      // An `inserts` key is a fresh id by default: no key field is needed.
      create: HighAlch.inserts(Retitle, {
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

  HighAlch.collection(NoteRows, {
    queries: { get: NoteById },
    commands: {
      // @ts-expect-error the entity's target is a plain string, not BrandedRename's NoteAddress
      rename: HighAlch.updates(BrandedRename),
      // A per-command target of the command's own target type is accepted.
      renamed: HighAlch.updates(BrandedRename, {
        target: (input, scope) => Address.make(JSON.stringify([scope, input.NoteId])),
      }),
    },
  });

  // @ts-expect-error a per-command target must return the command's target type
  HighAlch.updates(RenameNote, { target: () => 1 });

  // @ts-expect-error a key reads the command's input: PinNote has no title
  HighAlch.edits(PinNote, { key: (input) => input.title, change: () => {} });

  // @ts-expect-error `updates` takes `key` and `target` only
  HighAlch.updates(RenameNote, { keys: () => "n" });

  HighAlch.Rows("BadTarget", {
    feed: NotebookChanges,
    row: Note,
    key: "NoteId",
    from: [NoteAggregate],
    scope: () => undefined,
    // @ts-expect-error an entity's target is a string
    target: (key: string) => key.length,
    on: {},
  });

  HighAlch.Projection("Elsewhere", {
    feed: NotebookChanges,
    // @ts-expect-error every entity of a feed's projection is on that feed
    entities: [NoteRows, EntryRows],
  });

  // A guarded feed's read errors reach its entity's rows: its rejections and transport.
  expectTypeOf<HighAlch.FeedError<typeof EntryRows>>().toEqualTypeOf<NotYours | RpcClientError>();

  // An unguarded feed fails only in transport.
  expectTypeOf<HighAlch.FeedError<typeof NoteRows>>().toEqualTypeOf<RpcClientError>();

  // @ts-expect-error a command outside an entity declares its target
  HighAlch.command(RenameNote);

  HighAlch.command(RenameNote, { target: (input, scope) => `${scope}/${input.NoteId}` });

  // @ts-expect-error the target function returns the command's target type
  HighAlch.command(BrandedRename, { target: (input) => input.NoteId });

  // A singleton aggregate's one literal target needs no declaration.
  HighAlch.command(RefreshAll);

  return null;
};

it("type-level transitions compile", () => {
  expect([Recovered, ReadBuilder, Commands, Declarations]).toHaveLength(4);
});
