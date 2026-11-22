import { cn } from "../../lib/cn.ts";

/** A loading placeholder bar (subtle fill, radius 4). */
export const Skeleton = ({ className }: { readonly className?: string }) => (
  <span
    aria-hidden="true"
    className={cn("block h-4 animate-pulse rounded-control bg-subtle", className)}
  />
);
