import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { cn } from "../../lib/cn.ts";

/**
 * Tables as the Foundations board lays them out: CSS grid with ONE `grid-template-columns`
 * string used verbatim by the header, group rows and every data row, all with 0 16px padding.
 * Header 40 on bg, rows 40, group rows 36 on subtle. Wide tables scroll inside their own box.
 */
export const Table = ({
  columns,
  minWidth,
  children,
  label,
}: {
  readonly columns: string;
  readonly minWidth: number;
  readonly children: ReactNode;
  readonly label?: string;
}) => (
  <div className="overflow-x-auto">
    <div
      role="table"
      aria-label={label}
      style={{ minWidth, "--columns": columns } as CSSProperties}
    >
      {children}
    </div>
  </div>
);

const grid = "grid grid-cols-[var(--columns)] items-center gap-4 px-4";

export const TableHeader = ({ children }: { readonly children: ReactNode }) => (
  <div
    role="row"
    className={cn(grid, "h-10 border-b border-border bg-bg text-label font-medium text-fg-muted")}
  >
    {children}
  </div>
);

export const TableGroup = ({ children }: { readonly children: ReactNode }) => (
  <div role="row" className={cn(grid, "h-9 border-b border-border bg-subtle")}>
    {children}
  </div>
);

/** A data row; pass `selected` for the accent fill and the 2px inset bar. */
export const rowClass = (selected = false) =>
  cn(
    grid,
    "h-10 w-full border-0 border-b border-border text-left text-body text-fg no-underline last:border-b-0 hover:bg-bg hover:text-fg hover:no-underline",
    selected ? "bg-accent-subtle shadow-selected hover:bg-accent-subtle" : "bg-panel",
  );

export const TableRow = ({ className, ...props }: ComponentProps<"div">) => (
  <div role="row" className={cn(rowClass(), className)} {...props} />
);

/** A right-aligned numeric cell: mono 13/20, tabular, no wrap. */
export const NumberCell = ({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) => (
  <span
    className={cn("whitespace-nowrap text-right font-mono text-label text-fg-muted", className)}
  >
    {children}
  </span>
);
