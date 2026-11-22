import { formOptions, useForm } from "@tanstack/react-form";
import { useLiveQuery } from "@tanstack/react-db";
import * as LowAlch from "@lowalch/tanstack-db";
import { Schema } from "effect";
import { notes } from "../../../../fixtures/notes";

/**
 * Example: **a long title runs off its card.**
 *
 * The form accepts titles of up to 60 characters. The broken card lays its heading out with the
 * browser's defaults, so one long word (a URL, a part number, a name without spaces) runs past
 * the card's edge. The approved card breaks such a word with `overflow-wrap: anywhere`.
 *
 * Caught by: an exploration typing into the form, whose values include the longest title the
 * schema accepts, with a rule that reads the screen's layout (`Card.layout()`) and finds
 * nothing spilling out of its box (`Screen.overflowing`).
 */
export const TitleInput = Schema.Struct({
  NoteId: Schema.String,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60)),
});

/** The app's own form declaration, shared by the card and the test. */
export const titleForm = formOptions({
  formId: "titleForm",
  defaultValues: { NoteId: "", title: "" },
  validators: { onChange: Schema.toStandardSchemaV1(TitleInput) },
});

const NoteCard =
  (layout: "default" | "wraps") =>
  ({ NoteId, title }: { readonly NoteId: string; readonly title: string }) => {
    const result = useLiveQuery((q) => q.from({ note: notes.list({ account: "acc-1" }) }));
    const form = useForm({
      ...titleForm,
      defaultValues: { NoteId, title },
      onSubmit: ({ value }) => {
        notes.rename({ NoteId: value.NoteId, title: value.title });
      },
    });

    return (
      <main className="page">
        <section className={layout === "wraps" ? "card wraps" : "card"}>
          {LowAlch.match(result).on({
            Ready: ({ data }) => (
              <h1 className="title">{data.find((note) => note.NoteId === NoteId)?.title}</h1>
            ),
            orElse: () => <h1 className="title">…</h1>,
          })}
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
            <button className="save" type="submit">
              Rename
            </button>
          </form>
        </section>
      </main>
    );
  };

export const BrokenNoteCard = NoteCard("default");

export const ApprovedNoteCard = NoteCard("wraps");

/** The cards' stylesheet: an input scrolls its text, so its painted stand-in clips it. */
export const css = `
.page { display: flex; width: 100%; height: 100%; background: #f7f7f2; color: #1d2433; font-size: 15px; }
.card { display: flex; flex-direction: column; gap: 10px; margin: 16px; padding: 14px; width: 328px; background: #ffffff; border: 1px solid #d8dbe2; border-radius: 8px; }
.title { font-size: 18px; margin: 0; }
.wraps .title { overflow-wrap: anywhere; }
.rename { display: flex; flex-direction: column; gap: 8px; }
.field { display: flex; padding: 8px 12px; min-height: 36px; background: #ffffff; border: 1px solid #d8dbe2; border-radius: 6px; overflow: hidden; white-space: nowrap; }
.save { display: flex; justify-content: center; padding: 8px 12px; background: #2a4a8a; color: #ffffff; border-radius: 6px; border: none; }
`;
