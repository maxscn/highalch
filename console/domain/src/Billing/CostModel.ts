import {
  GB,
  dashboardWritesPerMinute,
  minBytesPerRow,
  minRowsPerBatch,
  plans,
  uploadUrlSeconds,
  type Limits,
  type PlanConfig,
  type Price,
  type TopUpConfig,
} from "./Plan.ts";

/**
 * Worst-case cost model. Unit prices are USD list prices (Cloudflare Workers Paid, R2 Standard,
 * Durable Objects on SQLite, D1) and Stripe's worst case for a Swedish account, as verified on
 * 2026-11-13. Included free allowances are ignored: they are shared by every customer.
 */
export const unit = {
  r2StorageGbMonth: 0.015,
  r2ClassA: 4.5 / 1e6,
  r2ClassB: 0.36 / 1e6,
  r2Egress: 0,
  workerRequest: 0.3 / 1e6,
  workerCpuMs: 0.02 / 1e6,
  doRequest: 0.15 / 1e6,
  doGbSecond: 12.5 / 1e6,
  doStorageGbMonth: 0.2,
  doRowWritten: 1 / 1e6,
  doRowRead: 0.001 / 1e6,
  d1RowRead: 0.001 / 1e6,
  d1RowWritten: 1 / 1e6,
  d1StorageGbMonth: 0.75,
} as const;

/** Stripe, Swedish account, worst case per charge. */
export const stripe = {
  percent: 0.0315,
  fixedSek: 1.8,
  currencyConversion: 0.02,
  billing: 0.007,
} as const;

/**
 * Exchange rates, chosen against us: EUR revenue converted at a weak euro, the SEK fixed fee
 * converted at a strong krona.
 */
export const fx = { usdPerEur: 1.0, usdPerSek: 0.12 } as const;

/** Workload assumptions: each one is a cap the deployment enforces, or a measured upper bound. */
export const workload = {
  /** 31-day month. */
  minutesPerPeriod: 31 * 24 * 60,
  /** Worker `limits.cpu_ms` set in the stack: no request can bill more. */
  cpuMsPerRequest: 50,
  /** Durable Object calls one API request makes at most (auth view, run view, stream, quota, ...). */
  doRequestsPerApiRequest: 6,
  /** Wall time a Durable Object is active per call (128 MB billed). */
  doSecondsPerRequest: 0.05,
  doMemoryGb: 0.128,
  /**
   * R2 Class B operations one API request makes at most: a list page reads at most 3 stored
   * result objects plus the snapshot map; an artifact link reads one object.
   */
  classBPerApiRequest: 5,
  d1RowsReadPerRequest: 10,
  /**
   * A presigned PUT can be replayed until it expires. R2 allows 1 write per second per key
   * and does not bill requests that fail authentication (expired), so at most
   * `uploadUrlSeconds` billed PUTs per issued URL, plus the first.
   */
  putsPerArtifact: 1 + uploadUrlSeconds * 1,
  /** R2 HEADs per artifact: the reuse check at declaration and the verification. */
  classBPerArtifact: 2,
  /** Durable Object calls and rows written per artifact (declare, blob, verify, index). */
  doRequestsPerArtifact: 8,
  doRowsPerArtifact: 25,
  /** Per run: create, open/close quota, views, expiry schedule, completion, index entries. */
  doRequestsPerRun: 20,
  doRowsPerRun: 60,
  /** Per results batch: quota, run event, index entry, R2 object. */
  doRequestsPerBatch: 6,
  doRowsPerBatch: 20,
  classAPerBatch: 1,
  /** Metadata bytes left in Durable Object storage per artifact / run / batch (never deleted). */
  metadataBytesPerArtifact: 2_048,
  metadataBytesPerRun: 16_384,
  metadataBytesPerBatch: 2_048,
  /** Months the never-deleted metadata is paid for, charged to the period that created it. */
  metadataTailMonths: 60,
  /**
   * Snapshot comparison at completion: it reads every result object of the run and of its
   * baseline (2 Class B per batch), runs in a Durable Object (wall time per batch), writes the
   * snapshot map and removed items (Class A per run), and one subject-history entry per
   * subject (worst case one subject per result row).
   */
  comparisonClassBPerBatch: 2,
  comparisonDoSecondsPerBatch: 0.1,
  comparisonClassAPerRun: 4,
  comparisonRowsPerResultRow: 2,
  /**
   * Wall time a Durable Object spends reading and parsing one MB of results objects (JSON parse
   * runs at well over 100 MB/s; this assumes 20). Comparison reads the run's objects and its
   * baseline's, and no more of them than `resultRowsPerPeriod × minBytesPerRow`: a batch is
   * charged at least `bytes / minBytesPerRow` rows, so a period's charged rows bound its
   * results bytes however few items a client reports.
   */
  comparisonDoSecondsPerMbRead: 0.05,
  comparisonSidesRead: 2,
  /** Session (dashboard) requests per minute per user; one member per organisation. */
  sessionRequestsPerMinute: 20,
  /** Requests per minute an organisation gets after its period lapsed, until retention ends. */
  lapsedRequestsPerMinute: 10,
  /** Rows written per dashboard write (org, project, key). */
  doRowsPerDashboardWrite: 10,
} as const;

