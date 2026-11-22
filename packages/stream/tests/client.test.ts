import { Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fromEnv } from "@highalch/stream";

const ingest = "hat_ingest_secret";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("f(environment) → whether and where a process streams", () => {
  it("f(no URL) → none; f(URL, token, GitHub Actions, shard) → its settings, the token taken out", () => {
    expect(Option.isNone(fromEnv({}))).toBe(true);

    const settings = fromEnv({
      HIGHALCH_STREAM_URL: "https://app.example/stream",
      HIGHALCH_STREAM_TOKEN: ingest,
      HIGHALCH_SHARD: "2/4",
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "acme/notes",
      GITHUB_SHA: "c41e9a0",
      GITHUB_REF: "refs/pull/57/merge",
      GITHUB_HEAD_REF: "feat/inline-rename",
      GITHUB_RUN_ID: "8812",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_JOB: "test",
    });

    expect(Option.getOrThrow(settings)).toEqual({
      url: "https://app.example/stream",
      auth: { kind: "token", token: ingest },
      // Every job of the run, so every shard, streams to the same run.
      run: "acme/notes/8812/2",
      shard: { index: 2, total: 4 },
      origin: {
        repository: "acme/notes",
        commit: "c41e9a0",
        branch: "feat/inline-rename",
        pullRequest: 57,
        ci: {
          provider: "github",
          run: "8812",
          attempt: "2",
          job: "test",
          url: "https://github.com/acme/notes/actions/runs/8812",
        },
      },
      frames: "every",
    });

    vi.stubEnv("HIGHALCH_STREAM_URL", "http://localhost:4983");
    vi.stubEnv("HIGHALCH_STREAM_TOKEN", ingest);

    expect(Option.isSome(fromEnv())).toBe(true);
    // Read once, then gone: the code under test can't read the ingest token.
    expect(process.env.HIGHALCH_STREAM_TOKEN).toBeUndefined();

    vi.unstubAllEnvs();
  });

  it("f(plain HTTP elsewhere, credentials in the URL, no credentials, a bad shard) → refused", () => {
    const refused = (env: Record<string, string>) => () =>
      fromEnv({ HIGHALCH_STREAM_TOKEN: ingest, ...env });

    expect(refused({ HIGHALCH_STREAM_URL: "http://app.example/stream" })).toThrow(/not HTTPS/);
    expect(refused({ HIGHALCH_STREAM_URL: "https://app.example/stream?token=x" })).toThrow(
      /no credentials or query/,
    );
    expect(refused({ HIGHALCH_STREAM_URL: "https://key@app.example/stream" })).toThrow(
      /no credentials or query/,
    );
    expect(() => fromEnv({ HIGHALCH_STREAM_URL: "https://app.example/stream" })).toThrow(
      /without credentials/,
    );
    expect(
      refused({ HIGHALCH_STREAM_URL: "https://app.example/stream", HIGHALCH_SHARD: "5/4" }),
    ).toThrow(/"5\/4"/);
    expect(
      Option.getOrThrow(
        fromEnv({
          HIGHALCH_STREAM_URL: "https://app.example/stream",
          HIGHALCH_STREAM_AUTH: "github-oidc",
        }),
      ).auth,
    ).toEqual({ kind: "github-oidc" });
  });
});
