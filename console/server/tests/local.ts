import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ConsoleApi } from "@highalch/console-domain/Console.api";
import { sessionCookie } from "@highalch/console-domain/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { localConfig } from "../alchemy.run.ts";

/**
 * The Worker under `alchemy dev --stage local` (workerd, local R2/D1/Durable Objects, no
 * account touched), for end-to-end tests. `HIGHALCH_WORKER_URL` reuses one already running.
 */

const root = fileURLToPath(new URL("..", import.meta.url));

export const appOrigin = localConfig.HIGHALCH_APP_ORIGIN;
export const artifactOrigin = localConfig.HIGHALCH_ARTIFACT_ORIGIN;

export interface Running {
  readonly url: string;
  readonly stop: () => Promise<void>;
}

/** Starts the local stage and waits until the Worker is ready (or reuses a running one). */
export const start = (): Promise<Running> => {
  const reuse = process.env.HIGHALCH_WORKER_URL;
  if (reuse) return Promise.resolve({ url: reuse, stop: () => Promise.resolve() });
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(
      "node_modules/.bin/alchemy",
      ["dev", "--no-input", "--stage", "local"],
      {
        cwd: root,
        detached: true,
        env: {
          ...process.env,
          // never a real account: no profile, the placeholder account id
          ALCHEMY_PROFILE: "highalch-local-only",
          CLOUDFLARE_ACCOUNT_ID: "00000000000000000000000000000000",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    const stop = () =>
      new Promise<void>((done) => {
        if (child.exitCode !== null || child.pid === undefined) return done();
        child.once("exit", () => done());
        process.kill(-child.pid, "SIGTERM");
      });
    const timer = setTimeout(() => {
      void stop();
      reject(new Error(`alchemy dev did not start:\n${output}`));
    }, 120_000);
    const read = (chunk: Buffer) => {
      output += chunk.toString();
      if (/ready at http:\/\/localhost:4810/.test(output)) {
        clearTimeout(timer);
        resolve({ url: appOrigin, stop });
      }
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`alchemy dev exited with ${code}:\n${output}`));
    });
  });
};

/** A fresh user signed up through Better Auth; answers its `cookie` header value. */
export const signUp = async (email = `owner-${randomBytes(4).toString("hex")}@example.com`) => {
  const response = await fetch(`${appOrigin}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appOrigin },
    body: JSON.stringify({ email, password: "correct-horse-battery-staple", name: "Owner" }),
  });
  if (!response.ok) throw new Error(`sign-up failed: ${response.status} ${await response.text()}`);
  const cookie = response.headers
    .getSetCookie()
    .find((line) => line.startsWith(`${sessionCookie}=`))
    ?.split(";")[0];
  const body = (await response.json()) as { readonly user: { readonly id: string } };
  if (!cookie) throw new Error("no session cookie");
  return { cookie, email, user: body.user.id };
};

/** ConsoleApi over HTTP with these headers on every call. */
export const apiWith = (headers: Record<string, string>) =>
  ConsoleApi.clientHttp(`${appOrigin}/api/console`).pipe(
    Effect.provide(
      Layer.effect(
        HttpClient.HttpClient,
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          return HttpClient.mapRequest(client, HttpClientRequest.setHeaders(headers));
        }),
      ).pipe(Layer.provide(FetchHttpClient.layer)),
    ),
  );

/** Delivers a Stripe event signed with the local stage's webhook secret. */
export const deliverStripeEvent = async (type: string, object: unknown) => {
  const payload = JSON.stringify({
    id: `evt_${randomBytes(8).toString("hex")}`,
    object: "event",
    type,
    data: { object },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac(
    "sha256",
    localConfig.STRIPE_WEBHOOK_SECRET__api_billing_stripe_webhook,
  )
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  return fetch(`${appOrigin}/api/billing/stripe-webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${timestamp},v1=${signature}`,
    },
    body: payload,
  });
};
