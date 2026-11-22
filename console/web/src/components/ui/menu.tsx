import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.ts";

/** A popup menu on Base UI's Menu, as a panel with 32-tall items. */
export const Menu = BaseMenu.Root;
export const MenuTrigger = BaseMenu.Trigger;

export const MenuContent = ({
  className,
  align = "start",
  ...props
}: ComponentProps<typeof BaseMenu.Popup> & { readonly align?: "start" | "end" }) => (
  <BaseMenu.Portal>
    <BaseMenu.Positioner sideOffset={4} align={align} className="z-50">
      <BaseMenu.Popup
        className={cn(
          "flex min-w-48 flex-col rounded-panel border border-border bg-panel p-1 shadow-popover outline-none",
          className,
        )}
        {...props}
      />
    </BaseMenu.Positioner>
  </BaseMenu.Portal>
);

export const MenuItem = ({ className, ...props }: ComponentProps<typeof BaseMenu.Item>) => (
  <BaseMenu.Item
    className={cn(
      "flex h-8 cursor-pointer items-center gap-2 rounded-control px-2 text-body text-fg outline-none select-none data-[highlighted]:bg-selected",
      className,
    )}
    {...props}
  />
);

export const MenuLabel = ({ className, ...props }: ComponentProps<"div">) => (
  <div
    className={cn("flex h-8 items-center px-2 text-caption font-medium text-fg-subtle", className)}
    {...props}
  />
);

export const MenuSeparator = () => <BaseMenu.Separator className="my-1 h-px bg-border" />;
