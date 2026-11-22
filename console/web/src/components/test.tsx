import { artifactLinks } from "@highalch/console-domain/Console.collections";
import { RunId } from "@highalch/console-domain/Run/Run.id";
import * as HighAlch from "@lowalch/tanstack-db";
import { useLiveQuery } from "@tanstack/react-db";
import { useState } from "react";
import { elementsOf, type TestItem } from "../data/items.ts";
import { duration } from "../lib/format.ts";
import { frameLines, visibleSteps } from "../lib/tests.ts";
import { cn } from "../lib/cn.ts";
import { Icon } from "./icons.tsx";
import { Failed } from "./states.tsx";
import { Skeleton } from "./ui/skeleton.tsx";
import { Tab, TabPanel, Tabs, TabsList } from "./ui/tabs.tsx";

type Attempt = TestItem["attempts"][number];
type Attachment = Attempt["attachments"][number];

/** An error message in fail colour, mono 13/20, wrapped. */
export const ErrorMessage = ({ message }: { readonly message: string }) => (
  <pre className="m-0 whitespace-pre-wrap font-mono text-label text-fail [overflow-wrap:anywhere]">
    {message.trim()}
  </pre>
);

/** A code frame: 48-wide right-aligned line numbers, the failing line and caret on fail tint. */
export const CodeFrame = ({ snippet }: { readonly snippet: string }) => (
  <div className="overflow-x-auto rounded-control border border-border bg-bg py-2 font-mono text-label whitespace-pre">
    {frameLines(snippet).map((line, index) => (
      <div key={index} className={cn("flex", line.hit && "bg-fail-tint text-fail")}>
        <span className={cn("w-12 flex-none pr-4 text-right", !line.hit && "text-fg-subtle")}>
          {line.n}
        </span>
        <span className="pr-4">{line.code}</span>
      </div>
    ))}
  </div>
);

/** The steps of an attempt: icon, name (mono), duration; the failed one in fail colour. */
export const StepList = ({ attempt }: { readonly attempt: Attempt }) => (
  <ol className="m-0 flex list-none flex-col p-0">
    {visibleSteps(attempt.steps).map((step, index) => {
      const bad = step.error !== undefined;
      return (
        <li key={index} className="grid h-8 grid-cols-[16px_minmax(0,1fr)_80px] items-center gap-2">
          <Icon
            name={bad ? "cross" : "check"}
            label={bad ? "Failed" : "Passed"}
            className={bad ? "text-fail" : "text-pass"}
          />
          <span className="min-w-0 truncate font-mono text-label">{step.title}</span>
          <span
            className={cn(
              "whitespace-nowrap text-right font-mono text-label",
              bad ? "text-fail" : "text-fg-muted",
            )}
          >
            {duration(step.duration)}
          </span>
        </li>
      );
    })}
  </ol>
);

const kinds: ReadonlyArray<{ readonly kind: Attachment["kind"]; readonly label: string }> = [
  { kind: "screenshot", label: "Screenshot" },
  { kind: "snapshot-actual", label: "Snapshot" },
  { kind: "trace", label: "Trace" },
  { kind: "video", label: "Video" },
];

/**
 * An attempt's attachments as tabs (Screenshot, Snapshot, Trace, Video: the kinds it has), each
 * fetched through a signed link of the run's artifacts.
 */
export const Attachments = ({
  run,
  attempt,
}: {
  readonly run: string;
  readonly attempt: Attempt;
}) => {
  const present = kinds.filter((entry) => attempt.attachments.some((a) => a.kind === entry.kind));
  const [tab, setTab] = useState<string | null>(null);
  const first = present[0];
  if (first === undefined)
    return <p className="m-0 text-label text-fg-muted">No attachments on this attempt.</p>;
  const active = present.some((entry) => entry.kind === tab) ? tab : first.kind;
  return (
    <Tabs
      value={active}
      onValueChange={(value) => setTab(String(value))}
      className="flex flex-col gap-3"
    >
      <TabsList aria-label="Attachments">
        {present.map((entry) => (
          <Tab key={entry.kind} value={entry.kind}>
            {entry.label}
          </Tab>
        ))}
      </TabsList>
      {present.map((entry) => {
        const attachment = attempt.attachments.find((a) => a.kind === entry.kind);
        return attachment === undefined ? null : (
          <TabPanel key={entry.kind} value={entry.kind}>
            <AttachmentView run={run} attachment={attachment} />
          </TabPanel>
        );
      })}
    </Tabs>
  );
};

/** One attachment: an image inline; anything else as a download link. */
export const AttachmentView = ({
  run,
  attachment,
}: {
  readonly run: string;
  readonly attachment: Attachment;
}) => {
  // A `HighAlch.query` answer is one row: here, the array of links asked for.
  const result = useLiveQuery((q) =>
    q.from({ links: artifactLinks({ run: RunId.make(run), ids: [attachment.artifactId] }) }),
  );
  const frame =
    "flex aspect-video flex-col items-center justify-center gap-1 rounded-control border border-dashed border-border-strong bg-bg text-fg-muted";
  return HighAlch.match(result).on({
    [HighAlch.anyOf("Loading", "Retrying")]: () => (
      <div className={frame}>
        <Skeleton className="w-24" />
      </div>
    ),
    Ready: ({ data }) => {
      const link =
        data
          .flatMap((answer) => elementsOf(answer))
          .find((entry) => entry.id === attachment.artifactId)?.link ?? null;
      return link === null ? (
        <Unstored name={attachment.name} />
      ) : attachment.mime.startsWith("image/") ? (
        <img
          src={link.url}
          alt={`${attachment.name} (${attachment.kind})`}
          className="block w-full rounded-control border border-border bg-bg"
        />
      ) : attachment.mime.startsWith("video/") ? (
        <video
          src={link.url}
          controls
          className="block w-full rounded-control border border-border"
        />
      ) : (
        <div className={frame}>
          <Icon name="file" />
          <a href={link.url} className="font-mono text-caption text-fg">
            {attachment.name}
          </a>
          <span className="text-label">{attachment.mime}</span>
        </div>
      );
    },
    orElse: (error, { retry }) => <Failed error={error} retry={retry} />,
  });
};

const Unstored = ({ name }: { readonly name: string }) => (
  <div className="flex aspect-video flex-col items-center justify-center gap-1 rounded-control border border-dashed border-border-strong bg-bg text-fg-muted">
    <Icon name="image" />
    <span className="font-mono text-caption text-fg">{name}</span>
    <span className="text-label">Not stored (yet), or removed by retention.</span>
  </div>
);
