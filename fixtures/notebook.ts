import * as Domain from "@alchemy.run/domain";
import {
  Context,
  Deferred,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Predicate,
  Schema,
  Stream,
} from "effect";
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError";
import * as InMemory from "@alchemy.run/domain/InMemory";
import * as HighAlch from "@highalch/db";

/**
 * A small self-contained Domain for the HighAlch packages' tests: notes and books, per account, on one
 * feed (`NotebookChanges`) written by one projection. Every event carries the whole row after it,
 * so the feed's entries carry rows. A note's aggregate id is `[account, NoteId]` as JSON (not its
 * row key, as an aggregate keyed per scope is); a book's is its row key.
 */
export const Note = Schema.Struct({
  NoteId: Schema.String,
  account: Schema.String,
  BookId: Schema.String,
  title: Schema.String,
  pinned: Schema.Boolean,
});

export type Note = typeof Note.Type;

/** A note aggregate's id: the account and the note's key, as JSON. */
export const address = (account: string, NoteId: string) => JSON.stringify([account, NoteId]);

const Address = Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String]));

/** The note key an aggregate id holds. */
const noteIdOf = (id: string) => Schema.decodeUnknownSync(Address)(id)[1];

export class NoteCreated extends Domain.Event("NoteCreated", { note: Note }) {}

export class NoteChanged extends Domain.Event("NoteChanged", { note: Note }) {}

export class NoteDeleted extends Domain.Event("NoteDeleted", {
  NoteId: Schema.String,
  account: Schema.String,
}) {}

export class NoteExists extends Domain.Rejection("NoteExists") {}

export class NoteMissing extends Domain.Rejection("NoteMissing") {}

export class NoteLocked extends Domain.Rejection("NoteLocked", { title: Schema.String }) {}

export class QueryRefused extends Domain.Rejection("QueryRefused") {}

export class CreateNote extends Domain.Command("CreateNote", {
  target: Schema.String,
  input: { account: Schema.String, BookId: Schema.String, title: Schema.String },
  events: [NoteCreated],
  rejects: [NoteExists],
}) {}

export class RenameNote extends Domain.Command("RenameNote", {
  target: Schema.String,
  input: { NoteId: Schema.String, title: Schema.String },
  events: [NoteChanged],
  rejects: [NoteMissing, NoteLocked],
}) {}

export class MoveNote extends Domain.Command("MoveNote", {
  target: Schema.String,
  input: { NoteId: Schema.String, BookId: Schema.String },
  events: [NoteChanged],
  rejects: [NoteMissing],
}) {}

export class PinNote extends Domain.Command("PinNote", {
  target: Schema.String,
  input: { NoteId: Schema.String, pinned: Schema.Boolean },
  events: [NoteChanged],
  rejects: [NoteMissing],
}) {}

export class DeleteNote extends Domain.Command("DeleteNote", {
  target: Schema.String,
  input: { NoteId: Schema.String },
  events: [NoteDeleted],
  rejects: [NoteMissing],
}) {}

/** Accepted and changes nothing: a command with no rows to edit. */
export class TouchNote extends Domain.Command("TouchNote", {
  target: Schema.String,
  input: { NoteId: Schema.String },
  reply: { touched: Schema.Boolean },
}) {}

const NoteState = Schema.Struct({ note: Schema.NullOr(Note) });

const changed = (state: typeof NoteState.Type, change: Partial<Note>) =>
  Option.match(Option.fromNullishOr(state.note), {
    onNone: () => new NoteMissing(),
    onSome: (note) => [new NoteChanged({ note: { ...note, ...change } })],
  });

export class NoteAggregate extends Domain.Aggregate("Note", {
  id: Schema.String,
  state: NoteState,
  initial: { note: null },
  commands: [CreateNote, RenameNote, MoveNote, PinNote, DeleteNote, TouchNote],
  decide: {
    CreateNote: (state, command, { id }) => {
      if (state.note) return new NoteExists();

      const { account, BookId, title } = command;
      const NoteId = noteIdOf(id);

      return [new NoteCreated({ note: { NoteId, account, BookId, title, pinned: false } })];
    },
    RenameNote: (state, command) => {
      if (command.title === "locked") return new NoteLocked({ title: command.title });

      return changed(state, { title: command.title });
    },
    MoveNote: (state, command) => changed(state, { BookId: command.BookId }),
    PinNote: (state, command) => changed(state, { pinned: command.pinned }),
    DeleteNote: (state) =>
      Option.match(Option.fromNullishOr(state.note), {
        onNone: () => new NoteMissing(),
        onSome: (note) => [new NoteDeleted({ NoteId: note.NoteId, account: note.account })],
      }),
    TouchNote: () => [],
  },
  evolve: {
    NoteCreated: (_state, event) => ({ note: event.note }),
    NoteChanged: (_state, event) => ({ note: event.note }),
    NoteDeleted: () => ({ note: null }),
  },
  reply: { TouchNote: () => ({ touched: true }) },
}) {}

