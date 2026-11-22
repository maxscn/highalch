import { Predicate } from "effect";
import { Window } from "happy-dom";

/** A happy-dom window installed as the global DOM for one story run, and how to remove it. */
export type Installed = {
  readonly window: Window;
  readonly remove: () => Promise<void>;
};

/** Globals React DOM and components read; installed only while a screen is mounted. */
const always = ["window", "document", "navigator", "location", "getComputedStyle"];

/**
 * Installs a happy-dom window as the global DOM: `window`, `document` and every window property
 * the global scope lacks (`HTMLElement`, `Node`, `MutationObserver`, …). Properties the runtime
 * already has (timers, `fetch`, `Event`, …) stay the runtime's, except the few in `always`.
 * `remove` restores the global scope exactly and closes the window, so other tests keep their
 * environment.
 */
export const install = (width: number, height: number): Installed => {
  const window = new Window({ url: "http://localhost/", width, height });
  const previous = new Map<string, PropertyDescriptor | undefined>();

  const names = Object.getOwnPropertyNames(window).filter(
    (name) => !always.includes(name) && !(name in globalThis),
  );

  for (const name of [...always, ...names]) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, bound(window, name));
  }

  const remove = async () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }

    await window.happyDOM.abort();
    window.close();
  };

  return { window, remove };
};

/** A window property's descriptor, found on the window or its prototypes. */
const descriptorOf = (window: Window, name: string): PropertyDescriptor | undefined => {
  for (let at: object | null = window; at !== null; at = Object.getPrototypeOf(at)) {
    const found = Object.getOwnPropertyDescriptor(at, name);

    if (found) return found;
  }

  return undefined;
};

/** A global that reads the window's property with the window as `this` (getters, methods). */
const bound = (window: Window, name: string): PropertyDescriptor => {
  if (name === "window") return { value: window, configurable: true, writable: true };

  const descriptor = descriptorOf(window, name);

  if (descriptor?.get) return { get: () => descriptor.get?.call(window), configurable: true };

  const value = descriptor?.value;

  if (Predicate.isFunction(value) && name === "getComputedStyle")
    return { value: value.bind(window), configurable: true, writable: true };

  return { value, configurable: true, writable: true };
};

const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * The HTML of a mounted tree as it looks now, for a renderer that runs no script: an `input`,
 * `textarea` or `select` becomes a `span` with the same attributes (and `data-control` naming
 * the control) whose text is its current value (a password masked, a checkbox ☑/☐), since the
 * renderer paints no form controls and the attributes hold stale values. Scripts are dropped.
 */
export const serialize = (root: Element): string => copyOf(root, false).html;

/**
 * The same HTML with every element numbered (`data-box="3"`), and the live elements by number:
 * what a layout engine's boxes are matched back to.
 */
export const numbered = (root: Element) => copyOf(root, true);

const copyOf = (
  root: Element,
  number: boolean,
): { readonly html: string; readonly elements: ReadonlyArray<Element> } => {
  const copy = root.cloneNode(true);

  if (!(copy instanceof Element)) return { html: "", elements: [] };

  const elements = [...root.querySelectorAll("*")];

  if (number)
    [...copy.querySelectorAll("*")].forEach((element, index) =>
      element.setAttribute("data-box", String(index)),
    );

  const live = [...root.querySelectorAll("input, textarea, select")];
  const cloned = [...copy.querySelectorAll("input, textarea, select")];

  cloned.forEach((control, index) => {
    const source = live[index];
    const span = control.ownerDocument.createElement("span");

    for (const attribute of control.attributes)
      if (attribute.name !== "value") span.setAttribute(attribute.name, attribute.value);

    span.setAttribute("data-control", control.tagName.toLowerCase());
    span.textContent = valueOf(source);
    control.replaceWith(span);
  });

  for (const script of copy.querySelectorAll("script")) script.remove();

  return { html: copy.innerHTML, elements };
};

const valueOf = (control: Element | undefined): string => {
  if (control instanceof window.HTMLInputElement) {
    if (control.type === "checkbox" || control.type === "radio") return control.checked ? "☑" : "☐";

    if (control.type === "password") return "•".repeat(control.value.length);

    return control.value;
  }

  if (control instanceof window.HTMLTextAreaElement) return control.value;

  if (control instanceof window.HTMLSelectElement)
    return [...control.selectedOptions].map((option) => option.text).join(", ");

  return "";
};

export { escape };
