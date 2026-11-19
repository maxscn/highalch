import { expect, expectTypeOf, it } from "vite-plus/test";
import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";
import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as HighAlch from "@highalch/db";
import {
  CreateNote,
  NoteAggregate,
  NoteById,
  NotebookChanges,
  NoteRows,
  Note,
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
    readonly errors: HighAlch.ApiErrors<typeof NotesApi>;
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

  // A field projection drops the marker: the registered floor applies.
  const fields = useLiveQuery((q) =>
    q.from({ note: notes.list({ account: "a" }) }).select(({ note }) => ({ id: note.NoteId })),
  );

  expectTypeOf<HighAlch.ErrorsOf<typeof fields.data>>().toEqualTypeOf<
    HighAlch.ApiErrors<typeof NotesApi>
  >();

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

  return null;
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
  expect([Recovered, Commands, Declarations]).toHaveLength(3);
});
