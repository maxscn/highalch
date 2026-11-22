/**
 * How the boards write values: durations in mono with a non-breaking space ("612 ms", "5.92 s",
 * "6 min 42 s"), relative times ("18 minutes ago"), short SHAs, counts with separators.
 */

const NB = " ";

export const duration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}${NB}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}${NB}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  if (minutes < 60)
    return seconds === 0 ? `${minutes}${NB}min` : `${minutes}${NB}min ${seconds}${NB}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}${NB}h ${minutes % 60}${NB}min`;
};

const units: ReadonlyArray<readonly [number, string]> = [
  [365 * 86_400_000, "year"],
  [30 * 86_400_000, "month"],
  [7 * 86_400_000, "week"],
  [86_400_000, "day"],
  [3_600_000, "hour"],
  [60_000, "minute"],
];

/** "18 minutes ago", "2 days ago", "just now". */
export const ago = (at: number, now: number): string => {
  const elapsed = Math.max(0, now - at);
  for (const [size, unit] of units) {
    const n = Math.floor(elapsed / size);
    if (n >= 1) return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  }
  return "just now";
};

/** "2 days", "20 hours": the commit timeline's compact age. */
export const age = (at: number, now: number): string => ago(at, now).replace(/ ago$/, "");

export const shortSha = (sha: string) => sha.slice(0, 7);

export const count = (n: number) => n.toLocaleString("en-US");

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${count(n)} ${n === 1 ? one : many}`;

export const percent = (part: number, whole: number) =>
  whole === 0 ? "0%" : `${((part / whole) * 100).toFixed(1)}%`;

export const bytes = (n: number) => {
  if (n < 1024) return `${n}${NB}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}${NB}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}${NB}MB`;
};

/** Initials of a name for an avatar ("Jamie Lee" → "JL"). */
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
