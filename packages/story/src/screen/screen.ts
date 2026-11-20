import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { RegistryContext } from "@effect/atom-react";
import { Option, Schema } from "effect";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { render as paint, type Font } from "takumi-js";
import wasm from "takumi-js/wasm-url";
import { Provider } from "@lowalch/tanstack-db/react";
import { registryOf } from "../atoms";
import { Mismatch, type Done, type Stage } from "../stage";
import { staged, type Step } from "../steps";
import { macrotask, type World } from "../world";
import { escape, install, serialize, type Installed } from "./dom";
import { compare, decode, encode, type Pixels } from "./png";

/** Where a screen's files go: a path, or a `file:` URL (`new URL("./baselines/", import.meta.url)`). */
export type Place = string | URL;

/** How a story's screens are rendered, compared and reported. */
export type Options = {
  /** The stylesheets the component's markup is painted with (compiled CSS text). */
  readonly css?: string | ReadonlyArray<string>;
  /** The viewport, in CSS pixels; every frame is this size. */
  readonly width: number;
  readonly height: number;
  /** Fonts to paint with (local bytes); takumi's built-in font otherwise. */
  readonly fonts?: ReadonlyArray<Font>;
  /** Reviewed frames: `<baselines>/<story>/<step>-<label>.png`, committed. */
  readonly baselines: Place;
  /** The run's report: frames, diffs, a filmstrip page per story and a manifest (gitignored). */
  readonly output: Place;
  /** Writes (creates or replaces) baselines instead of comparing. Never implicitly. */
  readonly update?: boolean;
};

/** How one frame compared with its baseline. */
export type Status = "matched" | "created" | "updated" | "missing" | "mismatch";

/** One captured frame, as the manifest lists it. */
export type Frame = {
  readonly step: number;
  readonly label: string;
  readonly file: string;
  readonly status: Status;
  /** Pixels that differ from the baseline (a mismatch). */
  readonly differing?: number;
};

/** A screen of a story: its root, its DOM, and what it captured. */
type Mounted = {
  readonly root: Root;
  readonly container: HTMLElement;
  readonly dom: Installed;
  readonly every: boolean;
  readonly frames: Array<Frame>;
};

type Screens = { mounted: Option.Option<Mounted> };

const screensKey: unique symbol = Symbol("@highalch/story/screen");

const pathOf = (place: Place) => {
  if (place instanceof URL) return fileURLToPath(place);

  return place;
};

const slug = (text: string) =>
  text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 60) || "step";

const pad = (step: number) => String(step).padStart(2, "0");

/** The wasm renderer's module bytes, loaded once: the same renderer binary on every platform. */
let module: Promise<Uint8Array> | undefined;

const moduleOf = () => (module ??= readFile(wasm));

/**
 * Lets React finish: `act` flushes renders and effects scheduled by store changes. React's act
 * environment flag is on only inside, so updates a story causes between steps (a live query's
 * store changing) are scheduled normally and flushed here.
 */
const flush = async (run: () => void = () => {}) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

  try {
    await act(async () => {
      run();
      await macrotask();
    });
  } finally {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
};

/** Waits until the world is quiet without letting command replies through, then lets React finish. */
const quiet = async (world: World) => {
  await flush();
  await world.settle(false);
  await flush();
};

const nameOf = (stage: Stage, label: string) =>
  Option.getOrThrowWith(
    stage.name,
    () =>
      new Mismatch(
        `"${label}" needs a story name, since frames are named by it: story.with({ name: "…" })(…)`,
      ),
  );

const write = async (file: string, bytes: Uint8Array | string) => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, bytes);
};

const readable = async (file: string) =>
  readFile(file).then(
    (bytes) => Option.some(new Uint8Array(bytes)),
    () => Option.none<Uint8Array>(),
  );

