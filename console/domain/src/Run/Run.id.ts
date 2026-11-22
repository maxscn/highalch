import * as Schema from "effect/Schema";

export const RunId = Schema.String.pipe(Schema.brand("RunId"));
export type RunId = typeof RunId.Type;

/** `<runId>.<n>`: the n-th artifact a run declared (1-based), also its entry in `RunArtifacts`. */
export const artifactId = (run: string, index: number) => `${run}.${index}`;

export const parseArtifactId = (id: string): { run: RunId; index: number } | undefined => {
  const found = /^(.+)\.(\d{1,9})$/.exec(id);
  if (!found?.[1] || !found[2]) return undefined;
  const index = Number(found[2]);
  return index >= 1 ? { run: RunId.make(found[1]), index } : undefined;
};
