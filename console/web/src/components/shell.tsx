import { me, projects, pulls, runs } from "@highalch/console-domain/Console.collections";
import { OrganizationId } from "@highalch/console-domain/Organization/Organization.id";
import { ProjectId } from "@highalch/console-domain/Project/Project.id";
import * as HighAlch from "@lowalch/tanstack-db";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import * as Effect from "effect/Effect";
import { useTransition, type ReactNode } from "react";
import { signOut } from "../data/auth.ts";
import { initials } from "../lib/format.ts";
import { runStatus } from "../lib/outcome.ts";
import { toggleTheme, useDark } from "../lib/theme.ts";
import { cn } from "../lib/cn.ts";
import { Icon, Logo, type IconName } from "./icons.tsx";
import { Button } from "./ui/button.tsx";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "./ui/menu.tsx";
import { Dot } from "./ui/status.tsx";
import { Skeleton } from "./ui/skeleton.tsx";

/**
 * The application shell (Main board): a 48-tall top bar (brand cell 224 wide, then the scope
 * breadcrumb and the page's context, the theme toggle and the account), a 224-wide sidebar
 * (primary navigation, recent pull requests) and the content column (padding 24 32 48, max 1216,
 * left aligned so every page shares one left edge at sidebar + 32).
 */
export const Shell = ({
  org,
  project,
  context,
  children,
}: {
  readonly org: string;
  readonly project: string;
  /** Beside the breadcrumb: the page's branch, say. */
  readonly context?: ReactNode;
  readonly children: ReactNode;
}) => (
  <div className="min-h-screen bg-bg text-fg">
    <header className="flex flex-wrap border-b border-border bg-bg">
      <div className="flex h-12 flex-[1_0_224px] items-center gap-2 border-border px-4 sm:flex-[0_0_224px] sm:border-r">
        <Link
          to="/$org/$project/stories"
          params={{ org, project }}
          className="flex items-center gap-2 text-body font-semibold text-fg hover:text-fg hover:no-underline"
        >
          <Logo />
          HighAlch Console
        </Link>
      </div>
      <div className="flex min-h-12 min-w-0 flex-[1_1_640px] flex-wrap items-center gap-2 px-4 py-2 sm:px-8">
        <Scope org={org} project={project} />
        {context}
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <Account org={org} />
        </div>
      </div>
    </header>
    <div className="flex flex-wrap">
      <Sidebar org={org} project={project} />
      <main className="flex min-w-0 max-w-content flex-[1_1_640px] flex-col gap-8 px-4 pt-6 pb-12 sm:px-8">
        {children}
      </main>
    </div>
  </div>
);

// ---------------------------------------------------------------- top bar

const Scope = ({ org, project }: { readonly org: string; readonly project: string }) => {
  const navigate = useNavigate();
  const list = useLiveQuery((q) =>
    q
      .from({ project: projects.list({ org: OrganizationId.make(org) }) })
      .orderBy(({ project }) => project.slug),
  );
  return (
    <nav aria-label="Scope" className="flex min-w-0 items-center gap-2">
      <Link to="/$org" params={{ org }} className="text-fg-muted">
        {org}
      </Link>
      <span aria-hidden="true" className="text-fg-subtle">
        /
      </span>
      <Link to="/$org/$project/stories" params={{ org, project }} className="font-medium text-fg">
        {project}
      </Link>
      <Menu>
        <MenuTrigger
          aria-label="Switch project"
          className="grid h-8 w-6 cursor-pointer place-items-center rounded-control border-0 bg-transparent p-0 text-fg-muted hover:bg-selected"
        >
          <Icon name="updown" />
        </MenuTrigger>
        <MenuContent>
          <MenuLabel>Projects</MenuLabel>
          {HighAlch.match(list).on({
            [HighAlch.anyOf("Loading", "Retrying")]: () => <MenuLabel>Loading…</MenuLabel>,
            Ready: ({ data }) =>
              data.map((row) => (
                <MenuItem
                  key={row.slug}
                  onClick={() =>
                    void navigate({
                      to: "/$org/$project/stories",
                      params: { org, project: row.slug },
                    })
                  }
                >
                  <span className="min-w-0 flex-1 truncate">{row.slug}</span>
                  {row.slug === project ? <Icon name="check" className="text-accent" /> : null}
                </MenuItem>
              )),
            orElse: (error) => <MenuLabel>Projects unavailable ({error._tag})</MenuLabel>,
          })}
        </MenuContent>
      </Menu>
    </nav>
  );
};

const ThemeToggle = () => {
  const dark = useDark();
  return (
    <Button
      size="icon"
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={toggleTheme}
    >
      <Icon name={dark ? "sun" : "moon"} />
    </Button>
  );
};