/** The feed: one stream per account, carrying both entities' rows. */
export class NotebookChanges extends HighAlch.Feed("NotebookChanges", { scope: Schema.String }) {}

/** The first entity on the feed: notes, whose commands address `[account, NoteId]`. */
export class NoteRows extends HighAlch.Rows("NoteRows", {
  feed: NotebookChanges,
  row: Note,
  key: "NoteId",
  from: [NoteAggregate],
  scope: ({ event }) =>
    Predicate.isTagged(event, "NoteDeleted") ? event.account : event.note.account,
  target: (key, scope) => address(scope, key),
  on: {
    NoteCreated: (event) => HighAlch.upserted(event.note),
    NoteChanged: (event) => HighAlch.upserted(event.note),
    NoteDeleted: (event) => HighAlch.removed(event.NoteId),
  },
}) {}

/** A book: the second entity, whose commands address its row key (the default target). */
export const Book = Schema.Struct({
  BookId: Schema.String,
  account: Schema.String,
  name: Schema.String,
});

export type Book = typeof Book.Type;

export class BookCreated extends Domain.Event("BookCreated", { book: Book }) {}

export class BookRenamed extends Domain.Event("BookRenamed", { book: Book }) {}

export class BookMissing extends Domain.Rejection("BookMissing") {}

export class CreateBook extends Domain.Command("CreateBook", {
  target: Schema.String,
  input: { account: Schema.String, name: Schema.String },
  events: [BookCreated],
}) {}

export class RenameBook extends Domain.Command("RenameBook", {
  target: Schema.String,
  input: { BookId: Schema.String, name: Schema.String },
  events: [BookRenamed],
  rejects: [BookMissing],
}) {}

export class BookAggregate extends Domain.Aggregate("Book", {
  id: Schema.String,
  state: Schema.Struct({ book: Schema.NullOr(Book) }),
  initial: { book: null },
  commands: [CreateBook, RenameBook],
  decide: {
    CreateBook: (_state, command, { id }) => [
      new BookCreated({ book: { BookId: id, account: command.account, name: command.name } }),
    ],
    RenameBook: (state, command) =>
      Option.match(Option.fromNullishOr(state.book), {
        onNone: () => new BookMissing(),
        onSome: (book) => [new BookRenamed({ book: { ...book, name: command.name } })],
      }),
  },
  evolve: {
    BookCreated: (_state, event) => ({ book: event.book }),
    BookRenamed: (_state, event) => ({ book: event.book }),
  },
}) {}

/** The second entity on the same feed: no `target`, so a book command addresses its key. */
export class BookRows extends HighAlch.Rows("BookRows", {
  feed: NotebookChanges,
  row: Book,
  key: "BookId",
  from: [BookAggregate],
  scope: ({ event }) => event.book.account,
  on: {
    BookCreated: (event) => HighAlch.upserted(event.book),
    BookRenamed: (event) => HighAlch.upserted(event.book),
  },
}) {}

/** The feed's one writer: both entities, one line each. */
export class NotebookWriter extends HighAlch.Projection("NotebookChanges", {
  feed: NotebookChanges,
  entities: [NoteRows, BookRows],
}) {}

/** The store the queries answer from, written by the `NoteIndex` and `BookIndex` projections. */
export class NoteStore extends Context.Service<
  NoteStore,
  {
    readonly notes: Map<string, Note>;
    readonly books: Map<string, Book>;
    /** Query names that fail with `QueryRefused` while listed. */
    readonly refuse: Set<string>;
    /** Query names that die (a defect, not a typed failure) while listed. */
    readonly crash: Set<string>;
    /** Held before every query answers (e.g. to race a write against a load). */
    gate: Effect.Effect<void>;
    /** Every query asked, by name. */
    readonly asked: Array<string>;
  }
>()("Test/NoteStore") {}

export class NoteIndex extends Domain.Projection("NoteIndex", {
  from: [NoteAggregate],
  key: NoteAggregate,
  on: [NoteCreated, NoteChanged, NoteDeleted],
}) {}

