import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";

export type Segment<V extends string> = {
  readonly value: V;
  readonly label: ReactNode;
  readonly count?: number | string;
};

/**
 * A segmented control (one value): squared, hairline-framed segments with shared 1px dividers;
 * the pressed segment is `selected` with primary text. 32 tall (28 with `size="sm"`).
 */
export const Segmented = <V extends string>({
  label,
  segments,
  value,
  onValueChange,
  size = "md",
}: {
  readonly label: string;
  readonly segments: ReadonlyArray<Segment<V>>;
  readonly value: V;
  readonly onValueChange: (value: V) => void;
  readonly size?: "sm" | "md";
}) => (
  <ToggleGroup
    aria-label={label}
    value={[value]}
    onValueChange={(next) => {
      const picked = segments.find((segment) => segment.value === next[0]);
      if (picked) onValueChange(picked.value);
    }}
    className={cn(
      "inline-flex max-w-full flex-none overflow-x-auto rounded-control border border-border-strong bg-panel [scrollbar-width:none]",
      size === "sm" ? "h-7" : "h-8",
    )}
  >
    {segments.map((segment) => (
      <Toggle
        key={segment.value}
        value={segment.value}
        className={cn(
          "inline-flex cursor-pointer items-center gap-2 whitespace-nowrap border-0 border-l border-border-strong bg-panel text-label font-medium text-fg-muted first:border-l-0",
          "data-[pressed]:bg-selected data-[pressed]:text-fg hover:text-fg",
          size === "sm" ? "px-3" : "px-3",
        )}
      >
        {segment.label}
        {segment.count === undefined ? null : (
          <span className="font-mono text-caption text-fg-muted">{segment.count}</span>
        )}
      </Toggle>
    ))}
  </ToggleGroup>
);
