import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.ts";

/** Tabs as squared segments (28 tall), the same look as the segmented control. */
export const Tabs = BaseTabs.Root;

export const TabsList = ({ className, ...props }: ComponentProps<typeof BaseTabs.List>) => (
  <BaseTabs.List
    className={cn(
      "inline-flex h-7 flex-none self-start overflow-hidden rounded-control border border-border-strong bg-panel",
      className,
    )}
    {...props}
  />
);

export const Tab = ({ className, ...props }: ComponentProps<typeof BaseTabs.Tab>) => (
  <BaseTabs.Tab
    className={cn(
      "cursor-pointer whitespace-nowrap border-0 border-l border-border-strong bg-panel px-3 text-label font-medium text-fg-muted first:border-l-0",
      "data-[active]:bg-selected data-[active]:text-fg hover:text-fg",
      className,
    )}
    {...props}
  />
);

export const TabPanel = BaseTabs.Panel;
