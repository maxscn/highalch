/** A typed Domain value: an event, a command, a rejection or an error, by its `_tag`. */
export type Tagged = Readonly<Record<"_tag", string>>;

/** A Domain query's or command's input, already typed by its declaration. */
export interface Input {}

/** A Domain query's answer or a command's reply, decoded by its schema. */
export interface Answer {}
