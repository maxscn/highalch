import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { RegistryContext } from "@effect/atom-react";
import { Context, Layer, Option, Pipeable, Schema } from "effect";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Data, registryOf } from "@highalch/story/internal";
import { reader, type Reader } from "@highalch/story/internal";
import { Mismatch, type Done, type Stage } from "@highalch/story/internal";
import { staged, type Step } from "@highalch/story/internal";
import { macrotask, type World } from "@highalch/story/internal";
import { escape, install, numbered, serialize, type Installed } from "./dom";
import { Layout, LayoutOf, type Box, type Extent, type Measured, type Run } from "./layout";
import { PainterOf, type Painter } from "./painter";
import { compare, decode, encode, type Pixels } from "./png";

/** Where a screen's files go: a path, or a `file:` URL (`new URL("./baselines/", import.meta.url)`). */
export type Place = string | URL;

/** A screen: the viewport a component is mounted in, and the stylesheets it is styled with. */
export type Options = {
  /** The stylesheets the component's markup is styled with (compiled CSS text). */
  readonly css?: string | ReadonlyArray<string>;
  /** The viewport, in CSS pixels; every frame and layout is this size. */
  readonly width: number;
  readonly height: number;
};

/** Where a screen's frames go and how they are compared (`Takumi.frames({ … })`). */
export type Frames = {
  /** Reviewed frames: `<baselines>/<painter>/<story>/<step>-<label>.png`, committed. */
  readonly baselines: Place;
  /** The run's report: frames, diffs, a filmstrip page per story and a manifest (gitignored). */
  readonly output: Place;
  /** Writes (creates or replaces) baselines instead of comparing. Never implicitly. */
  readonly update?: boolean;
};

/** How one frame compared with its baseline. */
export type Status = "matched" | "created" | "updated" | "missing" | "mismatch" | "recorded";

/** One captured frame, as the manifest lists it. */
export type Frame = {
  readonly step: number;
  readonly label: string;
  readonly file: string;
  readonly status: Status;
  /** Pixels that differ from the baseline (a mismatch). */
  readonly differing?: number;
};

/** A story's frames while its screen is mounted: the painter, and what it captured. */
type Framing = {
  readonly settings: Frames;
  readonly painter: Painter;
  readonly story: string;
  readonly every: boolean;
  readonly frames: Array<Frame>;
};

/** A screen of a story: its root, its DOM, and its frames when the screen has them. */
type Mounted = {
  readonly root: Root;
  readonly container: HTMLElement;
  readonly dom: Installed;
  readonly framing: Option.Option<Framing>;
};

type Screens = { mounted: Option.Option<Mounted> };

/** The story run's screen, as an adapter's service. */
class ScreensOf extends Context.Service<ScreensOf, Screens>()("@highalch/screen/Screens") {}

/** The screens adapter: the screen a story mounted (one per story). */
const screens = {
  service: ScreensOf,
  layer: Layer.sync(ScreensOf, (): Screens => ({ mounted: Option.none() })),
};

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

/** What a screen was piped with: its frames' painter and settings, and its layout engine. */
type Engines = {
  readonly frames: Option.Option<{
    readonly painter: Layer.Layer<PainterOf>;
    readonly settings: Frames;
  }>;
  readonly layout: Option.Option<Layer.Layer<LayoutOf>>;
};

/** Where a screen keeps its options and engines, for the pipe steps that add one. */
const built = Symbol.for("@highalch/screen/built");

/**
 * A screen of a story (`Screen.make({ css, width, height })`): `render(element)` mounts a React
 * element under its client's provider (TanStack DB's `DbProvider`, or the connector's: LowAlch's
 * `Provider`) with the story's client in a happy-dom document, and `check(label, run)` asserts on
 * the mounted DOM. It paints nothing and lays nothing out until it is piped with an engine:
 * `.pipe(Takumi.frames({ baselines, output }))` for frames, `.pipe(Takumi.layout())` for the
 * layout rules read.
 */