const NoteIndexLive = NoteIndex.toLayer(
  Effect.gen(function* () {
    const store = yield* NoteStore;

    return (batch) =>
      Effect.sync(() => {
        for (const { event } of batch)
          if (Predicate.isTagged(event, "NoteDeleted")) store.notes.delete(event.NoteId);
          else store.notes.set(event.note.NoteId, event.note);
      });
  }),
);

export class BookIndex extends Domain.Projection("BookIndex", {
  from: [BookAggregate],
  key: BookAggregate,
  on: [BookCreated, BookRenamed],
}) {}

const BookIndexLive = BookIndex.toLayer(
  Effect.gen(function* () {
    const store = yield* NoteStore;

    return (batch) =>
      Effect.sync(() => {
        for (const { event } of batch) store.books.set(event.book.BookId, event.book);
      });
  }),
);

export class Books extends Domain.Query("Books", {
  input: { account: Schema.String },
  success: Schema.Array(Book),
}) {}

const BooksLive = Books.toLayer(
  Effect.gen(function* () {
    const store = yield* NoteStore;

    return ({ account }) =>
      Effect.sync(() => [...store.books.values()].filter((book) => book.account === account));
  }),
);

export class Notes extends Domain.Query("Notes", {
  input: { account: Schema.String },
  success: Note,
  paged: true,
  rejects: [QueryRefused],
}) {}

export class NoteById extends Domain.Query("NoteById", {
  input: { NoteId: Schema.String },
  success: Schema.NullOr(Note),
  rejects: [QueryRefused],
}) {}

export class NotesByBook extends Domain.Query("NotesByBook", {
  input: { BookId: Schema.String },
  success: Schema.Array(Note),
  rejects: [QueryRefused],
}) {}

export class NotesByTitle extends Domain.Query("NotesByTitle", {
  input: { account: Schema.String, Offset: Schema.Number, Limit: Schema.Number },
  success: Schema.Struct({ Items: Schema.Array(Note) }),
  rejects: [QueryRefused],
}) {}

export class NoteStats extends Domain.Query("NoteStats", {
  input: { account: Schema.String },
  success: Schema.Struct({ count: Schema.Number }),
  rejects: [QueryRefused],
}) {}

type Store = typeof NoteStore.Service;

/** Answers one query from the store, held by its gate and refused while its name is listed. */
const answer = <A>(store: Store, name: string, read: (notes: ReadonlyArray<Note>) => A) =>
  Effect.gen(function* () {
    store.asked.push(name);

    // The answer is read before the gate: a held query answers with what it saw when asked.
    const notes = [...store.notes.values()].sort((a, b) => a.NoteId.localeCompare(b.NoteId));
    const result = read(notes);

    yield* store.gate;

    if (store.refuse.has(name)) return yield* new QueryRefused();

    if (store.crash.has(name)) return yield* Effect.die(new Error(`${name} broke`));

    return result;
  });

const NotesLive = Notes.toLayer(
  Effect.gen(function* () {
    const store = yield* NoteStore;

    return ({ account }, page) =>
      answer(store, "Notes", (notes) => {
        const mine = notes.filter((note) => note.account === account);

        const start = Option.match(Option.fromUndefinedOr(page.after), {
          onNone: () => 0,
          onSome: Number,
        });

        const entries = mine.slice(start, start + page.take);
        const next = start + page.take;

        return { entries, cursor: next < mine.length ? String(next) : null };
      });
  }),
);

const NoteByIdLive = NoteById.toLayer(
  Effect.gen(function* () {
    const store = yield* NoteStore;

    return ({ NoteId }) =>
      answer(store, "NoteById", (notes) => notes.find((note) => note.NoteId === NoteId) ?? null);
  }),
);

const NotesByBookLive = NotesByBook.toLayer(
  Effect.gen(function* () {
    const store = yield* NoteStore;

    return ({ BookId }) =>
      answer(store, "NotesByBook", (notes) => notes.filter((note) => note.BookId === BookId));
  }),
);

const NotesByTitleLive = NotesByTitle.toLayer(
  Effect.gen(function* () {
    const store = yield* NoteStore;

    return ({ account, Offset, Limit }) =>
      answer(store, "NotesByTitle", (notes) => ({
        Items: notes
          .filter((note) => note.account === account)
          .sort((a, b) => a.title.localeCompare(b.title) || a.NoteId.localeCompare(b.NoteId))
          .slice(Offset, Offset + Limit),
      }));
  }),
);

const NoteStatsLive = NoteStats.toLayer(
  Effect.gen(function* () {
    const store = yield* NoteStore;

    return ({ account }) =>
      answer(store, "NoteStats", (notes) => ({
        count: notes.filter((note) => note.account === account).length,
      }));
  }),
);

