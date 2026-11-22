import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/cn.ts";

/** A panel: hairline border, radius 6, panel fill; children clip to the radius. */
export const Panel = ({ className, ...props }: ComponentProps<"section">) => (
  <section
    className={cn("min-w-0 overflow-hidden rounded-panel border border-border bg-panel", className)}
    {...props}
  />
);

/** A panel header: 40 tall on bg, 16 inset, a hairline below. */
export const PanelHeader = ({
  title,
  children,
  className,
  id,
}: {
  readonly title?: ReactNode;
  readonly children?: ReactNode;
  readonly className?: string;
  readonly id?: string;
}) => (
  <div
    className={cn(
      "flex h-10 items-center justify-between gap-4 border-b border-border bg-bg px-4",
      className,
    )}
  >
    {title === undefined ? null : (
      <h2 id={id} className="m-0 min-w-0 truncate text-body font-semibold">
        {title}
      </h2>
    )}
    {children}
  </div>
);

/** A labelled section of a panel body: 16 inset, a hairline above when not first. */
export const PanelSection = ({
  label,
  children,
  className,
}: {
  readonly label?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) => (
  <div className={cn("flex flex-col gap-2 border-t border-border p-4 first:border-t-0", className)}>
    {label === undefined ? null : (
      <span className="text-label font-medium text-fg-muted">{label}</span>
    )}
    {children}
  </div>
);

/** A section heading row of a page: 16/24 title, optional muted note and actions. */
export const SectionHeading = ({
  id,
  title,
  note,
  children,
}: {
  readonly id?: string;
  readonly title: ReactNode;
  readonly note?: ReactNode;
  readonly children?: ReactNode;
}) => (
  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
    <div className="flex min-w-0 flex-[1_1_280px] items-baseline gap-2">
      <h2 id={id} className="m-0 text-subheading">
        {title}
      </h2>
      {note === undefined ? null : <span className="text-label text-fg-muted">{note}</span>}
    </div>
    {children}
  </div>
);

/** An empty or message state inside a panel: 48 × 16 padding, centred muted text. */
export const Empty = ({ children }: { readonly children: ReactNode }) => (
  <div className="px-4 py-12 text-center text-body text-fg-muted">{children}</div>
);
