import type { ReactNode, SVGProps } from "react";
import { cn } from "../lib/cn.ts";

/**
 * The boards' 16 × 16 line icons (stroke 1.5, round caps and joins), drawn in `currentColor`.
 * Decorative unless given a `label`, which makes the icon an `img` with that name.
 */
const paths = {
  runs: <path d="M2.5 4h11M2.5 8h11M2.5 12h7" />,
  pulls: (
    <>
      <circle cx="4" cy="3.5" r="1.75" />
      <circle cx="4" cy="12.5" r="1.75" />
      <circle cx="12" cy="12.5" r="1.75" />
      <path d="M4 5.25v5.5M12 10.75V6a2 2 0 0 0-2-2H7.5" />
    </>
  ),
  fuzz: (
    <>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <path d="M9.5 9.5l4 4M13.5 9.5l-4 4" />
    </>
  ),
  schemas: (
    <path d="M5.5 2.5c-1.5 0-2 .7-2 2v1.5c0 1-.5 2-1.5 2 1 0 1.5 1 1.5 2v1.5c0 1.3.5 2 2 2M10.5 2.5c1.5 0 2 .7 2 2v1.5c0 1 .5 2 1.5 2-1 0-1.5 1-1.5 2v1.5c0 1.3-.5 2-2 2" />
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </>
  ),
  stories: (
    <>
      <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1" />
      <path d="M5.75 3.25v9.5M10.25 3.25v9.5" />
    </>
  ),
  branch: (
    <>
      <circle cx="4.5" cy="3.5" r="1.75" />
      <circle cx="4.5" cy="12.5" r="1.75" />
      <circle cx="11.5" cy="5.5" r="1.75" />
      <path d="M4.5 5.25v5.5M11.5 7.25c0 2.5-3 2.5-6.5 3.75" />
    </>
  ),
  commit: (
    <>
      <circle cx="8" cy="8" r="2.75" />
      <path d="M1.5 8h3.75M10.75 8h3.75" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.75" />
      <path d="M10.5 10.5L14 14" />
    </>
  ),
  moon: <path d="M13.5 9.5A5.5 5.5 0 1 1 6.5 2.5a4.5 4.5 0 0 0 7 7z" />,
  sun: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
    </>
  ),
  updown: <path d="M5 6l3-3 3 3M5 10l3 3 3-3" />,
  external: <path d="M6 3h7v7M13 3L4 12" />,
  rerun: <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" />,
  file: (
    <>
      <path d="M3.5 1.75h6l3 3v9.5h-9z" />
      <path d="M9.5 1.75v3h3" />
    </>
  ),
  image: (
    <>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
      <path d="M1.75 10.5l3.5-3 3 2.5 2-1.5 4 3" />
    </>
  ),
  copy: (
    <>
      <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" />
      <path d="M11 5V3.5a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1V10a1 1 0 0 0 1 1H5" />
    </>
  ),
  back: <path d="M13 8H3M6.5 4.5L3 8l3.5 3.5" />,
  signOut: (
    <>
      <rect x="2" y="4" width="8" height="8" rx="1" />
      <path d="M10 8h4.5M12.5 6l2 2-2 2" />
    </>
  ),
  check: <path d="M3.5 8.5l3 3 6-7" />,
  cross: <path d="M4 4l8 8M12 4l-8 8" />,
  minus: <path d="M5 8h6" />,
  info: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.25v4M8 4.75v.01" />
    </>
  ),
  alert: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.75v4M8 11.25v.01" />
    </>
  ),
  passed: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M5.5 8.2l1.7 1.7 3.3-3.6" />
    </>
  ),
  failed: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M6 6l4 4M10 6l-4 4" />
    </>
  ),
  flaky: (
    <>
      <path d="M2.5 8a5.5 5.5 0 0 1 9.6-3.6M13.5 8a5.5 5.5 0 0 1-9.6 3.6" />
      <path d="M12.5 1.75v2.75H9.75M3.5 14.25V11.5h2.75" />
    </>
  ),
  skipped: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M5.5 8h5" />
    </>
  ),
  running: (
    <>
      <circle cx="8" cy="8" r="6.25" opacity="0.35" />
      <path d="M8 1.75a6.25 6.25 0 0 1 6.25 6.25" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;

export const Icon = ({
  name,
  label,
  className,
  ...rest
}: { readonly name: IconName; readonly label?: string } & SVGProps<SVGSVGElement>) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={cn("flex-none", className)}
    {...(label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
    {...rest}
  >
    {paths[name]}
  </svg>
);

/** The HighAlch mark: a gold coin with a flame (the boards' sidebar logo), 20 × 20. */
export const Logo = ({ className }: { readonly className?: string }) => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 20 20"
    aria-hidden="true"
    className={cn("flex-none", className)}
  >
    <circle cx="10" cy="12.75" r="5.75" fill="#E0A630" stroke="#8A5A00" strokeWidth="1.25" />
    <circle
      cx="10"
      cy="12.75"
      r="3.25"
      fill="none"
      stroke="#8A5A00"
      strokeWidth="1"
      opacity="0.55"
    />
    <path
      d="M10 1.25c2.1 2.2 3.4 3.8 3.4 5.7a3.4 3.4 0 0 1-6.8 0c0-1.2.6-2.1 1.4-2.9.1 1.1.6 1.8 1.3 2.1-.2-1.8.1-3.3.7-4.9z"
      fill="#E8742C"
      stroke="#9A3D12"
      strokeWidth="1"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * "→" between two names (branch → base). Geist has no U+2192, so it is drawn: 12 wide, on the
 * text's baseline, in the text's colour.
 */
export const Arrow = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.25"
    strokeLinecap="round"
    strokeLinejoin="round"
    role="img"
    aria-label="into"
    className="inline-block flex-none"
  >
    <path d="M2 6h8M7 3l3 3-3 3" />
  </svg>
);

/** A branch flowing into its base: `feat/x → main`, mono, with the drawn arrow. */
export const BranchInto = ({
  branch,
  base,
}: {
  readonly branch: string;
  readonly base: string | null;
}) => (
  <span className="inline-flex items-center gap-1 whitespace-nowrap font-mono text-caption">
    {branch}
    {base === null ? null : (
      <>
        <Arrow />
        {base}
      </>
    )}
  </span>
);
