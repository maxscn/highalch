import type { Schema } from "effect";
import type { Edge } from "./edge.ts";

/** Identifies what a capture belongs to: a generated case or a step of an action run. */
export interface CaseContext {
  /** Case set or trace name. */
  readonly name: string;
  /** Case id (`<seed>:<index>`), or `<seed>:step:<index>` for a trace step. */
  readonly id: string;
  readonly index: number;
  readonly seed: number;
  /** fast-check replay path. */
  readonly path: string;
  readonly edges: ReadonlyArray<Edge>;
}

export type CaptureKind = "html" | "screenshot";

/** A rendered artifact. `body` is uploaded as-is with `mime`. */
export interface Capture {
  readonly kind: CaptureKind;
  readonly body: string | Uint8Array;
  readonly mime: string;
  readonly meta: Readonly<Record<string, Schema.Json>>;
}

/** Turns a subject (a React element, a Playwright page, ...) into a capture. Never uses the network. */
export interface Adapter<Subject> {
  readonly kind: CaptureKind;
  capture(subject: Subject, ctx: CaseContext): Promise<Capture>;
}