export interface Viewport extends Pipeable.Pipeable {
  /** Mounts `element` against the story's client (of the step's scope); one screen per story. */
  readonly render: (element: ReactElement) => Step;
  /**
   * Checks the mounted DOM: `run` is given the container the element is mounted in, once the
   * world is quiet and React has flushed. Query it as any DOM (`container.querySelector("h1")`,
   * or a testing library's `within(container)`); what `run` throws fails the step.
   */
  readonly check: (label: string, run: (container: HTMLElement) => void | Promise<void>) => Step;
  readonly [built]: { readonly options: Options; readonly engines: Engines };
}

/** A screen with frames (`.pipe(Takumi.frames({ … }))`). */
export interface Framed {
  /**
   * Mounts `element` and captures a frame after this step and every later one (`every: false`:
   * only at `shot` steps): once the world is quiet (command replies still held) and React has
   * flushed, the DOM is serialised (current control values), painted by the screen's painter and
   * compared pixel by pixel with its baseline. Frames are named by the story: it needs a name.
   */
  readonly render: (element: ReactElement, settings?: { readonly every?: boolean }) => Step;
  /** Captures a frame now, labelled `label` (for `render(element, { every: false })`). */
  readonly shot: (label?: string) => Step;
}

/** A screen with a layout engine (`.pipe(Takumi.layout())`). */
export interface Laid {
  /**
   * The screen's layout now, for a rule to yield: `yield* Card.layout()`. Laid out by the
   * screen's layout engine once the world is quiet (as a frame is), every box matched back to its
   * element; `Screen.overflowing(layout)` lists what spills out of its box. Before the screen
   * renders (a rule judged during setup) there is no layout: `undefined`.
   */
  readonly layout: () => Reader<Layout | undefined>;
}

const mountedOf = async (stage: Stage) =>
  Option.getOrThrowWith(
    (await stage.use(screens)).mounted,
    () => new Mismatch("nothing is rendered yet: render(element) first"),
  );

