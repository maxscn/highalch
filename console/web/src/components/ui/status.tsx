import { cva } from "class-variance-authority";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";
import { Icon, type IconName } from "../icons.tsx";

/** The five outcomes the boards colour: text, dot and tint per status. */
export type Status = "passed" | "failed" | "flaky" | "skipped" | "running";

export const statusLabel: Record<Status, string> = {
  passed: "Passed",
  failed: "Failed",
  flaky: "Flaky",
  skipped: "Skipped",
  running: "Running",
};

const text: Record<Status, string> = {
  passed: "text-pass",
  failed: "text-fail",
  flaky: "text-flaky",
  skipped: "text-skipped",
  running: "text-running",
};

const dot: Record<Status, string> = {
  passed: "bg-pass-dot",
  failed: "bg-fail-dot",
  flaky: "bg-flaky-dot",
  skipped: "bg-skipped-dot",
  running: "bg-running-dot",
};

const tint: Record<Status, string> = {
  passed: "bg-pass-tint",
  failed: "bg-fail-tint",
  flaky: "bg-flaky-tint",
  skipped: "bg-skipped-tint",
  running: "bg-running-tint",
};

export const statusText = (status: Status) => text[status];

/** A glyph slot: 16 × 16, never shrinks; empty keeps the slot so text starts at the same x. */
export const Slot = ({
  children,
  className,
}: {
  readonly children?: ReactNode;
  readonly className?: string;
}) => (
  <span aria-hidden="true" className={cn("grid size-4 flex-none place-items-center", className)}>
    {children}
  </span>
);

/** An 8px status dot in its 16px slot. */
export const Dot = ({ status }: { readonly status: Status }) => (
  <Slot>
    <span className={cn("size-2 rounded-full", dot[status])} />
  </Slot>
);

const icons: Record<Status, IconName> = {
  passed: "passed",
  failed: "failed",
  flaky: "flaky",
  skipped: "skipped",
  running: "running",
};

/** The status as a 16px line icon in its colour, named for screen readers. */
export const StatusIcon = ({ status }: { readonly status: Status }) => (
  <Icon name={icons[status]} label={statusLabel[status]} className={text[status]} />
);

const pill = cva(
  "inline-flex h-6 flex-none items-center gap-1 whitespace-nowrap rounded-control pr-2 pl-1 text-label font-medium",
);

/** A status pill: tint fill, dot and label (24 tall). */
export const StatusPill = ({
  status,
  children,
  className,
}: {
  readonly status: Status;
  readonly children?: ReactNode;
  readonly className?: string;
}) => (
  <span className={cn(pill(), tint[status], text[status], className)}>
    <Dot status={status} />
    {children ?? statusLabel[status]}
  </span>
);

/** Inline status: icon and label in the status colour (14/20). */
export const InlineStatus = ({
  status,
  children,
}: {
  readonly status: Status;
  readonly children?: ReactNode;
}) => (
  <span className={cn("inline-flex items-center gap-2", text[status])}>
    <Icon name={icons[status]} />
    {children ?? statusLabel[status]}
  </span>
);

/** A small count bubble beside a label (failed in fail tint, others neutral). */
export const Count = ({
  value,
  status,
}: {
  readonly value: number | string;
  readonly status?: "failed";
}) => (
  <span
    className={cn(
      "inline-grid h-4 min-w-4 place-items-center rounded-full px-1 font-mono text-caption",
      status === "failed" ? "bg-fail-tint text-fail" : "bg-selected text-fg",
    )}
  >
    {value}
  </span>
);
