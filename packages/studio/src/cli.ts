import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { relay } from "./relay";

/** What `highalch studio` was asked: its port, how many shards, and the test command to run. */
export type Asked = {
  readonly port: number;
  readonly concurrency: number;
  /** Stop once the command ends (by default the studio stays up to be browsed, until Ctrl+C). */
  readonly exit: boolean;
  readonly command: ReadonlyArray<string>;
};

const usage = `usage: highalch studio [--port 4983] [--concurrency 1] [--exit] [-- <test command>]

Starts the studio's relay on 127.0.0.1 and prints the link that opens https://highalch.studio on
it. With a test command, runs it (as --concurrency shards) streaming to the relay.`;

/** The command line, read: `studio [--port n] [--concurrency n] [--exit] [-- command…]`. */
export const parse = (argv: ReadonlyArray<string>): Asked => {
  const split = argv.indexOf("--");
  let flags = [...argv];
  let command: ReadonlyArray<string> = [];

  if (split !== -1) {
    flags = argv.slice(0, split);
    command = argv.slice(split + 1);
  }

  if (flags[0] !== "studio") throw new Error(usage);

  const number = (flag: string, fallback: number) => {
    const at = flags.indexOf(flag);

    if (at === -1) return fallback;

    const value = Number(flags[at + 1]);

    if (!Number.isInteger(value) || value < 0)
      throw new Error(`${flag} takes a whole number\n\n${usage}`);

    return value;
  };

  const known = new Set(["studio", "--port", "--concurrency", "--exit"]);
  const unknown = flags.filter(
    (flag, index) =>
      !known.has(flag) && !["--port", "--concurrency"].includes(flags[index - 1] ?? ""),
  );

  if (unknown.length > 0) throw new Error(`unknown: ${unknown.join(" ")}\n\n${usage}`);

  const concurrency = number("--concurrency", 1);

  if (concurrency < 1) throw new Error(`--concurrency is at least 1\n\n${usage}`);

  return { port: number("--port", 4983), concurrency, exit: flags.includes("--exit"), command };
};

/** Where the studio writes and how it runs a shard: the process's own, unless a test gives others. */
export type Io = {
  readonly log: (line: string) => void;
  readonly run: (
    command: ReadonlyArray<string>,
    env: Readonly<Record<string, string | undefined>>,
  ) => Promise<number>;
};

const io: Io = {
  log: (line) => console.log(line),
  run: (command, env) =>
    new Promise((resolve) => {
      const [program = "", ...args] = command;
      const child = spawn(program, args, { stdio: "inherit", env });

      // Killed by a signal: a failure.
      child.on("exit", (code, signal) => {
        if (code !== null) return resolve(code);

        resolve(Number(signal !== null));
      });
      child.on("error", () => resolve(127));
    }),
};

/**
 * `highalch studio`: starts the relay, prints the link, and runs the command as `concurrency`
 * shards of one run, each streaming to the relay (`HIGHALCH_STREAM_URL`, `HIGHALCH_STREAM_TOKEN`,
 * `HIGHALCH_RUN`, and `HIGHALCH_SHARD=i/n` when there are several). The worst exit code is the
 * studio's. It stays up to be browsed until Ctrl+C, unless `--exit`.
 */
export const studio = async (asked: Asked, using: Io = io) => {
  const running = await relay({ port: asked.port });

  using.log(`HighAlch studio on ${running.url}`);
  using.log(`Open ${running.link}`);

  const env = {
    HIGHALCH_STREAM_URL: running.url,
    HIGHALCH_STREAM_TOKEN: running.ingest,
    HIGHALCH_RUN: randomUUID(),
  };

  if (asked.command.length === 0) {
    using.log("Stream to it from your tests with:");

    for (const [name, value] of Object.entries(env)) using.log(`  ${name}=${value}`);

    return { relay: running, code: 0 };
  }

  const codes = await Promise.all(
    Array.from({ length: asked.concurrency }, (_, index) =>
      using.run(asked.command, {
        ...process.env,
        ...env,
        ...(asked.concurrency > 1 && { HIGHALCH_SHARD: `${index + 1}/${asked.concurrency}` }),
      }),
    ),
  );
  const code = Math.max(...codes);

  using.log(`The tests ended (exit code ${code}).`);

  if (asked.exit) {
    await running.close();

    return { relay: running, code };
  }

  using.log("The studio stays up to be browsed: Ctrl+C stops it.");

  return { relay: running, code };
};

/** Runs as the `highalch` command. */
export const main = async () => {
  try {
    const { relay: running, code } = await studio(parse(process.argv.slice(2)));

    process.exitCode = code;

    process.once("SIGINT", () => {
      void running.close().then(() => process.exit(code));
    });
  } catch (error) {
    if (error instanceof Error) console.error(error.message);
    else console.error(String(error));
    process.exitCode = 2;
  }
};