/** A screen's steps and readers for the engines it has. */
const build = (options: Options, engines: Engines) => {
  const css = [options.css ?? []].flat();
  const { width, height } = options;

  /** The serialised DOM inside a viewport-sized root: what a painter or layout engine is given. */
  const framed = (html: string) =>
    `<div data-screen style="width:${width}px;height:${height}px;display:flex;flex-direction:column">${html}</div>`;

  const capture = async (stage: Stage, mounted: Mounted, framing: Framing, done: Done) => {
    await quiet(stage.hosted(done.label));

    const html = framed(serialize(mounted.container));
    const actual: Pixels = await framing.painter.paint({ html, css, width, height });
    const story = slug(framing.story);
    const name = `${pad(done.step)}-${slug(done.label)}`;
    const file = `${name}.png`;
    const baseline = join(pathOf(framing.settings.baselines), framing.painter.name, story, file);
    const target = join(pathOf(framing.settings.output), story);
    const png = encode(actual);

    if (stage.live) stage.shown = Option.some({ png, width, height });

    await write(join(target, file), png);
    await write(join(target, `${name}.html`), html);

    const record = (status: Status, differing?: number) =>
      framing.frames.push({ step: done.step, label: done.label, file, status, differing });

    // An exploration's replay records its frames: they have no baselines to compare with.
    if (stage.capture === "record") return record("recorded");

    const known = await readable(baseline);

    if (framing.settings.update) {
      await write(baseline, png);

      return record(Option.isSome(known) ? "updated" : "created");
    }

    if (Option.isNone(known)) {
      record("missing");

      throw new Mismatch(`frame ${story}/${file} has no baseline`, [
        `actual: ${relative(process.cwd(), join(target, file))}`,
        "review it, then write baselines with the frames' `update` option",
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

  /**
   * Paints a frame for the story's observer only (an exploration streaming its tiles): nothing
   * is written or compared.
   */
  const show = async (stage: Stage, mounted: Mounted, framing: Framing, done: Done) => {
    await quiet(stage.hosted(done.label));

    const html = framed(serialize(mounted.container));
    const painted: Pixels = await framing.painter.paint({ html, css, width, height });

    stage.shown = Option.some({ png: encode(painted), width, height });
  };

  /** Writes the story's filmstrip and manifest, when the screen has frames. */
  const report = async (framing: Framing) => {
    const output = pathOf(framing.settings.output);
    const target = join(output, slug(framing.story));

    await write(
      join(target, "manifest.json"),
      `${JSON.stringify({ story: framing.story, width, height, frames: framing.frames }, null, 2)}\n`,
    );
    await write(join(target, "index.html"), page(framing.story, framing.frames));
    await index(output);
  };

  /** The screen's frames for this story: its painter, started afresh, when it has frames. */
  const framingOf = async (stage: Stage, every: boolean): Promise<Option.Option<Framing>> => {
    if (Option.isNone(engines.frames)) return Option.none();

    const { painter, settings } = engines.frames.value;
    const story = nameOf(stage, "render");

    // The story's report starts afresh: no frame or diff of an earlier run stays beside it.
    await rm(join(pathOf(settings.output), slug(story)), { recursive: true, force: true });

    return Option.some({
      settings,
      painter: await stage.use({ service: PainterOf, layer: painter }),
      story,
      every,
      frames: [],
    });
  };

  const render = (element: ReactElement, settings: { readonly every?: boolean } = {}): Step => {
    const label = "render";

    return staged(label, async (stage) => {
      stage.hosted(label);

      const screened = await stage.use(screens);

      if (Option.isSome(screened.mounted))
        throw new Mismatch("this story already rendered a screen");

      const framing = await framingOf(stage, settings.every ?? true);
      // Under the client of the story's data layer, when its host has one.
      const data = await stage.provided(Data);
      const provided = await Option.match(data, {
        onNone: async () => element,
        // SAFETY: a data layer mounts the React element it is given.
        onSome: async (layer) => (await layer.mount(element)) as ReactElement,
      });
      const registry = await registryOf(stage);
      const dom = install(width, height);
      const container = document.createElement("div");
      const stylesheet = document.createElement("style");

      // The screen's CSS in the document too, so computed styles (a layout's `overflow`, a
      // check's `getComputedStyle`) read what the engines are given.
      stylesheet.textContent = css.join("\n");
      document.head.append(stylesheet);
      document.body.append(container);

      const root = createRoot(container);
      const mounted: Mounted = { root, container, dom, framing };

      screened.mounted = Option.some(mounted);
      stage.describe(async () => {
        await flush();

        return [`screen: ${serialize(container)}`];
      });
      stage.end(async () => {
        await flush(() => root.unmount());
        await dom.remove();

        if (Option.isSome(framing)) await report(framing.value);
      });

      await flush(() =>
        root.render(createElement(RegistryContext.Provider, { value: registry }, provided)),
      );

      stage.after(async (done) => {
        if (Option.isNone(framing)) return;

        if (framing.value.every && stage.capture !== "off")
          await capture(stage, mounted, framing.value, done);
        else if (stage.live) await show(stage, mounted, framing.value, done);
      });
    });
  };

  const shot = (label = "shot"): Step =>
    staged(`shot ${label}`, async (stage) => {
      const mounted = await mountedOf(stage);
      const framing = Option.getOrThrowWith(
        mounted.framing,
        () => new Mismatch("the rendered screen has no frames: pipe it Takumi.frames({ … })"),
      );

      if (!framing.every && stage.capture !== "off")
        await capture(stage, mounted, framing, { step: stage.step, label });
    });

  const check = (label: string, run: (container: HTMLElement) => void | Promise<void>): Step =>
    staged(`check ${label}`, async (stage) => {
      const mounted = await mountedOf(stage);

      await quiet(stage.hosted(label));
      await run(mounted.container);
    });

  const layout = (engine: Layer.Layer<LayoutOf>) => (): Reader<Layout | undefined> =>
    reader("layout", async (stage) => {
      const found = (await stage.use(screens)).mounted;

      if (Option.isNone(found)) return undefined;

      const measurer = await stage.use({ service: LayoutOf, layer: engine });

      await quiet(stage.hosted("layout"));

      const { html, elements } = numbered(found.value.container);
      const measured = await measurer.measure({ html: framed(html), css, width, height });

      return new Layout(measurer.name, screenOf(measured, elements));
    });

  // Each engine adds its own steps and readers: no frames, no `shot`; no layout engine, no
  // `layout()`.
  return Object.assign(Object.create(Pipeable.Prototype), {
    render,
    check,
    [built]: { options, engines },
    ...Option.match(engines.frames, { onNone: () => ({}), onSome: () => ({ shot }) }),
    ...Option.match(engines.layout, {
      onNone: () => ({}),
      onSome: (engine) => ({ layout: layout(engine) }),
    }),
  });
};

/** A screen of that size and stylesheet, with no engine yet: pipe it the frames and layout it needs. */
export const make = (options: Options): Viewport =>
  build(options, { frames: Option.none(), layout: Option.none() });

/**
 * Gives a screen frames, painted by `painter` (a painter entry's Layer) and compared with
 * `settings.baselines`: `Screen.make(…).pipe(Screen.frames(painter, { baselines, output }))`.
 * `Takumi.frames({ … })` is this with takumi's painter.
 */
export const frames =
  (painter: Layer.Layer<PainterOf>, settings: Frames) =>
  <V extends Viewport>(viewport: V): V & Framed =>
    build(viewport[built].options, {
      ...viewport[built].engines,
      frames: Option.some({ painter, settings }),
    });

/**
 * Gives a screen a layout engine (a layout entry's Layer), for rules that read its layout:
 * `Screen.make(…).pipe(Screen.layout(engine))`, then `Card.layout()`. `Takumi.layout()` is this
 * with takumi's engine.
 */
export const layout =
  (engine: Layer.Layer<LayoutOf>) =>
  <V extends Viewport>(viewport: V): V & Laid =>
    build(viewport[built].options, {
      ...viewport[built].engines,
      layout: Option.some(engine),
    });

const clipping = new Set(["hidden", "clip", "auto", "scroll"]);

/** Displays whose children are laid out as items (each its own box), not as inline text. */
const itemised = new Set(["flex", "inline-flex", "grid", "inline-grid"]);

/** Displays of an element laid out within its parent's text (happy-dom leaves a span's empty). */
const inline = new Set(["", "inline", "contents"]);

/** An element as a failure names it: its tag, id and classes (`h1.title`, `input#q.field`). */
const elementName = (element: Element) =>
  [
    element.getAttribute("data-control") ?? element.tagName.toLowerCase(),
    ...[element.id].filter((id) => id !== "").map((id) => `#${id}`),
    ...[...element.classList].map((name) => `.${name}`),
  ].join("");

const styleOf = (element: Element) =>
  Option.fromUndefinedOr(element.ownerDocument.defaultView?.getComputedStyle(element));

/** A computed length in pixels; anything else (`1em`, `auto`) as 0, so it never invents overflow. */
const pixels = (value: string) =>
  Option.liftPredicate(value, (text) => text.endsWith("px")).pipe(
    Option.map(Number.parseFloat),
    Option.filter(Number.isFinite),
    Option.getOrElse(() => 0),
  );

/**
 * Whether an element clips what overflows it, by axis, from its computed `overflow`. A form
 * control scrolls its own text.
 */
const clipsOf = (element: Element) => {
  if (element.hasAttribute("data-control")) return { x: true, y: true };

  return Option.match(styleOf(element), {
    onNone: () => ({ x: false, y: false }),
    onSome: (style) => {
      const [first = "", second = first] = style.overflow.split(/\s+/);

      return {
        x: clipping.has(style.overflowX || first),
        y: clipping.has(style.overflowY || second),
      };
    },
  });
};

/** An element's border and padding widths, from its computed style. */
const insetsOf = (element: Element) =>
  Option.match(styleOf(element), {
    onNone: () => ({ border: [0, 0, 0, 0], padding: [0, 0, 0, 0] }),
    onSome: (style) => ({
      border: [
        style.borderTopWidth,
        style.borderRightWidth,
        style.borderBottomWidth,
        style.borderLeftWidth,
      ].map(pixels),
      padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(
        pixels,
      ),
    }),
  });

/** What an element's anonymous boxes hold: text runs, empty boxes, and elements inside them. */
type Folded = {
  readonly runs: ReadonlyArray<Run>;
  readonly anonymous: ReadonlyArray<Extent>;
  readonly children: ReadonlyArray<Box>;
};

const extentOf = ({ x, y, width, height }: Extent): Extent => ({ x, y, width, height });

/**
 * The element a measured box is the box of: found by its `data-box`, unless it is laid out
 * within its parent's text (then the box takumi made is a line's, not the element's).
 */
const elementOf = (measured: Measured, elements: ReadonlyArray<Element>, items: boolean) =>
  Option.fromUndefinedOr(measured.attributes["data-box"]).pipe(
    Option.flatMap((index) => Option.fromUndefinedOr(elements[Number(index)])),
    Option.filter(
      (element) =>
        items ||
        !inline.has(
          Option.match(styleOf(element), { onNone: () => "", onSome: (style) => style.display }),
        ),
    ),
  );

/** Measured boxes as an element's children: an element's box, or an anonymous one folded in. */
const fold = (
  measured: ReadonlyArray<Measured>,
  elements: ReadonlyArray<Element>,
  path: ReadonlyArray<string>,
  items: boolean,
): Folded => {
  const parts = measured.map((box): Folded =>
    Option.match(elementOf(box, elements, items), {
      onSome: (element) => ({
        runs: [],
        anonymous: [],
        children: [boxOf(box, element, elements, path)],
      }),
      onNone: () => {
        // An anonymous box has no padding: its runs are relative to its own box.
        const inner = fold(box.children, elements, path, false);
        const runs = box.runs.map((run) => ({ ...run, x: box.x + run.x, y: box.y + run.y }));

        return {
          runs: [...runs, ...inner.runs],
          anonymous: [
            ...[extentOf(box)].filter(() => runs.length === 0 && inner.runs.length === 0),
            ...inner.anonymous,
          ],
          children: inner.children,
        };
      },
    }),
  );

  return {
    runs: parts.flatMap((part) => part.runs),
    anonymous: parts.flatMap((part) => part.anonymous),
    children: parts.flatMap((part) => part.children),
  };
};

/** An element's box from an engine's: named by its path, its runs in viewport pixels. */
const boxOf = (
  measured: Measured,
  element: Element,
  elements: ReadonlyArray<Element>,
  path: ReadonlyArray<string>,
): Box => {
  const named = [...path, elementName(element)];
  const { border, padding } = insetsOf(element);
  const [borderTop = 0, borderRight = 0, borderBottom = 0, borderLeft = 0] = border;
  const [paddingTop = 0, , , paddingLeft = 0] = padding;
  const display = Option.match(styleOf(element), {
    onNone: () => "",
    onSome: (style) => style.display,
  });
  const folded = fold(measured.children, elements, named, itemised.has(display));
  const contentX = measured.x + borderLeft + paddingLeft;
  const contentY = measured.y + borderTop + paddingTop;

  return {
    element: named.join(" > "),
    ...extentOf(measured),
    inner: {
      x: measured.x + borderLeft,
      y: measured.y + borderTop,
      width: measured.width - borderLeft - borderRight,
      height: measured.height - borderTop - borderBottom,
    },
    clips: clipsOf(element),
    runs: [
      ...measured.runs.map((run) => ({ ...run, x: contentX + run.x, y: contentY + run.y })),
      ...folded.runs,
    ],
    anonymous: folded.anonymous,
    children: folded.children,
  };
};

/** The screen's box: the viewport-sized root, which scrolls down but not sideways. */
const screenOf = (measured: Measured, elements: ReadonlyArray<Element>): Box => {
  // The root lays its children out as a flex column.
  const folded = fold(measured.children, elements, [], true);

  return {
    element: "screen",
    ...extentOf(measured),
    inner: extentOf(measured),
    clips: { x: false, y: true },
    runs: folded.runs,
    anonymous: folded.anonymous,
    children: folded.children,
  };
};
