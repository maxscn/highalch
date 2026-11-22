import { Navigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Button } from "./ui/button.tsx";
import { Skeleton } from "./ui/skeleton.tsx";
import { Icon } from "./icons.tsx";

/**
 * How a read that failed or is still loading looks, everywhere: a typed error names what went
 * wrong in a sentence and offers a retry; an expired or missing session goes to sign-in.
 */

type Tagged = { readonly _tag: string };

const messages: Record<string, string> = {
  NotAllowed: "You don't have access to this.",
  RunMissing: "This run doesn't exist, or it was deleted.",
  ProjectMissing: "This project doesn't exist.",
  OrganizationMissing: "This organisation doesn't exist.",
  InvalidCursor: "This page of results is no longer valid.",
  UnknownArtifact: "An attachment of this run is missing.",
  UnknownResultPart: "Part of this run's results is missing.",
  ConsistencyTimeout: "HighAlch Console took too long to catch up.",
  RpcClientError: "HighAlch Console can't be reached.",
  ItemsUnavailable: "These results could not be downloaded.",
  ItemsUndecodable: "These results are in a format this page doesn't read.",
};

export const messageOf = (error: Tagged) =>
  messages[error._tag] ?? `Something went wrong (${error._tag}).`;

const signedOut = new Set(["CredentialMissing", "SessionInvalid"]);

/** A failed read: its message and a retry, or the way to sign-in when the session is gone. */
export const Failed = ({ error, retry }: { readonly error: Tagged; readonly retry?: () => void }) =>
  signedOut.has(error._tag) ? (
    <Navigate to="/sign-in" />
  ) : (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-4 text-body text-fg-muted"
    >
      <span className="flex min-w-0 items-center gap-2">
        <Icon name="alert" className="text-fail" />
        {messageOf(error)}
      </span>
      {retry === undefined ? null : (
        <Button size="sm" onClick={retry}>
          Try again
        </Button>
      )}
    </div>
  );

/** A panel-wide failure: the same, as the panel's only content. */
export const FailedPanel = (props: { readonly error: Tagged; readonly retry?: () => void }) => (
  <div className="rounded-panel border border-border bg-panel">
    <Failed {...props} />
  </div>
);

/** Rows still loading: `rows` placeholder lines at the table's row height. */
export const LoadingRows = ({
  rows = 3,
  label,
}: {
  readonly rows?: number;
  readonly label: string;
}) => (
  <div role="status" aria-label={label} className="flex flex-col">
    {Array.from({ length: rows }, (_, index) => (
      <div
        key={index}
        className="flex h-10 items-center border-b border-border px-4 last:border-b-0"
      >
        <Skeleton className={index % 2 === 0 ? "w-1/2" : "w-1/3"} />
      </div>
    ))}
  </div>
);

/** A banner above live content while its feed reconnects. */
export const Reconnecting = ({ children }: { readonly children?: ReactNode }) => (
  <div role="status" className="flex items-center gap-2 text-label text-flaky">
    <Icon name="running" className="animate-spin" />
    {children ?? "Reconnecting… showing what was last loaded."}
  </div>
);
