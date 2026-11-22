import { describe, expect, it } from "vite-plus/test";
import {
  comparisonReadCost,
  maxCostShare,
  netRevenue,
  planCost,
  planMargin,
  resultBytesBound,
  topUpMargin,
  unit,
  workload,
} from "../src/Billing/CostModel.ts";
import {
  chargedRows,
  chargedStoryRows,
  GB,
  minBytesPerRow,
  minRowsPerBatch,
  storyBytesPerRow,
  storyStoredCopies,
  plans,
  topUps,
  type PlanConfig,
} from "../src/Billing/Plan.ts";

describe("cost model", () => {
  for (const plan of plans)
    it(`plan ${plan.id}: worst-case cost is at most ${maxCostShare * 100}% of net revenue`, () => {
      const margin = planMargin(plan);
      expect(margin.cost.total).toBeLessThanOrEqual(margin.revenue * maxCostShare);
    });

  for (const topUp of topUps)
    it(`top-up ${topUp.id}: worst-case cost is at most ${maxCostShare * 100}% of net revenue`, () => {
      const margin = topUpMargin(topUp);
      expect(margin.cost.total).toBeLessThanOrEqual(margin.revenue * maxCostShare);
    });

  it("fails an unprofitable plan shape", () => {
    const base = plans[0] as PlanConfig;
    const generous: PlanConfig = {
      ...base,
      limits: { ...base.limits, requestsPerMinute: base.limits.requestsPerMinute * 4 },
    };
    expect(planMargin(generous).profitable).toBe(false);
    const cheap: PlanConfig = { ...base, price: { ...base.price, amount: base.price.amount / 2 } };
    expect(planMargin(cheap).profitable).toBe(false);
    const storage: PlanConfig = { ...base, limits: { ...base.limits, storedBytes: 1_000 * GB } };
    expect(planMargin(storage).profitable).toBe(false);
  });

  it("counts storage full all month and Stripe's worst-case fees", () => {
    // the stored bytes are kept for the whole retention after the last paid period too
    expect(planCost({ ...plans[0].limits, storedBytes: 100 * GB }).r2Storage).toBeCloseTo(
      100 * unit.r2StorageGbMonth * (1 + plans[0].limits.retentionDays / 31),
    );
    // 100 EUR at 3.15% + 2% + 0.7% + 1.80 SEK
    expect(netRevenue({ amount: 10_000, currency: "eur" })).toBeCloseTo(
      100 * (1 - 0.0585) - 1.8 * 0.12,
    );
  });
});

describe("results rows", () => {
  it("charge at least what a results object's bytes pay for, whatever count is reported", () => {
    for (const bytes of [0, 1, 1_023, 1_024, 1_025, 10_000, 1_000_000])
      for (const count of [0, 1, 50])
        expect(chargedRows({ count, bytes }) * minBytesPerRow).toBeGreaterThanOrEqual(bytes);
    expect(chargedRows({ count: 0, bytes: 1_000_000 })).toBe(977);
    expect(chargedRows({ count: 2_000, bytes: 1_000_000 })).toBe(2_000);
  });

  it("charge a typical item about one row, and never less than the smallest valid item", () => {
    // the smallest valid encodings of a fuzz trace, a fuzz case and a Playwright test
    const smallest = [
      {
        name: "",
        subject: { kind: "page", name: "p" },
        schemaHash: "h",
        seed: 0,
        initial: null,
        steps: [],
        failure: null,
      },
      {
        name: "",
        subject: { kind: "page", name: "p" },
        schemaHash: "h",
        case: { id: "", index: 0, seed: 0, path: "", value: null, edges: [], outcome: "ok" },
      },
      {
        id: "t",
        title: "",
        titlePath: [],
        file: "",
        line: 0,
        column: 0,
        project: "",
        status: "passed",
        expectedStatus: "passed",
        duration: 0,
        retries: 0,
        tags: [],
        annotations: [],
        attempts: [],
      },
    ];
    const sizes = smallest.map((item) => JSON.stringify(item).length + 1);
    expect(Math.min(...sizes)).toBe(116);
    expect(minBytesPerRow).toBeGreaterThan(Math.max(...sizes));
    // a 1 KB test is one row
    expect(chargedRows({ count: 1, bytes: 1_000 })).toBe(1);
  });

  for (const plan of plans)
    it(`plan ${plan.id}: the worst case pays comparison reading every byte its rows can carry`, () => {
      expect(resultBytesBound(plan.limits.resultRowsPerPeriod)).toBe(
        plan.limits.resultRowsPerPeriod * minBytesPerRow,
      );
      expect(planCost(plan.limits).durableObjects).toBeGreaterThan(
        comparisonReadCost(plan.limits.resultRowsPerPeriod),
      );
    });
});

describe("story reports", () => {
  it("cost no more stored metadata per charged row than a results batch", () => {
    const perBatchRow = workload.metadataBytesPerBatch / minRowsPerBatch;
    expect(storyBytesPerRow).toBeLessThanOrEqual(perBatchRow);
    for (const bytes of [0, 300, 500, 2_000, 5_600]) {
      const rows = chargedStoryRows({ bytes });
      expect((storyStoredCopies * bytes) / rows).toBeLessThanOrEqual(perBatchRow);
      expect(rows).toBeGreaterThanOrEqual(minRowsPerBatch);
    }
    // a summary up to 500 bytes is one results batch; a typical one (about 600 bytes) 60 rows
    expect(chargedStoryRows({ bytes: 500 })).toBe(minRowsPerBatch);
    expect(chargedStoryRows({ bytes: 600 })).toBe(60);
  });

  for (const plan of plans)
    it(`plan ${plan.id}: holds ${Math.floor(plan.limits.resultRowsPerPeriod / 60)} typical stories a month`, () => {
      expect(Math.floor(plan.limits.resultRowsPerPeriod / chargedStoryRows({ bytes: 600 }))).toBe(
        Math.floor(plan.limits.resultRowsPerPeriod / 60),
      );
    });
});
