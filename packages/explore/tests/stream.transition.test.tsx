import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as Story from "@highalch/story";
import { Explore, ExploreFailure } from "@highalch/explore";
import { Screen } from "@highalch/story/screen";
import { connect, Envelope, Open, type Event, type Settings, type Shard } from "@highalch/stream";
import { Takumi } from "@highalch/story/takumi";
import { Form } from "@highalch/story/tanstack-form";
import { Db } from "@highalch/story/tanstack-db";
import { OverflowingTitle, Shared } from "@highalch/examples";

const { ApprovedNoteCard, BrokenNoteCard, titleForm, css } = OverflowingTitle;
const { ada, exist, list, story } = Shared;

const ingest = "hat_ingest_secret";

type Session = {
  readonly id: string;
  readonly token: string;
  readonly open: Open;
  readonly events: Array<Envelope>;
  readonly frames: Map<string, number>;
  closed: boolean;
};

const bodyOf = async (request: IncomingMessage) => {
  const chunks: Array<Buffer> = [];

  for await (const chunk of request) chunks.push(chunk as Buffer);

  return Buffer.concat(chunks);
};

/**
 * The receiving app's side, as the protocol describes it: it opens a session for the ingest
 * token only, takes events and frames for that session's own token only, checks each frame's
 * SHA-256, and notes an event naming a frame it was not sent first.
 */
const receiver = async () => {
  const sessions: Array<Session> = [];
  const requests: Array<{ readonly method: string; readonly path: string; readonly auth: string }> =
    [];
  const problems: Array<string> = [];

  const server = createServer((request, response) => {
    void bodyOf(request).then((body) => {
      const path = request.url ?? "";
      const auth = request.headers.authorization ?? "";

      requests.push({ method: request.method ?? "", path, auth });

      const answer = (status: number, json?: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(json === undefined ? undefined : JSON.stringify(json));
      };

      if (request.method === "POST" && path === "/stream/v1/sessions") {
        if (auth !== `Bearer ${ingest}`) return answer(401);

        const open = Schema.decodeUnknownSync(Open)(JSON.parse(body.toString()));
        const session: Session = {
          id: `s${sessions.length + 1}`,
          token: `session-token-${sessions.length + 1}`,
          open,
          events: [],
          frames: new Map(),
          closed: false,
        };

        sessions.push(session);

        return answer(201, { session: session.id, token: session.token, expires: "soon" });
      }

      const match = /^\/stream\/v1\/sessions\/([^/]+)\/(events|close|frames\/([0-9a-f]{64}))$/.exec(
        path,
      );
      const session = sessions.find((each) => each.id === match?.[1]);

      if (!match || !session) return answer(404);

      if (auth !== `Bearer ${session.token}`) return answer(403);

      if (match[2] === "close") {
        session.closed = true;

        return answer(204);
      }

      if (match[3] !== undefined) {
        if (createHash("sha256").update(body).digest("hex") !== match[3]) return answer(400);

        session.frames.set(match[3], body.byteLength);

        return answer(204);
      }

      for (const line of body.toString().split("\n").filter(Boolean)) {
        const envelope = Schema.decodeUnknownSync(Envelope)(JSON.parse(line));
        const event = envelope.event;

        if (event.type === "step" && event.frame && !session.frames.has(event.frame.image))
          problems.push(`event ${envelope.seq} names a frame it was not sent first`);

        if (!session.events.some((each) => each.seq === envelope.seq))
          session.events.push(envelope);
      }

      return answer(204);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/stream`,
    sessions,
    requests,
    problems,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
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
) => ({
  name,
  story,
  setup: [exist(ada), Db.open(list), Card.render(view)],
  sources: [
    Form.typing(titleForm, { fields: ["title"], values: { title: ["Ada 2", longest] } }),
    Explore.source("submit", { step: () => Form.submit(titleForm) }),
  ],
  rules: [...Db.rules, fits],
  depth: 2,
  shard,
  stream: sink,
  artifacts: new URL("../artifacts/explore/", import.meta.url),
});

const settingsOf = (url: string, shard: Shard, token = ingest): Settings => ({
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
    const app = await receiver();

    try {
      for (const index of [1, 2]) {
        const shard = { index, total: 2 };
        const sink = connect(settingsOf(app.url, shard));
        const explored = await Explore.run(
          explorationOf("approved card", <ApprovedNoteCard NoteId="n1" title="Ada" />, shard, sink),
        );

        expect(explored.shard).toEqual(shard);
        expect(explored.ran).toBe(6);
        expect(explored.report).toContain(`Shard ${index} of 2: ran 6 sequence(s), every 2th`);

        await sink.close();
      }

      expect(app.problems).toEqual([]);
      expect(app.sessions.map((each) => [each.open.run, each.open.shard, each.closed])).toEqual([
        ["run-1", { index: 1, total: 2 }, true],
        ["run-1", { index: 2, total: 2 }, true],
      ]);

      // The ingest token opens sessions and goes nowhere else.
      expect(
        app.requests.filter((each) => each.auth.includes(ingest)).map((each) => each.path),
      ).toEqual(["/stream/v1/sessions", "/stream/v1/sessions"]);

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

        // Each frame is sent once, however many steps showed it.
        const frames = new Set(steps.flatMap((each) => (each.frame ? [each.frame.image] : [])));

        expect(session.frames.size).toBe(frames.size);
        expect(
          app.requests.filter((each) =>
            each.path.startsWith(`/stream/v1/sessions/${session.id}/frames/`),
          ).length,
        ).toBe(frames.size);

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
    const app = await receiver();

    try {
      const shard = { index: 1, total: 1 };
      const sink = connect(settingsOf(app.url, shard));
      const failure = await Explore.run(
        explorationOf("broken card", <BrokenNoteCard NoteId="n1" title="Ada" />, shard, sink),
      ).then(
        () => undefined,
        (error: ExploreFailure) => error,
      );

      expect(failure).toBeInstanceOf(ExploreFailure);
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
    } finally {
      await app.close();
    }
  }, 300_000);

  it("f(the app refuses the token) → the stream turns off with one warning; the exploration runs on", async () => {
    const app = await receiver();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const shard = { index: 1, total: 4 };
      const sink = connect(settingsOf(app.url, shard, "hat_wrong"));
      const explored = await Explore.run(
        explorationOf("refused card", <ApprovedNoteCard NoteId="n1" title="Ada" />, shard, sink),
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
