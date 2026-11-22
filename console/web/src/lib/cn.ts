import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** tailwind-merge told about the theme's own type scale and colours, so they merge correctly. */
const merge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["display", "title", "heading", "subheading", "body", "label", "caption"],
      color: [
        "bg",
        "panel",
        "subtle",
        "selected",
        "border",
        "border-strong",
        "fg",
        "fg-muted",
        "fg-subtle",
        "ink",
        "ink-fg",
        "ink-hover",
        "accent",
        "accent-subtle",
        "avatar",
        ...["pass", "fail", "flaky", "skipped", "running"].flatMap((s) => [
          s,
          `${s}-dot`,
          `${s}-tint`,
        ]),
      ],
      radius: ["control", "panel", "full"],
    },
  },
});

export const cn = (...inputs: ReadonlyArray<ClassValue>) => merge(clsx(inputs));
