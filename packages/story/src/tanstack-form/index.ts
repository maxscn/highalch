/**
 * TanStack Form for stories: steps that type into and submit the app's own forms, readers for
 * rules, and the user typing as an exploration's source. A form is the app's own `formOptions`
 * object; components keep calling stock `useForm`. Stories find the mounted forms through the
 * story kit's Vite plugin (`highalch()` from `@highalch/story/vite`), so the app wires nothing.
 *
 * ```ts
 * import { Form } from "@highalch/story/tanstack-form";
 *
 * Form.when(renameForm, "title", "Ada 2"), Form.submit(renameForm),
 * Form.then(renameForm, { values: { title: "Ada 2" }, isSubmitting: false }),
 * Explore.run({ …, sources: [Form.typing(renameForm, { fields: ["title"] })] }) // @highalch/explore
 * ```
 */
import { all, state, submit, thenIs, typing, when, where } from "./form";
import { forms } from "./registry";

/** The TanStack Form steps, readers and exploration source. */
export const Form = {
  when,
  submit,
  // oxlint-disable-next-line unicorn/no-thenable -- `then` is the given/when/then vocabulary
  then: thenIs,
  where,
  state,
  all,
  typing,
  mounted: forms,
} as const;

export type { Declared, Expected, FieldOf, Target, Typed, Typing, Where } from "./form";
