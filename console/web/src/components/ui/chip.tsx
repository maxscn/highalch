import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";
import { Icon } from "../icons.tsx";

/** A hairline chip (a browser, a kind): 24 tall, 13/20 muted. */
export const Chip = ({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) => (
  <span
    className={cn(
      "inline-flex h-6 flex-none items-center whitespace-nowrap rounded-control border border-border px-2 text-label text-fg-muted",
      className,
    )}
  >
    {children}
  </span>
);

/** A branch chip: branch icon and the name in mono. */
export const BranchChip = ({ name }: { readonly name: string }) => (
  <span className="inline-flex h-6 min-w-0 items-center gap-1 rounded-control border border-border pr-2 pl-1 text-fg-muted">
    <Icon name="branch" />
    <span className="truncate font-mono text-caption">{name}</span>
  </span>
);

/** A keyboard key. */
export const Kbd = ({ children }: { readonly children: ReactNode }) => (
  <kbd className="inline-flex h-6 items-center rounded-control border border-border bg-subtle px-1 font-mono text-caption text-fg-muted">
    {children}
  </kbd>
);

/** Mono text one step smaller than the sans beside it (SHAs, branches, durations). */
export const Mono = ({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) => <span className={cn("font-mono text-caption", className)}>{children}</span>;
