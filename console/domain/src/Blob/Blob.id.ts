import * as Schema from "effect/Schema";

/** `<organizationId>:<sha256>`: deduplication never crosses organisations. */
export const BlobId = Schema.String.pipe(Schema.brand("BlobId"));
export type BlobId = typeof BlobId.Type;

export const blobId = (org: string, sha256: string) => BlobId.make(`${org}:${sha256}`);

/** The R2 key of a blob generation. A forgotten blob is re-uploaded under the next generation. */
export const objectKey = (org: string, sha256: string, generation: number) =>
  `a/${org}/${sha256}/${generation}`;
