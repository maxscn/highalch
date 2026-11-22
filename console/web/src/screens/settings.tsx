import {
  apiKeys,
  billing,
  members,
  portalLink,
  projects,
} from "@highalch/console-domain/Console.collections";
import { makeApiKey } from "@highalch/console-domain/Credentials";
import { OrganizationId } from "@highalch/console-domain/Organization/Organization.id";
import { ProjectId } from "@highalch/console-domain/Project/Project.id";
import * as HighAlch from "@lowalch/tanstack-db";
import { useLiveQuery } from "@tanstack/react-db";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { useState, useTransition } from "react";
import { Icon } from "../components/icons.tsx";
import { PageHeader } from "../components/page.tsx";
import { Failed, LoadingRows } from "../components/states.tsx";
import { Button } from "../components/ui/button.tsx";
import { Mono } from "../components/ui/chip.tsx";
import { Input } from "../components/ui/input.tsx";
import { Empty, Panel, PanelHeader } from "../components/ui/panel.tsx";
import { rowClass, Table, TableHeader } from "../components/ui/table.tsx";
import { ago, bytes, count } from "../lib/format.ts";
import { useNow } from "../lib/now.tsx";

type Props = { readonly org: string; readonly project: string };

/**
 * Settings of an organisation and the current project: its projects, the project's API keys
 * (made in the browser: only the key's id, prefix and hash are sent; the token is shown once),
 * members, and billing (plan, usage, the provider's portal for owners).
 */
export const SettingsScreen = (props: Props) => (
  <>
    <PageHeader
      id="settings-title"
      title="Settings"
      meta={<span>Projects, API keys, members and billing of {props.org}.</span>}
    />
    <ApiKeys {...props} />
    <Projects {...props} />
    <Members {...props} />
    <Billing {...props} />
  </>
);

// ---------------------------------------------------------------- API keys

const crypto = Layer.mergeAll(SecureRandom.layerWebCrypto, Digest.layerWebCrypto);

type Issued =
  | { readonly _tag: "None" }
  | { readonly _tag: "Shown"; readonly token: string; readonly name: string }
  | { readonly _tag: "Refused"; readonly error: { readonly _tag: string } };

const refusals: Record<string, string> = {
  TooManyApiKeys: "This project has as many API keys as it may have. Revoke one first.",
  NotAllowed: "Only members of this organisation can issue keys.",
  ProjectMissing: "This project no longer exists.",
};