const Account = ({ org }: { readonly org: string }) => {
  const result = useLiveQuery((q) => q.from({ me: me({}) }).findOne());
  const navigate = useNavigate();
  const [leaving, startLeaving] = useTransition();
  const leave = () =>
    startLeaving(async () => {
      await Effect.runPromise(Effect.ignore(signOut));
      await navigate({ to: "/sign-in" });
    });
  return HighAlch.match(result).on({
    [HighAlch.anyOf("Loading", "Retrying", "Missing")]: () => (
      <span className="size-8 rounded-full bg-avatar" />
    ),
    Ready: ({ data }) => (
      <Menu>
        <MenuTrigger
          aria-label={`Account: ${data.user.name ?? data.user.email}`}
          className="grid size-8 cursor-pointer place-items-center rounded-full border-0 bg-avatar p-0 text-caption font-semibold text-fg"
        >
          {initials(data.user.name ?? data.user.email)}
        </MenuTrigger>
        <MenuContent align="end">
          <div className="flex flex-col px-2 py-1">
            <span className="text-body font-medium">{data.user.name ?? data.user.email}</span>
            <span className="text-caption text-fg-muted">{data.user.email}</span>
          </div>
          <MenuSeparator />
          <MenuLabel>Organisations</MenuLabel>
          {data.organizations.map((membership) => (
            <MenuItem
              key={membership.org}
              onClick={() => void navigate({ to: "/$org", params: { org: membership.org } })}
            >
              <span className="min-w-0 flex-1 truncate">{membership.name}</span>
              {membership.org === org ? <Icon name="check" className="text-accent" /> : null}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onClick={leave} disabled={leaving}>
            <Icon name="signOut" />
            Sign out
          </MenuItem>
        </MenuContent>
      </Menu>
    ),
    orElse: () => <span className="size-8 rounded-full bg-avatar" />,
  });
};

// ---------------------------------------------------------------- sidebar

type Section = "stories" | "runs" | "pulls" | "fuzzing" | "settings";

const primary: ReadonlyArray<{
  readonly section: Section;
  readonly to:
    | "/$org/$project/stories"
    | "/$org/$project/runs"
    | "/$org/$project/pulls"
    | "/$org/$project/fuzzing"
    | "/$org/$project/settings";
  readonly label: string;
  readonly icon: IconName;
}> = [
  { section: "stories", to: "/$org/$project/stories", label: "Stories", icon: "stories" },
  { section: "runs", to: "/$org/$project/runs", label: "Runs", icon: "runs" },
  { section: "pulls", to: "/$org/$project/pulls", label: "Pull requests", icon: "pulls" },
  { section: "fuzzing", to: "/$org/$project/fuzzing", label: "Fuzzing", icon: "fuzz" },
  { section: "settings", to: "/$org/$project/settings", label: "Settings", icon: "settings" },
];

/**
 * The section a path belongs to. A story lives under its run's URL
 * (`/runs/:run/stories/:slug`) but belongs to Stories; a test or a run to Runs.
 */
export const sectionOf = (path: string): Section | undefined => {
  const parts = path.split("/").filter((part) => part !== "");
  const [, , first] = parts;
  if (parts.includes("stories")) return "stories";
  if (first === "runs") return "runs";
  if (first === "pulls") return "pulls";
  if (first === "fuzzing") return "fuzzing";
  if (first === "settings") return "settings";
  return undefined;
};

const item =
  "flex h-8 items-center gap-2 whitespace-nowrap rounded-control px-2 text-body text-fg-muted no-underline hover:bg-selected hover:text-fg hover:no-underline";

const Sidebar = ({ org, project }: { readonly org: string; readonly project: string }) => {
  const section = useRouterState({ select: (state) => sectionOf(state.location.pathname) });
  return (
    <nav
      aria-label="Primary"
      className="flex w-full min-w-0 flex-col gap-6 border-b border-border px-2 py-2 sm:w-sidebar sm:flex-[0_0_224px] sm:border-r sm:border-b-0 sm:py-4"
    >
      <div className="-mx-2 flex overflow-x-auto px-2 [scrollbar-width:none] sm:mx-0 sm:flex-col sm:overflow-visible sm:px-0">
        {primary.map((entry) => (
          <Link
            key={entry.to}
            to={entry.to}
            params={{ org, project }}
            className={cn(
              item,
              "flex-none",
              entry.section === section && "bg-selected font-medium text-fg",
            )}
            aria-current={entry.section === section ? "page" : undefined}
          >
            <Icon name={entry.icon} />
            {entry.label}
          </Link>
        ))}
      </div>
      <RecentPulls org={org} project={project} />
    </nav>
  );
};

const RecentPulls = ({ org, project }: { readonly org: string; readonly project: string }) => {
  const result = useLiveQuery((q) =>
    q
      .from({ pull: pulls.list({ project: ProjectId.make(project) }) })
      .orderBy(({ pull }) => pull.number, "desc")
      .limit(5),
  );
  const recent = useLiveQuery((q) =>
    q
      .from({ run: runs.list({ org: OrganizationId.make(org), project: ProjectId.make(project) }) })
      .orderBy(({ run }) => run.createdAt, "desc"),
  );
  const latest = HighAlch.match(recent).on({
    Ready: ({ data }) => data,
    Retrying: ({ data }) => data,
    orElse: () => [],
  });
  return (
    <div className="hidden flex-col sm:flex">
      <span className="flex h-8 items-center px-2 text-caption font-medium text-fg-subtle">
        Recent pull requests
      </span>
      {HighAlch.match(result).on({
        [HighAlch.anyOf("Loading", "Retrying")]: () => (
          <span className="flex h-8 items-center px-2">
            <Skeleton className="w-32" />
          </span>
        ),
        Ready: ({ data }) =>
          data.length === 0 ? (
            <span className="flex h-8 items-center px-2 text-label text-fg-subtle">None yet</span>
          ) : (
            data.map((pull) => {
              const run = latest.find((row) => row.pr === pull.number);
              return (
                <Link
                  key={pull.id}
                  to="/$org/$project/pulls/$pull"
                  params={{ org, project, pull: String(pull.number) }}
                  className={cn(item, "text-fg")}
                  activeProps={{ className: "bg-selected" }}
                >
                  {run === undefined ? (
                    <span className="size-4 flex-none" />
                  ) : (
                    <Dot status={runStatus(run)} />
                  )}
                  <span className="min-w-0 flex-1 truncate">{pull.title}</span>
                  <span className="font-mono text-caption text-fg-subtle">{pull.number}</span>
                </Link>
              );
            })
          ),
        orElse: (error) => (
          <span className="flex h-8 items-center px-2 text-label text-fg-subtle">{error._tag}</span>
        ),
      })}
    </div>
  );
};
