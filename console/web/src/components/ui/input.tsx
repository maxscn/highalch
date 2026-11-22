import { Input as BaseInput } from "@base-ui/react/input";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.ts";
import { Icon } from "../icons.tsx";

/** A text input: 32 tall, radius 4, strong hairline, panel fill. */
export const Input = ({ className, ...props }: ComponentProps<typeof BaseInput>) => (
  <BaseInput
    className={cn(
      "block h-8 w-full min-w-0 rounded-control border border-border-strong bg-panel px-2 text-body text-fg placeholder:text-fg-subtle",
      "aria-invalid:border-fail-dot disabled:border-border disabled:bg-subtle disabled:text-fg-subtle",
      className,
    )}
    {...props}
  />
);

/** A search field: the magnifier inside at x = 8, text from x = 32. */
export const SearchInput = ({
  label,
  className,
  ...props
}: { readonly label: string } & ComponentProps<typeof BaseInput>) => (
  <div className={cn("relative w-60 max-w-full", className)}>
    <Icon name="search" className="pointer-events-none absolute top-2 left-2 text-fg-subtle" />
    <Input type="search" aria-label={label} placeholder={label} className="pl-8" {...props} />
  </div>
);