const ApiKeys = ({ project }: Props) => {
  const now = useNow();
  const list = useLiveQuery((q) =>
    q
      .from({ key: apiKeys.list({ project: ProjectId.make(project) }) })
      .orderBy(({ key }) => key.createdAt, "desc"),
  );
  const [name, setName] = useState("");
  const [issued, setIssued] = useState<Issued>({ _tag: "None" });
  const [issuing, startIssuing] = useTransition();
  const issue = () =>
    startIssuing(async () => {
      const label = name.trim() === "" ? "CI" : name.trim();
      const made = await Effect.runPromise(
        Effect.provide(makeApiKey(ProjectId.make(project), label), crypto),
      );
      const outcome = await apiKeys.issue.result(made.input);
      HighAlch.match(outcome).on({
        [HighAlch.anyOf("Committed", "Unconfirmed")]: () => {
          setIssued({ _tag: "Shown", token: Redacted.value(made.token), name: label });
          setName("");
        },
        orElse: (error) => setIssued({ _tag: "Refused", error }),
      });
    });
  return (
    <Panel aria-labelledby="keys-title">
      <PanelHeader id="keys-title" title={`API keys of ${project}`} />
      <div className="flex flex-wrap items-end gap-2 border-b border-border p-4">
        <label className="flex min-w-0 flex-[0_1_320px] flex-col gap-1 text-label font-medium">
          Name
          <Input value={name} placeholder="CI" onValueChange={setName} />
        </label>
        <Button variant="primary" onClick={issue} disabled={issuing}>
          {issuing ? "Generating…" : "Generate key"}
        </Button>
      </div>
      {issued._tag === "Shown" ? (
        <div role="status" className="flex flex-col gap-2 border-b border-border bg-pass-tint p-4">
          <span className="text-label font-medium text-pass">
            Key “{issued.name}” issued. Copy it now: it is not shown again.
          </span>
          <div className="flex items-center gap-2">
            <Mono className="min-w-0 flex-1 truncate rounded-control border border-border bg-panel px-2 py-1">
              {issued.token}
            </Mono>
            <Button size="sm" onClick={() => void navigator.clipboard.writeText(issued.token)}>
              <Icon name="copy" />
              Copy
            </Button>
          </div>
        </div>
      ) : issued._tag === "Refused" ? (
        <p
          role="alert"
          className="m-0 flex items-center gap-2 border-b border-border p-4 text-label text-fail"
        >
          <Icon name="alert" />
          {refusals[issued.error._tag] ?? `The key was not issued (${issued.error._tag}).`}
        </p>
      ) : null}
      {HighAlch.match(list).on({
        Loading: () => <LoadingRows label="Loading API keys" rows={2} />,
        [HighAlch.anyOf("Ready", "Retrying")]: ({ data }) => (
          <Table columns="minmax(0,1fr) 280px 120px 96px" minWidth={640} label="API keys">
            <TableHeader>
              <span>Name</span>
              <span>Key</span>
              <span>Created</span>
              <span />
            </TableHeader>
            {data.length === 0 ? (
              <Empty>
                No keys yet. CI can also upload with GitHub OIDC once the repository is bound.
              </Empty>
            ) : (
              data.map((key) => (
                <div key={key.key} role="row" className={rowClass()}>
                  <span className="min-w-0 truncate">
                    {key.name}
                    {key.$hasPendingWrites ? (
                      <span className="ml-2 text-caption text-fg-subtle">revoking…</span>
                    ) : null}
                  </span>
                  <Mono className="truncate text-fg-muted">{key.prefix}…</Mono>
                  <span className="text-label text-fg-muted">{ago(key.createdAt, now)}</span>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() =>
                      apiKeys.revoke({ project: ProjectId.make(project), key: key.key })
                    }
                  >
                    Revoke
                  </Button>
                </div>
              ))
            )}
          </Table>
        ),
        orElse: (error, { retry }) => <Failed error={error} retry={retry} />,
      })}
    </Panel>
  );
};

// ---------------------------------------------------------------- projects and members

const Projects = ({ org }: Props) => {
  const list = useLiveQuery((q) =>
    q
      .from({ project: projects.list({ org: OrganizationId.make(org) }) })
      .orderBy(({ project }) => project.slug),
  );
  return (
    <Panel aria-labelledby="projects-title">
      <PanelHeader id="projects-title" title="Projects" />
      {HighAlch.match(list).on({
        Loading: () => <LoadingRows label="Loading projects" rows={2} />,
        [HighAlch.anyOf("Ready", "Retrying")]: ({ data }) => (
          <Table columns="minmax(0,1fr) 280px 120px" minWidth={560} label="Projects">
            <TableHeader>
              <span>Project</span>
              <span>Repository</span>
              <span>Default branch</span>
            </TableHeader>
            {data.map((row) => (
              <div key={row.slug} role="row" className={rowClass()}>
                <Mono className="text-label text-fg">{row.slug}</Mono>
                <Mono className="text-fg-muted">{row.repository ?? "Not bound"}</Mono>
                <Mono className="text-fg-muted">{row.defaultBranch}</Mono>
              </div>
            ))}
          </Table>
        ),
        orElse: (error, { retry }) => <Failed error={error} retry={retry} />,
      })}
    </Panel>
  );
};

