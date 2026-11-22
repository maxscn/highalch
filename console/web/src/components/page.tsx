import type { ReactNode } from "react";

/**
 * A page header (Main board): an optional muted line above (breadcrumb-like context), the title
 * at 24/32, an optional meta line, and actions on the right, top aligned.
 */
export const PageHeader = ({
  id,
  above,
  title,
  meta,
  actions,
}: {
  readonly id: string;
  readonly above?: ReactNode;
  readonly title: ReactNode;
  readonly meta?: ReactNode;
  readonly actions?: ReactNode;
}) => (
  <section aria-labelledby={id} className="flex flex-wrap items-start justify-between gap-4">
    <div className="flex min-w-0 flex-[1_1_480px] flex-col gap-1">
      {above === undefined ? null : (
        <div className="flex flex-wrap items-baseline gap-2 text-label text-fg-muted">{above}</div>
      )}
      <h1 id={id} className="m-0 text-title">
        {title}
      </h1>
      {meta === undefined ? null : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-label text-fg-muted">
          {meta}
        </div>
      )}
    </div>
    {actions === undefined ? null : (
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    )}
  </section>
);

/** The `·` between items of a muted line. */
export const Sep = () => <span aria-hidden="true">·</span>;
