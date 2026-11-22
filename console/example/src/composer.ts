import { Schema } from "effect";

/** Message composer state, as in the CRM's `composer-machine`. */
export const ComposerState = Schema.Union([
  Schema.TaggedStruct("Editing", { draft: Schema.String }),
  Schema.TaggedStruct("Sending", { draft: Schema.String, attempts: Schema.Int }),
  Schema.TaggedStruct("Failed", {
    draft: Schema.String,
    attempts: Schema.Int,
    message: Schema.String,
  }),
  Schema.TaggedStruct("Sent", { draft: Schema.String, attempts: Schema.Int }),
]).annotate({ identifier: "ComposerState" });
export type ComposerState = typeof ComposerState.Type;

export const ComposerAction = Schema.Union([
  Schema.TaggedStruct("Type", { text: Schema.String.check(Schema.isMaxLength(40)) }),
  Schema.TaggedStruct("Send", {}),
  Schema.TaggedStruct("Delivered", {}),
  Schema.TaggedStruct("DeliveryFailed", { message: Schema.String }),
  Schema.TaggedStruct("Edit", {}),
]).annotate({ identifier: "ComposerAction" });
export type ComposerAction = typeof ComposerAction.Type;

export const initial: ComposerState = { _tag: "Editing", draft: "" };

/** Pure transition `f(state, action) => next state`; unknown pairs leave the state unchanged. */
export const transition = (state: ComposerState, action: ComposerAction): ComposerState => {
  switch (state._tag) {
    case "Editing":
      if (action._tag === "Type") return { _tag: "Editing", draft: state.draft + action.text };
      if (action._tag === "Send" && state.draft.trim() !== "")
        return { _tag: "Sending", draft: state.draft, attempts: 1 };
      return state;
    case "Sending":
      if (action._tag === "Delivered")
        return { _tag: "Sent", draft: state.draft, attempts: state.attempts };
      if (action._tag === "DeliveryFailed")
        return { ...state, _tag: "Failed", message: action.message };
      return state;
    case "Failed":
      if (action._tag === "Send")
        return { _tag: "Sending", draft: state.draft, attempts: state.attempts + 1 };
      if (action._tag === "Edit") return { _tag: "Editing", draft: state.draft };
      return state;
    case "Sent":
      if (action._tag === "Edit") return { _tag: "Editing", draft: "" };
      return state;
  }
};

/** Invariants every reachable state must satisfy. */
export const invariant = (state: ComposerState) => {
  if (state._tag !== "Editing" && state.draft.trim() === "")
    throw new Error(`${state._tag} with an empty draft`);
  if ("attempts" in state && state.attempts < 1) throw new Error("attempts must be positive");
};