const Members = ({ org }: Props) => {
  const list = useLiveQuery((q) =>
    q.from({ member: members.list({ org: OrganizationId.make(org) }) }),
  );
  return (
    <Panel aria-labelledby="members-title">
      <PanelHeader id="members-title" title="Members" />
      {HighAlch.match(list).on({
        Loading: () => <LoadingRows label="Loading members" rows={2} />,
        [HighAlch.anyOf("Ready", "Retrying")]: ({ data }) => (
          <Table columns="minmax(0,1fr) minmax(0,1fr) 96px" minWidth={560} label="Members">
            <TableHeader>
              <span>Name</span>
              <span>Email</span>
              <span>Role</span>
            </TableHeader>
            {data.map((member) => (
              <div key={member.id} role="row" className={rowClass()}>
                <span className="truncate">{member.name ?? member.email}</span>
                <span className="truncate text-fg-muted">{member.email}</span>
                <span className="text-label text-fg-muted">
                  {member.role === "owner" ? "Owner" : "Member"}
                </span>
              </div>
            ))}
          </Table>
        ),
        orElse: (error, { retry }) => <Failed error={error} retry={retry} />,
      })}
    </Panel>
  );
};

// ---------------------------------------------------------------- billing

const Billing = ({ org }: Props) => {
  const row = useLiveQuery((q) =>
    q.from({ billing: billing.get({ org: OrganizationId.make(org) }) }).findOne(),
  );
  return (
    <Panel aria-labelledby="billing-title">
      <PanelHeader id="billing-title" title="Billing" />
      {HighAlch.match(row).on({
        [HighAlch.anyOf("Loading", "Retrying")]: () => (
          <LoadingRows label="Loading billing" rows={2} />
        ),
        Missing: () => <Empty>No billing account yet.</Empty>,
        Ready: ({ data }) => (
          <div className="flex flex-col gap-4 p-4">
            <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-4">
              {(
                [
                  ["Plan", data.plan ?? "None"],
                  ["Runs this period", count(data.usage.runs)],
                  ["Stored", bytes(data.usage.storedBytes)],
                  ["Result rows", count(data.usage.resultRows)],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="flex flex-col gap-1">
                  <dt className="text-label text-fg-muted">{label}</dt>
                  <dd className="m-0 text-subheading">{value}</dd>
                </div>
              ))}
            </dl>
            {data.customer ? (
              <Portal org={org} />
            ) : (
              <p className="m-0 text-label text-fg-muted">
                Choosing a plan comes with checkout (not wired yet).
              </p>
            )}
          </div>
        ),
        orElse: (error, { retry }) => <Failed error={error} retry={retry} />,
      })}
    </Panel>
  );
};

/** The provider's billing portal: asked for on demand (a short-lived link), owners only. */
const Portal = ({ org }: { readonly org: string }) => {
  const [asked, setAsked] = useState(false);
  const link = useLiveQuery((q) =>
    asked
      ? q
          .from({
            link: portalLink({ org: OrganizationId.make(org), returnUrl: window.location.href }),
          })
          .findOne()
      : undefined,
  );
  return HighAlch.match(link).on({
    Disabled: () => (
      <Button className="self-start" onClick={() => setAsked(true)}>
        Manage billing
      </Button>
    ),
    [HighAlch.anyOf("Loading", "Retrying")]: () => (
      <Button className="self-start" disabled>
        Opening the billing portal…
      </Button>
    ),
    Missing: () => <p className="m-0 text-label text-fg-muted">No portal link was given.</p>,
    Ready: ({ data }) => (
      <a href={data.url} className="self-start text-label font-medium">
        Open the billing portal
      </a>
    ),
    BillingAccountPending: () => (
      <p className="m-0 text-label text-fg-muted">
        The billing account is still being set up. Try again in a minute.
      </p>
    ),
    NotAllowed: () => (
      <p className="m-0 text-label text-fg-muted">Only owners can manage billing.</p>
    ),
    orElse: (error, { retry }) => <Failed error={error} retry={retry} />,
  });
};