const queries = [Notes, NoteById, NotesByBook, NotesByTitle, NoteStats, Books] as const;

export class Notebook extends Domain.Model("Notebook", {
  aggregates: [NoteAggregate, BookAggregate],
  projections: [NoteIndex, BookIndex, NotebookWriter],
  streams: [NotebookChanges],
  queries,
}) {}

/** The same model as deployed before the feed existed: its history has no feed entries. */
export class NotebookBefore extends Domain.Model("Notebook", {
  aggregates: [NoteAggregate, BookAggregate],
  projections: [NoteIndex, BookIndex],
  queries,
}) {}

export class NotesApi extends Domain.Api("NotesApi", { model: Notebook }) {}

/** The Api client the package sees. */
export type Client = Domain.Api.ClientOf<typeof NotesApi>;

/**
 * Wraps the in-process client so live reads behave like the websocket protocol where it
 * matters: `cut(error)` fails every open feed (the protocol giving up), `refuse(n, error)` fails
 * the next `n` feed connections, `mute` drops feed entries (a feed that never delivers), `repeat`
 * delivers every entry twice (at-least-once delivery), and `counts` tracks open feeds,
 * connections, cursor reads (`peek`), sent commands and their targets.
 */
const faulty = (client: Client) => {
  const cuts = new Set<Deferred.Deferred<never, RpcClientError>>();
  const refusals: Array<RpcClientError> = [];
  const commands: Array<string> = [];
  const targets: Array<string> = [];
  const counts = { open: 0, connections: 0, peeks: 0, commands, targets };

  /** Records one sent command and the aggregate it addressed. */
  const sent = (name: string, target: string) => {
    commands.push(name);
    targets.push(`${name} ${target}`);
  };

  const muted = { on: false };

  const repeated = { on: false };

  const events: Client["NotebookChanges"]["events"] = (key, options) =>
    Stream.unwrap(
      Effect.gen(function* () {
        counts.connections += 1;

        const refused = refusals.shift();

        if (refused) return Stream.fail(refused);

        const cut = yield* Deferred.make<never, RpcClientError>();

        cuts.add(cut);
        counts.open += 1;

        const frames = client.NotebookChanges.events(key, options).pipe(
          Stream.filter((frame) => !muted.on || Domain.Read.isCaughtUp(frame)),
          Stream.flatMap((frame) =>
            Stream.fromIterable(
              repeated.on && !Domain.Read.isCaughtUp(frame) ? [frame, frame] : [frame],
            ),
          ),
        );

        return Stream.merge(frames, Stream.fromEffect(Deferred.await(cut)), {
          haltStrategy: "either",
        }).pipe(
          Stream.ensuring(
            Effect.sync(() => {
              cuts.delete(cut);
              counts.open -= 1;
            }),
          ),
        );
      }),
    );

  const peek: Client["NotebookChanges"]["peek"] = (key, options) =>
    Effect.suspend(() => {
      counts.peeks += 1;

      return client.NotebookChanges.peek(key, options);
    });

  const wrapped: Client = {
    ...client,
    NotebookChanges: { ...client.NotebookChanges, events, peek },
    CreateNote: (target, input, options) => {
      sent("CreateNote", target);

      return client.CreateNote(target, input, options);
    },
    RenameNote: (target, input, options) => {
      sent("RenameNote", target);

      return client.RenameNote(target, input, options);
    },
    PinNote: (target, input, options) => {
      sent("PinNote", target);

      return client.PinNote(target, input, options);
    },
    DeleteNote: (target, input, options) => {
      sent("DeleteNote", target);

      return client.DeleteNote(target, input, options);
    },
    TouchNote: (target, input, options) => {
      sent("TouchNote", target);

      return client.TouchNote(target, input, options);
    },
    MoveNote: (target, input, options) => {
      sent("MoveNote", target);

      return client.MoveNote(target, input, options);
    },
    CreateBook: (target, input, options) => {
      sent("CreateBook", target);

      return client.CreateBook(target, input, options);
    },
    RenameBook: (target, input, options) => {
      sent("RenameBook", target);

      return client.RenameBook(target, input, options);
    },
  };

  return {
    client: wrapped,
    counts,
    mute: (on: boolean) => {
      muted.on = on;
    },
    repeat: (on: boolean) => {
      repeated.on = on;
    },
    cut: (error = transport()) =>
      Effect.runSync(Effect.forEach([...cuts], (cut) => Deferred.fail(cut, error))),
    refuse: (times: number, error = transport()) => {
      for (let index = 0; index < times; index += 1) refusals.push(error);
    },
  };
};

