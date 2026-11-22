import { Button as BaseButton } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.ts";

/**
 * Buttons as the Components board draws them: heights 28, 32 or 40, radius 4, 14/20 medium (13/20
 * at 28). One ink primary per view; secondary on panel; ghost; danger text on panel.
 */
export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-control border font-medium no-underline transition-colors cursor-pointer select-none hover:no-underline disabled:cursor-default data-[disabled]:cursor-default",
  {
    variants: {
      variant: {
        primary:
          "border-ink bg-ink text-ink-fg hover:border-ink-hover hover:bg-ink-hover hover:text-ink-fg disabled:border-border disabled:bg-selected disabled:text-fg-subtle",
        secondary:
          "border-border-strong bg-panel text-fg hover:bg-subtle hover:text-fg disabled:border-border disabled:bg-bg disabled:text-fg-subtle",
        ghost:
          "border-transparent bg-transparent text-fg-muted hover:bg-selected hover:text-fg disabled:text-fg-subtle disabled:bg-transparent",
        danger:
          "border-border-strong bg-panel text-fail hover:border-fail-dot hover:bg-fail-tint hover:text-fail disabled:border-border disabled:bg-bg disabled:text-fg-subtle",
      },
      size: {
        sm: "h-7 px-2 text-label",
        md: "h-8 px-3 text-body",
        lg: "h-10 px-4 text-body",
        icon: "size-8 p-0 text-fg-muted",
        "icon-sm": "size-7 p-0 text-fg-muted",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonProps = ComponentProps<typeof BaseButton> & VariantProps<typeof buttonVariants>;

export const Button = ({ className, variant, size, ...props }: ButtonProps) => (
  <BaseButton className={cn(buttonVariants({ variant, size }), className)} {...props} />
);
