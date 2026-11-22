import type { Attempt, Finished, Open, Ran, Started, Watched } from "@highalch/stream";

type Status = "running" | "passed" | "failed";
type Sequence = { attempt: Attempt; status: Status };
type Session = {
  open: Open;
  start: Started;
  end?: Finished;
  closed: boolean;
  sequences: Map<number, Sequence>;
  attempts: Map<number, Sequence>;
  steps: Ran[];
  frame?: string;
  done: number;
};

export const status = (session: Session): Status => {
  if (session.end?.status === "passed") return "passed";
  if (session.end || session.closed) return "failed";
  return "running";
};

export const read = () => {
  const sessions = new Map<string, Session>();
  const opened = new Map<string, Open>();
  const active = new Map<string, Session>();
  const frames = new Map<string, string>();

  // The authenticated relay validates envelopes and frames before sending them.
  const receive = (data: string | ArrayBuffer) => {
    if (typeof data !== "string") {
      const bytes = new Uint8Array(data);
      const image = Array.from(bytes.subarray(0, 32), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      if (!frames.has(image))
        frames.set(image, URL.createObjectURL(new Blob([data.slice(32)], { type: "image/png" })));
      return;
    }

    const message = JSON.parse(data) as Watched;
    if (message.type === "session") {
      opened.set(message.session, message.open);
      return;
    }

    const open = opened.get(message.session);
    if (!open) return;
    if (message.type === "closed") {
      for (const [id, session] of sessions)
        if (id.startsWith(`${message.session}/`)) session.closed = true;
      return;
    }

    for (const { event, seq } of message.envelopes) {
      const id = `${message.session}/${event.exploration}`;
      if (event.type === "exploration") {
        const session: Session = {
          open,
          start: event,
          closed: false,
          sequences: new Map(),
          attempts: new Map(),
          steps: [],
          done: 0,
        };
        active.set(id, session);
        sessions.set(`${message.session}/${seq}`, session);
        continue;
      }

      const session = active.get(id);
      if (!session) continue;
      switch (event.type) {
        case "attempt":
          if (event.phase === "explore") {
            const sequence: Sequence = { attempt: event, status: "running" };
            session.sequences.set(event.sequence, sequence);
            session.attempts.set(event.attempt, sequence);
          }
          break;
        case "step":
          session.steps.push(event);
          if (event.frame) session.frame = event.frame.image;
          break;
        case "attempt-end": {
          const sequence = session.attempts.get(event.attempt);
          if (sequence) {
            sequence.status = event.status;
            session.done++;
          }
          break;
        }
        case "exploration-end":
          session.end = event;
          break;
      }
    }
  };

  return { sessions, frames, receive };
};