/** A filmstrip page of one story's frames. */
const page = (story: string, frames: ReadonlyArray<Frame>) => {
  const figures = frames.map((frame) => {
    const failed = frame.status === "mismatch" || frame.status === "missing";
    const base = frame.file.replace(/\.png$/, "");

    const extra = Option.match(
      Option.liftPredicate(frame, () => frame.status === "mismatch"),
      {
        onNone: () => "",
        onSome: () =>
          `<a href="${escape(base)}.expected.png">expected</a> · <a href="${escape(base)}.diff.png">diff</a> (${frame.differing ?? 0} px)`,
      },
    );

    return `<figure class="${failed ? "failed" : ""}"><img src="${escape(frame.file)}" alt=""><figcaption><b>${frame.step}.</b> ${escape(frame.label)}<br><span>${frame.status}</span> ${extra}</figcaption></figure>`;
  });

  return `<!doctype html><meta charset="utf-8"><title>${escape(story)}</title><style>body{font:14px system-ui;margin:16px;background:#f6f6f4}h1{font-size:18px}.strip{display:flex;gap:12px;overflow-x:auto}figure{margin:0;background:#fff;border:1px solid #ddd;padding:6px}figure.failed{border-color:#d22}img{display:block;border:1px solid #eee}figcaption{max-width:320px;margin-top:6px}span{color:#666}</style><p><a href="../index.html">all stories</a></p><h1>${escape(story)}</h1><div class="strip">${figures.join("")}</div>`;
};

/** What the index reads of a story's manifest. */
const Manifest = Schema.Struct({
  story: Schema.String,
  frames: Schema.Array(Schema.Struct({ status: Schema.String })),
});

