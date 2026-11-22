import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import WebSocket from "ws";
import * as Story from "@highalch/story";
import { Explore, ExploreFailure } from "@highalch/explore";
import { Screen } from "@highalch/story/screen";
import {
  bearer,
  connect,
  subprotocol,
  unframed,
  Watched,
  type Envelope,
  type Event,
  type Open,
  type Settings,
  type Shard,
} from "@highalch/stream";
import { relay } from "@highalch/studio";
import { Takumi } from "@highalch/story/takumi";
import { Form } from "@highalch/story/tanstack-form";
import { Db } from "@highalch/story/tanstack-db";
import { OverflowingTitle, Shared } from "@highalch/examples";

const { ApprovedNoteCard, BrokenNoteCard, titleForm, css } = OverflowingTitle;
const { ada, exist, list, story } = Shared;

/** A session as a page watching the studio sees it. */
type Session = {
  readonly id: string;
  readonly open: Open;
  readonly events: Array<Envelope>;
  closed: boolean;
};

/**
 * The studio's relay, and a page watching it: the sessions it saw, the frames, and any event
 * that named a frame the page had not received first.
 */
const studio = async () => {
  const made = await relay({ port: 0 });
  const page = new WebSocket(
    `${made.url.replace(/^http/, "ws")}/v1/watch`,
    [subprotocol, bearer(made.view)],
    { origin: "https://studio.highalch.dev" },
  );
  const sessions: Array<Session> = [];
  const frames = new Set<string>();
  const problems: Array<string> = [];

  page.on("message", (data, binary) => {
    if (binary) {
      frames.add(unframed(new Uint8Array(data as Buffer)).image);

      return;
    }

    const watched = Schema.decodeUnknownSync(Watched)(JSON.parse((data as Buffer).toString()));

    if (watched.type === "session")
      return void sessions.push({
        id: watched.session,
        open: watched.open,
        events: [],
        closed: false,
      });

    const session = sessions.find((each) => each.id === watched.session);

    if (session === undefined) return void problems.push(`no session ${watched.session}`);

    if (watched.type === "closed") {
      session.closed = true;

      return;
    }

    for (const envelope of watched.envelopes) {
      const event = envelope.event;

      if (event.type === "step" && event.frame && !frames.has(event.frame.image))
        problems.push(`event ${envelope.seq} names a frame the page was not sent first`);

      session.events.push(envelope);
    }
  });

  await new Promise((resolve) => page.once("open", resolve));

  return {
    url: made.url,
    ingest: made.ingest,
    sessions,
    frames,
    problems,
    /** Waits until every session closed. */
    closed: async (count: number) => {
      for (let tries = 0; tries < 300; tries += 1) {
        if (sessions.filter((each) => each.closed).length >= count) return;

        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    close: async () => {
      page.close();
      await made.close();
    },
  };
};

/** The card's screen, with frames (painted live while streaming) and a layout for its rule. */
const Card = Screen.make({ css, width: 360, height: 240 }).pipe(
  Takumi.frames({
    baselines: new URL("./baselines/", import.meta.url),
    output: new URL("../artifacts/", import.meta.url),
  }),
  Takumi.layout(),
);

const fits = Story.rule("nothing on screen spills out of its box", function* () {
  return Screen.overflowing(yield* Card.layout()).length === 0;
});

const longest = "W".repeat(60);

/** 3 moves, up to 2 deep: 3 + 9 sequences. */
const explorationOf = (
  name: string,
  view: React.JSX.Element,
  shard: Shard,
  sink: ReturnType<typeof connect>,
) =>
  [
    Explore.stories(story.with({ name, rules: [...Db.rules, fits] }), {
      setup: [exist(ada), Db.open(list), Card.render(view)],
      sources: [
        Form.typing(titleForm, { fields: ["title"], values: { title: ["Ada 2", longest] } }),
        Explore.source("submit", { step: () => Form.submit(titleForm) }),
      ],
      depth: 2,
    }),
    { shard, stream: sink, artifacts: new URL("../artifacts/explore/", import.meta.url) },
  ] as const;

const settingsOf = (url: string, shard: Shard, token: string): Settings => ({
  url,
  auth: { kind: "token", token },
  run: "run-1",
  shard,
  origin: { repository: "acme/notes", commit: "c41e9a0" },
  frames: "every",
});

const eventsOf = <T extends Event["type"]>(session: Session, type: T) =>
  session.events
    .map((each) => each.event)
    .filter((event): event is Extract<Event, { readonly type: T }> => event.type === type);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("f(exploration, shards, stream) → every sequence once, as tiles of one grid", () => {
  it("f(approved card, 2 shards) → each runs every 2nd sequence; together all 12, each with its frames", async () => {
    const app = await studio();

    try {
      for (const index of [1, 2]) {
        const shard = { index, total: 2 };
        const sink = connect(settingsOf(app.url, shard, app.ingest));
        const explored = await Explore.run(
          ...explorationOf(
            "approved card",
            <ApprovedNoteCard NoteId="n1" title="Ada" />,
            shard,
            sink,
          ),
        );

        expect(explored.shard).toEqual(shard);
        expect(explored.ran).toBe(6);
        expect(explored.report).toContain(`Shard ${index} of 2: ran 6 sequence(s), every 2th`);

        await sink.close();
      }

      await app.closed(2);
      expect(app.problems).toEqual([]);
      expect(app.sessions.map((each) => [each.open.run, each.open.shard, each.closed])).toEqual([
        ["run-1", { index: 1, total: 2 }, true],
        ["run-1", { index: 2, total: 2 }, true],
      ]);

      const sequences = app.sessions.map((session) =>
        eventsOf(session, "attempt").map((each) => each.sequence),
      );

      expect(sequences).toEqual([
        [0, 2, 4, 6, 8, 10],
        [1, 3, 5, 7, 9, 11],
      ]);

      for (const session of app.sessions) {
        const [started] = eventsOf(session, "exploration");

        expect(started).toMatchObject({
          exploration: "approved-card",
          sequences: { total: 12, checked: 12, corpus: 0, sampled: 0, discovered: 0 },
          depth: 2,
          sources: [
            { name: "typing", values: 2 },
            { name: "submit", values: 1 },
          ],
          setup: [
            'given Note/["acc-1","n1"]: NoteCreated',
            'open NoteRows/Notes:{"account":"acc-1"}:{}',
            "render",
          ],
        });

        const steps = eventsOf(session, "step");

        // The screen mounts at step 3: a frame after it and every later step, none before.
        expect(
          steps.filter((each) => each.step < 3).every((each) => each.frame === undefined),
        ).toBe(true);
        expect(
          steps.filter((each) => each.step >= 3).every((each) => each.frame?.width === 360),
        ).toBe(true);

        // Every frame a step names reached the page.
        const frames = steps.flatMap((each) => (each.frame ? [each.frame.image] : []));

        expect(frames.every((image) => app.frames.has(image))).toBe(true);

        expect(eventsOf(session, "attempt-end").every((each) => each.status === "passed")).toBe(
          true,
        );
        expect(eventsOf(session, "exploration-end")).toMatchObject([{ status: "passed", ran: 6 }]);
      }
    } finally {
      await app.close();
    }
  }, 300_000);

  it("f(broken card) → the failing tile's shrinking, confirming and replay, then the story to paste", async () => {
    const app = await studio();

    try {
      const shard = { index: 1, total: 1 };
      const sink = connect(settingsOf(app.url, shard, app.ingest));
      const failure = await Explore.run(
        ...explorationOf("broken card", <BrokenNoteCard NoteId="n1" title="Ada" />, shard, sink),
      ).then(
        () => undefined,
        (error: ExploreFailure) => error,
      );

      expect(failure).toBeInstanceOf(ExploreFailure);

      await sink.close();
      await app.closed(1);
      expect(app.problems).toEqual([]);

      const [session] = app.sessions;

      if (session === undefined) throw new Error("no session was opened");

      const attempts = eventsOf(session, "attempt");
      const failing = attempts.find((each) => each.phase === "replay");

      expect(failing?.moves).toEqual([
        `typing.step({"field":"title","instance":0,"value":"${longest}"})`,
        "submit.step()",
      ]);
      // Every later phase is of the same tile: the sequence that failed first.
      expect(
        new Set(attempts.filter((each) => each.phase !== "explore").map((each) => each.sequence)),
      ).toEqual(new Set([failing?.sequence]));
      expect(attempts.filter((each) => each.phase === "confirm")).toHaveLength(2);

      const replay = eventsOf(session, "step").filter((each) => each.attempt === failing?.attempt);

      expect(replay.at(-1)?.frame).toBeDefined();

      const [finished] = eventsOf(session, "exploration-end");

      expect(finished?.status).toBe("failed");
      expect(finished?.failure?.sequence).toBe(failing?.sequence);
      expect(finished?.failure?.reason).toContain("nothing on screen spills out of its box");
      expect(finished?.failure?.story).toContain("submit.step(),");
      // The console offers it to copy: a coding agent pins the failure as a story, then fixes it.
      expect(finished?.failure?.prompt).toContain(
        "Add a story that reproduces an exploration's failure",
      );
      expect(failing?.name).toBe('typing title "WWWWWWWWWWWWWWWWWWWWWW…", submit');
    } finally {
      await app.close();
    }
  }, 300_000);

  it("f(the app refuses the token) → the stream turns off with one warning; the exploration runs on", async () => {
    const app = await studio();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const shard = { index: 1, total: 4 };
      const sink = connect(settingsOf(app.url, shard, "hat_wrong"));
      const explored = await Explore.run(
        ...explorationOf("refused card", <ApprovedNoteCard NoteId="n1" title="Ada" />, shard, sink),
      );

      expect(explored.ran).toBe(3);
      expect(app.sessions).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("answered 401");
      // The token is never printed.
      expect(String(warn.mock.calls[0]?.[0])).not.toContain("hat_wrong");
    } finally {
      await app.close();
    }
  }, 300_000);
});
