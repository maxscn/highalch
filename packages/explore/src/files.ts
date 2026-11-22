import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Option } from "effect";

/** Where an exploration's files go: a path, or a `file:` URL (`new URL("./explore/", import.meta.url)`). */
export type Place = string | URL;

/** A place as a path. */
export const pathOf = (place: Place) => {
  if (place instanceof URL) return fileURLToPath(place);

  return place;
};

/** A name as a file name: lower case, words joined by `-`. */
export const slug = (text: string) =>
  text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 80) || "exploration";

/** Writes a file, making its folder. */
export const write = async (file: string, content: string) => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
};

/** A text file's content, or `None` when there is none. */
export const readText = async (file: string) =>
  readFile(file, "utf8").then(
    (text) => Option.some(text),
    () => Option.none<string>(),
  );