/** Rewrites the run's index from every story's manifest under `output`. */
const index = async (output: string) => {
  const entries = await readdir(output, { withFileTypes: true }).catch(() => []);

  const stories: Array<{ readonly dir: string; readonly name: string; readonly failed: boolean }> =
    [];

  for (const entry of entries
    .filter((each) => each.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const manifest = await readFile(join(output, entry.name, "manifest.json"), "utf8").then(
      Schema.decodeUnknownOption(Schema.fromJsonString(Manifest)),
      () => Option.none(),
    );

    if (Option.isNone(manifest)) continue;

    stories.push({
      dir: entry.name,
      name: manifest.value.story,
      failed: manifest.value.frames.some(
        (frame) => frame.status === "mismatch" || frame.status === "missing",
      ),
    });
  }

  const items = stories.map(
    (story) =>
      `<li><a href="${escape(story.dir)}/index.html">${escape(story.name)}</a>${story.failed ? " ✗" : ""}</li>`,
  );

  await write(
    join(output, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>Story screens</title><style>body{font:14px system-ui;margin:16px}</style><h1>Story screens</h1><ul>${items.join("")}</ul>`,
  );
};

/**
 * A viewport for stories: `const List = Screen.make(options)` gives a screen of that size,
 * whose `List.render(element)` is a step that mounts a React
 * element under the package's `Provider` with the story's client (stock `useLiveQuery` reads the
 * story's data) in a happy-dom document, and captures a frame after it and after every later
 * step: once the world is quiet (command replies still held) and React has flushed, the DOM is
 * serialised (current control values) and painted by takumi's WASM renderer with `css`, then
 * compared pixel by pixel with its baseline. `List.shot(label?)` captures a frame on demand (with
 * `List.render(element, { every: false })`, only there). `List.check(label, run)` asserts on
 * the mounted DOM.
 */
export const make = (options: Options) => {
  const baselines = pathOf(options.baselines);
  const output = pathOf(options.output);
  const css = [options.css ?? []].flat();

  const capture = async (stage: Stage, mounted: Mounted, done: Done, label: string) => {
    const story = slug(nameOf(stage, label));

    await quiet(stage.hosted(label));

    const html = `<div data-screen style="width:${options.width}px;height:${options.height}px;display:flex;flex-direction:column">${serialize(mounted.container)}</div>`;

    const raw = await paint(html, {
      module: await moduleOf(),
      width: options.width,
      height: options.height,
      css,
      fonts: options.fonts ? [...options.fonts] : undefined,
      format: "raw",
    });

    const actual: Pixels = { width: options.width, height: options.height, data: raw };
    const name = `${pad(done.step)}-${slug(done.label)}`;
    const file = `${name}.png`;
    const baseline = join(baselines, story, file);
    const target = join(output, story);
    const png = encode(actual);

    await write(join(target, file), png);
    await write(join(target, `${name}.html`), html);

    const known = await readable(baseline);

    const record = (status: Status, differing?: number) =>
      mounted.frames.push({ step: done.step, label: done.label, file, status, differing });

    if (options.update) {
      await write(baseline, png);

      return record(Option.isSome(known) ? "updated" : "created");
    }

    if (Option.isNone(known)) {
      record("missing");

      throw new Mismatch(`frame ${story}/${file} has no baseline`, [
        `actual: ${relative(process.cwd(), join(target, file))}`,
        "review it, then write baselines with the screen's `update` option",
      ]);
    }

    const expected = decode(known.value);
    const difference = compare(actual, expected);

    if (difference.pixels === 0) return record("matched");

    record("mismatch", difference.pixels);
    await write(join(target, `${name}.expected.png`), known.value);
    await write(join(target, `${name}.diff.png`), encode(difference.image));

    throw new Mismatch(
      `frame ${story}/${file} differs from its baseline in ${difference.pixels} pixel(s)`,
      [
        `actual:   ${relative(process.cwd(), join(target, file))}`,
        `expected: ${relative(process.cwd(), baseline)}`,
        `diff:     ${relative(process.cwd(), join(target, `${name}.diff.png`))}`,
      ],
    );
  };

  /** Unmounts, removes the DOM globals and writes the story's filmstrip and manifest. */
  const finish = (stage: Stage, mounted: Mounted, label: string) => async () => {
    await flush(() => mounted.root.unmount());
    await mounted.dom.remove();

    const story = nameOf(stage, label);
    const target = join(output, slug(story));

    await write(
      join(target, "manifest.json"),
      `${JSON.stringify({ story, width: options.width, height: options.height, frames: mounted.frames }, null, 2)}\n`,
    );
    await write(join(target, "index.html"), page(story, mounted.frames));
    await index(output);
  };

  /**
   * Mounts `element` against the story's client (of the step's scope) and captures a frame after
   * this step and every later one (`every: false`: only at `shot` steps). Needs a hosted story
   * with a name; one screen per story.
   */
  const render = (element: ReactElement, settings: { readonly every?: boolean } = {}): Step => {
    const label = "render";

    return staged(label, async (stage) => {
      const world = stage.hosted(label);
      const screens = stage.slot<Screens>(screensKey, () => ({ mounted: Option.none() }));

      const story = nameOf(stage, label);

      if (Option.isSome(screens.mounted))
        throw new Mismatch("this story already rendered a screen");

      // The story's report starts afresh: no frame or diff of an earlier run stays beside it.
      await rm(join(output, slug(story)), { recursive: true, force: true });

      const client = await world.connect();
      const dom = install(options.width, options.height);
      const container = document.createElement("div");

      document.body.append(container);

      const root = createRoot(container);

      const mounted: Mounted = {
        root,
        container,
        dom,
        every: settings.every ?? true,
        frames: [],
      };

      screens.mounted = Option.some(mounted);
      stage.end(finish(stage, mounted, label));

      await flush(() =>
        root.render(
          createElement(
            RegistryContext.Provider,
            { value: registryOf(stage) },
            createElement(Provider, { client: client.db }, element),
          ),
        ),
      );

      stage.after(async (done) => {
        if (mounted.every) await capture(stage, mounted, done, label);
      });
    });
  };

  /** Captures a frame now, labelled `label` (for `render(element, { every: false })`). */
  const shot = (label = "shot"): Step =>
    staged(`shot ${label}`, async (stage) => {
      const mounted = Option.getOrThrowWith(
        stage.slot<Screens>(screensKey, () => ({ mounted: Option.none() })).mounted,
        () => new Mismatch("nothing is rendered yet: render(element) first"),
      );

      if (!mounted.every) await capture(stage, mounted, { step: stage.step, label }, label);
    });

  /**
   * Checks the mounted DOM: `run` is given the container the element is mounted in, once the
   * world is quiet and React has flushed, so it sees what a frame taken now would paint. Query it
   * as any DOM (`container.querySelector("h1")`, or a testing library's `within(container)`);
   * what `run` throws fails the step.
   */
  const check = (label: string, run: (container: HTMLElement) => void | Promise<void>): Step =>
    staged(`check ${label}`, async (stage) => {
      const mounted = Option.getOrThrowWith(
        stage.slot<Screens>(screensKey, () => ({ mounted: Option.none() })).mounted,
        () => new Mismatch("nothing is rendered yet: render(element) first"),
      );

      await quiet(stage.hosted(label));
      await run(mounted.container);
    });

  return { render, shot, check };
};

/** A screen of a viewport: its `render`, `shot` and `check` steps (`const List = Screen.make(…)`). */
export type Viewport = ReturnType<typeof make>;