export interface Breakdown {
  readonly r2Storage: number;
  readonly r2ClassA: number;
  readonly r2ClassB: number;
  readonly workers: number;
  readonly durableObjects: number;
  readonly metadataTail: number;
  readonly d1: number;
  readonly total: number;
}

const sum = (parts: Omit<Breakdown, "total">): Breakdown => ({
  ...parts,
  total: Object.values(parts).reduce((a, b) => a + b, 0),
});

/** Results bytes a period's charged rows can carry at most. */
export const resultBytesBound = (rows: number) => rows * minBytesPerRow;

/** Worst-case Durable Object time of comparison reading a period's results objects (both sides). */
export const comparisonReadCost = (rows: number) =>
  (resultBytesBound(rows) / 1e6) *
  workload.comparisonSidesRead *
  workload.comparisonDoSecondsPerMbRead *
  workload.doMemoryGb *
  unit.doGbSecond;

const doCall = () =>
  unit.doRequest + workload.doMemoryGb * workload.doSecondsPerRequest * unit.doGbSecond;

/** Usage that only uploads drive (artifacts, results batches, runs). */
const uploadCosts = (artifacts: number, batches: number, runs: number, rows: number) => {
  const doRequests =
    artifacts * workload.doRequestsPerArtifact +
    batches * workload.doRequestsPerBatch +
    runs * workload.doRequestsPerRun;
  const rowsWritten =
    artifacts * workload.doRowsPerArtifact +
    batches * workload.doRowsPerBatch +
    runs * workload.doRowsPerRun +
    rows * workload.comparisonRowsPerResultRow;
  const metadataGb =
    (artifacts * workload.metadataBytesPerArtifact +
      batches * workload.metadataBytesPerBatch +
      runs * workload.metadataBytesPerRun) /
    GB;
  return {
    classA:
      (artifacts * workload.putsPerArtifact +
        batches * workload.classAPerBatch +
        runs * workload.comparisonClassAPerRun) *
      unit.r2ClassA,
    classB:
      (artifacts * workload.classBPerArtifact + batches * workload.comparisonClassBPerBatch) *
      unit.r2ClassB,
    durableObjects:
      doRequests * doCall() +
      rowsWritten * unit.doRowWritten +
      batches * workload.comparisonDoSecondsPerBatch * workload.doMemoryGb * unit.doGbSecond +
      comparisonReadCost(rows),
    metadataTail: metadataGb * unit.doStorageGbMonth * workload.metadataTailMonths,
  };
};

