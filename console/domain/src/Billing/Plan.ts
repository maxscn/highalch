/**
 * The one typed table of everything HighAlch Console sells. Enforcement (the Organization aggregate),
 * the public price list (`GET /v1/plans`), the Stripe products and prices (alchemy stack) and
 * the profitability test all read it. Prices are in the currency's minor unit.
 */

export const GB = 1_000_000_000;
export const MB = 1_000_000;

export interface Limits {
  /** Bytes kept at once (artifacts + results JSON) until retention deletes them. */
  readonly storedBytes: number;
  /** Bytes declared (artifacts + results JSON) per paid period. */
  readonly uploadedBytesPerPeriod: number;
  readonly artifactsPerPeriod: number;
  /** Tests, fuzz cases and traces per paid period (a results batch counts at least {@link minRowsPerBatch}). */
  readonly resultRowsPerPeriod: number;
  readonly runsPerPeriod: number;
  readonly maxArtifactBytes: number;
  readonly retentionDays: number;
  /** API requests per minute for the whole organisation, and for each API key. */
  readonly requestsPerMinute: number;
  /** Runs open (created, not completed) at once. */
  readonly activeRuns: number;
}

export interface Price {
  readonly amount: number;
  readonly currency: "eur";
}

export interface PlanConfig {
  readonly id: string;
  readonly name: string;
  readonly price: Price;
  readonly interval: "month";
  readonly limits: Limits;
}

export interface TopUpAllowance {
  readonly uploadedBytes: number;
  readonly artifacts: number;
  readonly resultRows: number;
}

export interface TopUpConfig {
  readonly id: string;
  readonly name: string;
  readonly price: Price;
  readonly adds: TopUpAllowance;
}

/** A results batch is charged at least this many rows (it costs storage writes regardless). */
export const minRowsPerBatch = 50;

/**
 * Bytes of a results object one charged row pays for: about one typical item (a Playwright test
 * with an attempt and a step, a fuzz case with a small value, or a short trace encode to roughly
 * 0.5–2 KB), so an honest batch is charged about one row per item. A pricing choice, not a
 * bound: the smallest item the protocol accepts is 115 bytes (a fuzz trace), so a client can pack
 * up to ~9 items into one charged row.
 *
 * That cannot buy free work. A results object of `bytes` is charged at least
 * `ceil(bytes / minBytesPerRow)` rows whatever count the client reports (`chargedRows`), its
 * bytes count as uploaded bytes, and server-side processing reads at most its charged rows of
 * items (`SnapshotComparison` asks storage for no more, and records the rest as truncated). So
 * every item the server processes was paid for as a row, and every byte as uploaded bytes:
 * a period's processing is bounded by `resultRowsPerPeriod` items and its bytes by
 * `uploadedBytesPerPeriod` and `resultRowsPerPeriod × minBytesPerRow` (CostModel's worst case).
 */
export const minBytesPerRow = 1_024;

/**
 * A story is kept in the model as one bounded summary (its steps stay in its `story.json`):
 * the organisation's event, the run's event, the run's story index and the feed's story row
 * each hold it, so it is stored about `storyStoredCopies` times and never deleted.
 */
export const storyStoredCopies = 4;

/**
 * Stored metadata bytes one charged row may cost: what a results batch keeps per row it is
 * charged at least (CostModel's `metadataBytesPerBatch` 2 048 bytes over `minRowsPerBatch`
 * 50 rows, rounded down). Charging stories by this keeps every row no costlier than a results
 * row, so the plans' worst case (every row spent the most expensive way) still holds.
 */
export const storyBytesPerRow = 40;

/**
 * The rows a story is charged: one results batch (`minRowsPerBatch`), more only when its
 * summary is unusually large, so that its stored copies never cost more per row than a
 * results batch's (`storyBytesPerRow`). A summary is bounded (about 5.6 KB at most: at most
 * 560 rows); a typical one (under 500 bytes) is charged exactly one batch.
 */
export const chargedStoryRows = (summary: { readonly bytes: number }) =>
  Math.max(minRowsPerBatch, Math.ceil((storyStoredCopies * summary.bytes) / storyBytesPerRow));

/** The rows a results object is charged: its reported items, at least what its bytes can hold. */
export const chargedRows = (part: { readonly count: number; readonly bytes: number }) =>
  Math.max(part.count, Math.ceil(part.bytes / minBytesPerRow));
/** Each run counts this many bytes against `uploadedBytesPerPeriod` (its metadata). */
export const runOverheadBytes = 16_384;
/** Organisations one user may own (orgs are created before anyone pays). */
export const maxOwnedOrganizations = 3;
/** Projects per organisation and active API keys per project (state stays bounded). */
export const maxProjects = 50;
export const maxApiKeys = 20;
/** Dashboard writes (create org/project/key, revoke, checkout, portal) per minute per user. */
export const dashboardWritesPerMinute = 3;
/** Lifetime of a presigned upload URL, seconds. */
export const uploadUrlSeconds = 60;
/** Lifetime of a signed artifact download URL, seconds. */
export const downloadUrlSeconds = 300;
/** A run that is not completed within this many hours is completed by the server. */
export const runExpiryHours = 6;

export const plans = [
  {
    id: "starter",
    name: "Starter",
    price: { amount: 5_900, currency: "eur" },
    interval: "month",
    limits: {
      storedBytes: 10 * GB,
      uploadedBytesPerPeriod: 20 * GB,
      artifactsPerPeriod: 5_000,
      resultRowsPerPeriod: 100_000,
      runsPerPeriod: 1_000,
      maxArtifactBytes: 25 * MB,
      retentionDays: 14,
      requestsPerMinute: 20,
      activeRuns: 5,
    },
  },
  {
    id: "team",
    name: "Team",
    price: { amount: 14_900, currency: "eur" },
    interval: "month",
    limits: {
      storedBytes: 50 * GB,
      uploadedBytesPerPeriod: 100 * GB,
      artifactsPerPeriod: 20_000,
      resultRowsPerPeriod: 500_000,
      runsPerPeriod: 5_000,
      maxArtifactBytes: 100 * MB,
      retentionDays: 30,
      requestsPerMinute: 80,
      activeRuns: 20,
    },
  },
  {
    id: "business",
    name: "Business",
    price: { amount: 44_900, currency: "eur" },
    interval: "month",
    limits: {
      storedBytes: 250 * GB,
      uploadedBytesPerPeriod: 500 * GB,
      artifactsPerPeriod: 60_000,
      resultRowsPerPeriod: 2_000_000,
      runsPerPeriod: 20_000,
      maxArtifactBytes: 200 * MB,
      retentionDays: 90,
      requestsPerMinute: 240,
      activeRuns: 50,
    },
  },
] as const satisfies ReadonlyArray<PlanConfig>;

export const topUps = [
  {
    id: "boost",
    name: "Boost pack",
    price: { amount: 1_900, currency: "eur" },
    adds: { uploadedBytes: 10 * GB, artifacts: 2_000, resultRows: 50_000 },
  },
] as const satisfies ReadonlyArray<TopUpConfig>;

export type PlanId = (typeof plans)[number]["id"];
export type TopUpId = (typeof topUps)[number]["id"];

export const findPlan = (id: string): PlanConfig | undefined => plans.find((p) => p.id === id);
export const findTopUp = (id: string): TopUpConfig | undefined => topUps.find((t) => t.id === id);
