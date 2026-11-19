/** An entity row, decoded by its `Rows` schema; this package reads only its key field. */
export interface Row {}

/** A Domain query's or command's input, already typed by its declaration. */
export interface Input {}

/** A Domain query's answer, decoded by its schema: rows, a page of rows, or one row. */
export interface Answer {}

/** The key of a row: its `Rows` key field. */
export const keyOf = (field: string, row: Row): string =>
  // SAFETY: a `Rows` row holds its key under the key field, as its schema declares.
  String((row as Readonly<Record<string, string>>)[field]);