/** A fresh transport failure, as the websocket protocol reports giving up. */
export const transport = () =>
  new RpcClientError({
    reason: new RpcClientDefect({ message: "socket closed", cause: new Error("socket closed") }),
  });

/** A note as `seed` and `history` create it. */
export type Seed = Omit<Note, "pinned">;

const create = (client: { readonly CreateNote: Client["CreateNote"] }, note: Seed) =>
  client.CreateNote(address(note.account, note.NoteId), {
    account: note.account,
    BookId: note.BookId,
    title: note.title,
  });

/** Resolves once the projection reflects `check`. */
const waitFor = async (
  store: typeof NoteStore.Service,
  check: (notes: Map<string, Note>) => boolean,
) => {
  for (let tries = 0; tries < 200 && !check(store.notes); tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));

  if (!check(store.notes)) throw new Error("The projection did not catch up");
};

/** A fresh, empty store. */
export const emptyStore = () =>
  NoteStore.of({
    notes: new Map(),
    books: new Map(),
    refuse: new Set(),
    crash: new Set(),
    gate: Effect.void,
    asked: [],
  });

/** The model's handlers and its feed writer, over the `NoteStore` service. */
export const notebook = () =>
  Layer.mergeAll(
    NoteIndexLive,
    BookIndexLive,
    NotesLive,
    NoteByIdLive,
    NotesByBookLive,
    NotesByTitleLive,
    NoteStatsLive,
    BooksLive,
    NotebookWriter.layer,
  );

/** A fresh store, as a Layer (a story reads it with `world.host.service(NoteStore)`). */
export const store = () => Layer.sync(NoteStore, emptyStore);

/**
 * Hosts the model in memory and returns a client per account plus the store and controls.
 * `history` notes are created first by `NotebookBefore` (the deployment before the feed existed)
 * on the same platform, so the feed's projection is added to a deployment with history.
 */
export const host = async (options: { readonly history?: ReadonlyArray<Seed> } = {}) => {
  const store = emptyStore();

  const platform = InMemory.make().layer;

  const handlers = Layer.mergeAll(
    NoteIndexLive,
    BookIndexLive,
    NotesLive,
    NoteByIdLive,
    NotesByBookLive,
    NotesByTitleLive,
    NoteStatsLive,
    BooksLive,
  ).pipe(Layer.provide(Layer.succeed(NoteStore, store)));

  if (options.history) {
    const before = ManagedRuntime.make(
      NotebookBefore.layer(handlers).pipe(Layer.provide(platform)),
    );

    await before.runPromise(
      Effect.gen(function* () {
        const notes = yield* NoteAggregate;

        for (const note of options.history ?? [])
          yield* notes.send(
            address(note.account, note.NoteId),
            new CreateNote({ account: note.account, BookId: note.BookId, title: note.title }),
          );
      }),
    );
    await waitFor(store, (stored) =>
      (options.history ?? []).every((note) => stored.has(note.NoteId)),
    );
    await before.dispose();
  }

  const model = Notebook.layer(Layer.mergeAll(handlers, NotebookWriter.layer)).pipe(
    Layer.provide(platform),
  );

  const runtime = ManagedRuntime.make(
    NotesApi.layerClientInProcess.pipe(Layer.provideMerge(model)),
  );

  const api = await runtime.runPromise(NotesApi.Client);
  const wire = faulty(api);

  /** Holds every query until the returned release is called. */
  const hold = () => {
    const gate = Effect.runSync(Deferred.make<void>());

    store.gate = Deferred.await(gate);

    return () => {
      store.gate = Effect.void;
      Effect.runSync(Deferred.succeed(gate, undefined));
    };
  };

  /** Sends a command directly, as another user would. */
  const send = <A, E>(effect: (client: Client) => Effect.Effect<A, E>) =>
    Effect.runPromise(effect(api));

  /** The account's feed entries after `after`, up to the caught-up marker. */
  const entries = (account: string, after = 0) =>
    Effect.runPromise(
      api.NotebookChanges.events(account, { after }).pipe(
        Stream.takeUntil(Domain.Read.isCaughtUp),
        Stream.filter(Domain.Read.isEvent),
        Stream.runCollect,
      ),
    );

  return {
    api,
    store,
    wire,
    hold,
    indexed: (check: (notes: Map<string, Note>) => boolean) => waitFor(store, check),
    send,
    entries,
    create: (note: Seed) => send((client) => create(client, note)),
    dispose: () => runtime.dispose(),
  };
};
