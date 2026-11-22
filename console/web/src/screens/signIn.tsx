import { useNavigate } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import { useActionState, useTransition } from "react";
import {
  signInWithEmail,
  signInWithGithub,
  type AuthUnreachable,
  type InvalidCredentials,
  type ProviderUnavailable,
} from "../data/auth.ts";
import { Icon, Logo } from "../components/icons.tsx";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import * as HighAlch from "@lowalch/tanstack-db";

type Problem =
  | InvalidCredentials
  | ProviderUnavailable
  | AuthUnreachable
  | { readonly _tag: "Incomplete" }
  | { readonly _tag: "None" };

const message = (problem: Exclude<Problem, { readonly _tag: "None" }>) =>
  HighAlch.match(problem).on({
    Incomplete: () => "Enter your email and password.",
    InvalidCredentials: () => "That email and password don't match an account.",
    ProviderUnavailable: ({ provider }) =>
      `Sign-in with ${provider === "github" ? "GitHub" : provider} is not set up for this HighAlch Console.`,
    AuthUnreachable: () => "HighAlch Console can't be reached. Try again in a moment.",
  });

/**
 * Sign in with GitHub or with email and password, through Better Auth on this origin. A 400-wide
 * panel centred on the page; one ink primary (Sign in), GitHub as the secondary 40-tall button.
 */
export const SignInScreen = () => {
  const navigate = useNavigate();
  const [problem, submit, submitting] = useActionState<Problem, FormData>(
    async (_previous, form) => {
      const field = (name: string) => {
        const value = form.get(name);
        return typeof value === "string" ? value : "";
      };
      const email = field("email").trim();
      const password = field("password");
      if (email === "" || password === "") return { _tag: "Incomplete" };
      const outcome = await Effect.runPromise(Effect.result(signInWithEmail(email, password)));
      if (outcome._tag === "Failure") return outcome.failure;
      await navigate({ to: "/" });
      return { _tag: "None" };
    },
    { _tag: "None" },
  );
  const [github, startGithub] = useTransition();
  const [githubProblem, setGithubProblem] = useActionState<Problem, Problem>(
    (_previous, next) => next,
    { _tag: "None" },
  );
  const withGithub = () =>
    startGithub(async () => {
      const outcome = await Effect.runPromise(
        Effect.result(signInWithGithub(`${window.location.origin}/`)),
      );
      if (outcome._tag === "Failure") setGithubProblem(outcome.failure);
    });
  const shown = githubProblem._tag !== "None" ? githubProblem : problem;
  return (
    <main className="grid min-h-screen place-items-center bg-bg px-4 py-12">
      <section
        aria-labelledby="sign-in-title"
        className="flex w-full max-w-100 flex-col gap-6 rounded-panel border border-border bg-panel p-8"
      >
        <div className="flex flex-col gap-4">
          <span className="flex items-center gap-2 text-body font-semibold">
            <Logo />
            HighAlch Console
          </span>
          <div className="flex flex-col gap-1">
            <h1 id="sign-in-title" className="m-0 text-title">
              Sign in
            </h1>
            <p className="m-0 text-body text-fg-muted">
              Review pull requests from their test results and stories.
            </p>
          </div>
        </div>
        <Button size="lg" onClick={withGithub} disabled={github}>
          <Icon name="branch" />
          Continue with GitHub
        </Button>
        <div className="flex items-center gap-3 text-caption text-fg-subtle">
          <span className="h-px flex-1 bg-border" />
          or with email
          <span className="h-px flex-1 bg-border" />
        </div>
        <form action={submit} className="flex flex-col gap-4" aria-label="Sign in with email">
          <label className="flex flex-col gap-1 text-label font-medium">
            Email
            <Input name="email" type="email" autoComplete="email" />
          </label>
          <label className="flex flex-col gap-1 text-label font-medium">
            Password
            <Input name="password" type="password" autoComplete="current-password" />
          </label>
          {shown._tag === "None" ? null : (
            <p role="alert" className="m-0 flex items-center gap-1 text-caption text-fail">
              <Icon name="alert" />
              {message(shown)}
            </p>
          )}
          <Button type="submit" variant="primary" size="lg" disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </section>
    </main>
  );
};
