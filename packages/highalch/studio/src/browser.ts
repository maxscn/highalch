import { read, status } from "./read";

const model = read();
const main = document.querySelector("main")!;
const connection = document.querySelector("#connection")!;
const totals = document.querySelector("#totals")!;
const theme = document.querySelector<HTMLButtonElement>("#theme")!;
let selected: string | undefined;
let pending = false;

const node = <Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  text?: string,
  className?: string,
) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};

const frame = (image: string | undefined) => {
  const panel = node("div", undefined, "frame");
  const url = image && model.frames.get(image);
  if (url) {
    const picture = node("img");
    picture.src = url;
    picture.alt = "Latest painted screen";
    panel.append(picture);
  } else {
    panel.textContent = "No screen";
  }
  return panel;
};

const render = () => {
  pending = false;
  const counts = { running: 0, passed: 0, failed: 0 };
  for (const session of model.sessions.values()) counts[status(session)]++;
  totals.textContent = `${counts.running} running · ${counts.passed} passed · ${counts.failed} failed`;
  const grid = node("div", undefined, "grid");

  const detail = selected && model.sessions.get(selected);
  if (detail) {
    const back = node("button", "← All runs");
    back.onclick = () => {
      selected = undefined;
      render();
      main.querySelector("button")?.focus();
    };
    const heading = node("h2", detail.start.name);
    const summary = node("p", detail.end?.status ?? status(detail));
    const sequences = node("ul", undefined, "sequences");
    for (const [index, sequence] of detail.sequences) {
      const tile = node(
        "li",
        `${index + 1}. ${sequence.attempt.name} · ${sequence.status}`,
        sequence.status,
      );
      sequences.append(tile);
    }
    const steps = node("ol");
    for (const step of detail.steps)
      steps.append(node("li", `${step.label} · ${step.status}`, step.status));
    const content: HTMLElement[] = [back, heading, summary, frame(detail.frame)];
    if (detail.end?.failure) {
      content.push(node("h3", "Shrunk failing sequence"), node("pre", detail.end.failure.story));
    }
    content.push(node("h3", "Sequences"), sequences, node("h3", "Steps"), steps);
    const focused = document.activeElement === main.querySelector("button");
    main.replaceChildren(...content);
    if (focused) back.focus({ preventScroll: true });
    return;
  }

  const active = document.activeElement;
  for (const [id, session] of model.sessions) {
    const state = status(session);
    const card = node("button", undefined, `card ${state}`);
    card.dataset.session = id;
    const shard = session.start.shard;
    const total = session.start.sequences.total;
    const assigned = Math.max(0, Math.ceil((total - shard.index + 1) / shard.total));
    const progress = `${session.end?.ran ?? session.done} / ${assigned} sequences`;
    card.append(
      frame(session.frame),
      node("strong", session.start.name),
      node(
        "span",
        `Exploration · Shard ${shard.index}/${shard.total} · ${session.end?.status ?? state}`,
      ),
      node("span", progress),
      node("span", session.steps.at(-1)?.label ?? "Waiting for steps"),
    );
    if (session.end?.failure) card.append(node("span", session.end.failure.moves.join(" → ")));
    card.onclick = () => {
      selected = id;
      render();
      main.querySelector("button")?.focus();
    };
    grid.append(card);
  }
  if (!model.sessions.size) grid.append(node("p", "Waiting for runs"));
  main.replaceChildren(grid);
  if (active instanceof HTMLButtonElement && active.dataset.session)
    for (const card of grid.querySelectorAll("button"))
      if (card.dataset.session === active.dataset.session) card.focus({ preventScroll: true });
};

theme.onclick = () => {
  const root = document.documentElement;
  const current = root.dataset.theme;
  if (current === "dark") root.dataset.theme = "light";
  else if (current === "light") delete root.dataset.theme;
  else if (matchMedia("(prefers-color-scheme: dark)").matches) root.dataset.theme = "light";
  else root.dataset.theme = "dark";
  theme.textContent = `Theme: ${root.dataset.theme ?? "System"}`;
};

const token = new URLSearchParams(location.hash.slice(1)).get("token");
if (token && /^[A-Za-z0-9_-]+$/.test(token)) {
  const socket = new WebSocket(`ws://${location.host}/v1/watch`, [
    "highalch.v1",
    `bearer.${token}`,
  ]);
  socket.binaryType = "arraybuffer";
  socket.onopen = () => {
    connection.textContent = "Connected";
  };
  socket.onclose = () => {
    connection.textContent = "Disconnected · Reload to reconnect";
  };
  socket.onmessage = ({ data }: MessageEvent<string | ArrayBuffer>) => {
    model.receive(data);
    if (!pending) {
      pending = true;
      requestAnimationFrame(render);
    }
  };
} else {
  connection.textContent = "Open the local link printed by highalch studio to view runs.";
}
render();
