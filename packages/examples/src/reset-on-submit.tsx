import { formOptions, useForm } from "@tanstack/react-form";
import { Schema } from "effect";
import { notes } from "../../../fixtures/notes";

/**
 * Example: **a rejected rename loses what the user typed.**
 *
 * The broken form resets itself as soon as it submits, so when the server rejects the title
 * (`NoteLocked`) the user's draft is gone and the field shows the old title again. The approved
 * form keeps the draft until the rename commits.
 *
 * Caught by: an exploration typing into the form (`Form.typing`), submitting and settling, with
 * the rule "a rejected rename keeps what you typed".
 */
export const RenameInput = Schema.Struct({ NoteId: Schema.String, title: Schema.NonEmptyString });

/** The app's own form declaration, shared by the component and the test. */
export const renameForm = formOptions({
  formId: "renameForm",
  defaultValues: { NoteId: "", title: "" },
  validators: { onChange: Schema.toStandardSchemaV1(RenameInput) },
});

const RenameForm =
  (onRejection: "keep" | "reset") =>
  ({ NoteId, title }: { readonly NoteId: string; readonly title: string }) => {
    const form = useForm({
      ...renameForm,
      defaultValues: { NoteId, title },
      onSubmit: ({ value, formApi }) => {
        notes.rename({ NoteId: value.NoteId, title: value.title });

        // The bug: forgets the draft before the server answers.
        if (onRejection === "reset") formApi.reset();
      },
    });

    return (
      <form
        className="rename"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.Field name="title">
          {(field) => (
            <input
              className="field"
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
            />
          )}
        </form.Field>
        <button type="submit">Rename</button>
      </form>
    );
  };

export const BrokenRenameForm = RenameForm("reset");

export const ApprovedRenameForm = RenameForm("keep");