/**
 * Worst-case monthly cost of one organisation that uses 100% of every limit for the whole
 * period: storage full all month, every upload allowance spent in the smallest units (most
 * operations), API traffic at the rate limit every minute (each request at the CPU cap), a
 * signed-in member at the session limit, and the tail after the last paid period: storage
 * kept full and lapsed-rate reads for the whole retention, charged to this period.
 */
export const planCost = (limits: Limits): Breakdown => {
  const tailMonths = limits.retentionDays / 31;
  const requests =
    (limits.requestsPerMinute + workload.sessionRequestsPerMinute) * workload.minutesPerPeriod +
    workload.lapsedRequestsPerMinute * workload.minutesPerPeriod * tailMonths;
  const dashboardWrites = dashboardWritesPerMinute * workload.minutesPerPeriod;
  const uploads = uploadCosts(
    limits.artifactsPerPeriod,
    Math.ceil(limits.resultRowsPerPeriod / minRowsPerBatch),
    limits.runsPerPeriod,
    limits.resultRowsPerPeriod,
  );
  return sum({
    r2Storage: (limits.storedBytes / GB) * unit.r2StorageGbMonth * (1 + tailMonths),
    r2ClassA: uploads.classA,
    r2ClassB: uploads.classB + requests * workload.classBPerApiRequest * unit.r2ClassB,
    workers: requests * (unit.workerRequest + workload.cpuMsPerRequest * unit.workerCpuMs),
    durableObjects:
      uploads.durableObjects +
      requests * workload.doRequestsPerApiRequest * doCall() +
      dashboardWrites * workload.doRowsPerDashboardWrite * unit.doRowWritten,
    metadataTail: uploads.metadataTail,
    d1: requests * workload.d1RowsReadPerRequest * unit.d1RowRead,
  });
};

/**
 * Worst-case extra cost of a top-up: its artifacts and results uploaded in the smallest units,
 * and its bytes stored for the longest retention any plan offers (even though the plan's
 * stored-bytes cap already bounds storage). Its requests are inside the plan's rate limit.
 */
export const topUpCost = (topUp: TopUpConfig): Breakdown => {
  const uploads = uploadCosts(
    topUp.adds.artifacts,
    Math.ceil(topUp.adds.resultRows / minRowsPerBatch),
    0,
    topUp.adds.resultRows,
  );
  const months = Math.max(...plans.map((p) => p.limits.retentionDays)) / 30;
  return sum({
    r2Storage: (topUp.adds.uploadedBytes / GB) * unit.r2StorageGbMonth * Math.max(1, months),
    r2ClassA: uploads.classA,
    r2ClassB: uploads.classB,
    workers: 0,
    durableObjects: uploads.durableObjects,
    metadataTail: uploads.metadataTail,
    d1: 0,
  });
};

/** Revenue of one charge in USD after Stripe's worst-case fees. */
export const netRevenue = (price: Price): number => {
  const gross = (price.amount / 100) * fx.usdPerEur;
  const variable = stripe.percent + stripe.currencyConversion + stripe.billing;
  return gross * (1 - variable) - stripe.fixedSek * fx.usdPerSek;
};

/** Highest share of net revenue worst-case costs may take. */
export const maxCostShare = 0.25;

export interface Margin {
  readonly id: string;
  readonly revenue: number;
  readonly cost: Breakdown;
  /** cost.total / revenue */
  readonly share: number;
  readonly profitable: boolean;
}

export const planMargin = (plan: PlanConfig): Margin => {
  const revenue = netRevenue(plan.price);
  const cost = planCost(plan.limits);
  const share = cost.total / revenue;
  return { id: plan.id, revenue, cost, share, profitable: share <= maxCostShare };
};

export const topUpMargin = (topUp: TopUpConfig): Margin => {
  const revenue = netRevenue(topUp.price);
  const cost = topUpCost(topUp);
  const share = cost.total / revenue;
  return { id: topUp.id, revenue, cost, share, profitable: share <= maxCostShare };
};
