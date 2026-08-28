/**
 * Read-only analytics reads for the staff dashboard.
 *
 * Kept out of `lib/api.ts` on purpose: the call console is being rebuilt
 * against that file at the same time, and nothing outside this dashboard reads
 * the analytics surface.
 *
 * Every reader here is deliberately tolerant. The `/api/stats/*` endpoints are
 * landing alongside this page, so a response whose shape is close but not
 * identical degrades to an empty panel rather than a thrown render - but it is
 * never filled in with invented numbers. A panel with no data says so.
 */

import { API_BASE, ApiError, errorMessage } from "./api";
import { ISSUE_LABEL } from "./labels";
import type { IssueType } from "./types";

async function request<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
  } catch {
    throw new ApiError(`Cannot reach the case API at ${API_BASE}`, 0);
  }
  if (!response.ok) {
    throw new ApiError(await errorMessage(response), response.status);
  }
  return (await response.json()) as T;
}

// ---------------------------------------------------------------- shapes

export const SUMMARY_KEYS = ["open_cases", "live_calls", "avg_resolution_days", "escalations"] as const;

export type SummaryKey = (typeof SUMMARY_KEYS)[number];

export interface SummaryMetric {
  /** Current headline value. */
  value: number;
  /** Absolute movement against the comparison window, or null when unknown. */
  delta: number | null;
  /** Server wording for what the delta compares against, when it supplies one. */
  deltaLabel: string | null;
  /** Daily points, oldest first, for the sparkline. */
  series: number[];
}

export type Summary = Partial<Record<SummaryKey, SummaryMetric>>;

export interface VolumeBucket {
  /** ISO date for the bucket, as the server dated it. */
  date: string;
  count: number;
}

export interface CallVolume {
  total: number;
  /** Percentage change against the preceding window of the same length. */
  changePercent: number | null;
  buckets: VolumeBucket[];
}

export interface TypeSlice {
  key: string;
  label: string;
  count: number;
  percent: number;
}

export interface CasesByType {
  total: number;
  slices: TypeSlice[];
}

export interface AttentionGroup {
  key: string;
  count: number;
  title: string;
  detail: string;
}

// ------------------------------------------------------------ normalizing

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** First present, non-null value among `keys`. */
function pick(source: Json, keys: string[]): unknown {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** A daily series is either bare numbers or dated buckets; both are read. */
function toSeries(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const points: number[] = [];
  for (const entry of value) {
    const point = isObject(entry) ? toNumber(pick(entry, ["value", "count", "total", "y"])) : toNumber(entry);
    if (point === null) return [];
    points.push(point);
  }
  return points;
}

/** Snake, camel and short spellings of each tile name all land on one key. */
const SUMMARY_ALIASES: Record<string, SummaryKey> = {
  open_cases: "open_cases",
  opencases: "open_cases",
  open: "open_cases",
  live_calls: "live_calls",
  livecalls: "live_calls",
  active_calls: "live_calls",
  avg_resolution_days: "avg_resolution_days",
  avg_resolution_time: "avg_resolution_days",
  avg_resolution: "avg_resolution_days",
  avgresolutiondays: "avg_resolution_days",
  resolution_days: "avg_resolution_days",
  escalations: "escalations",
  escalated: "escalations",
};

function summaryKey(raw: unknown): SummaryKey | null {
  const text = toText(raw);
  if (!text) return null;
  return SUMMARY_ALIASES[text.toLowerCase()] ?? null;
}

function toMetric(value: unknown): SummaryMetric | null {
  if (!isObject(value)) {
    const bare = toNumber(value);
    return bare === null ? null : { value: bare, delta: null, deltaLabel: null, series: [] };
  }
  const current = toNumber(pick(value, ["value", "current", "count", "total"]));
  if (current === null) return null;
  return {
    value: current,
    delta: toNumber(pick(value, ["delta", "change", "diff"])),
    deltaLabel: toText(pick(value, ["delta_label", "deltaLabel", "comparison", "since"])),
    series: toSeries(pick(value, ["series", "spark", "sparkline", "points", "daily", "history"])),
  };
}

function readSummary(body: unknown): Summary {
  const summary: Summary = {};
  const root = isObject(body) ? body : {};
  const list = Array.isArray(body) ? body : Array.isArray(root.tiles) ? root.tiles : Array.isArray(root.metrics) ? root.metrics : null;

  if (list) {
    for (const entry of list) {
      if (!isObject(entry)) continue;
      const key = summaryKey(pick(entry, ["key", "id", "name", "metric"]));
      const metric = toMetric(entry);
      if (key && metric) summary[key] = metric;
    }
    return summary;
  }

  // Keyed object: `{ open_cases: {...}, live_calls: {...} }`, optionally
  // wrapped in a `tiles` / `summary` envelope.
  const source = isObject(root.tiles) ? root.tiles : isObject(root.summary) ? root.summary : root;
  for (const [name, entry] of Object.entries(source)) {
    const key = summaryKey(name);
    if (!key) continue;
    const metric = toMetric(entry);
    if (metric) summary[key] = metric;
  }
  return summary;
}

function readCallVolume(body: unknown): CallVolume {
  const root = isObject(body) ? body : {};
  const rawBuckets = pick(root, ["buckets", "days", "points", "series", "daily"]);
  const buckets: VolumeBucket[] = [];
  if (Array.isArray(rawBuckets)) {
    for (const entry of rawBuckets) {
      if (!isObject(entry)) continue;
      const date = toText(pick(entry, ["date", "day", "bucket", "label"]));
      const count = toNumber(pick(entry, ["count", "calls", "value", "total"]));
      if (date === null || count === null) continue;
      buckets.push({ date, count });
    }
  }
  const total = toNumber(pick(root, ["total", "total_calls", "count"]));
  return {
    total: total ?? buckets.reduce((sum, bucket) => sum + bucket.count, 0),
    changePercent: toNumber(pick(root, ["change_pct", "change_percent", "changePercent", "percent_change", "delta_percent", "change"])),
    buckets,
  };
}

function sliceLabel(key: string, given: string | null): string {
  if (given) return given;
  if (key in ISSUE_LABEL) return ISSUE_LABEL[key as IssueType];
  return key.replace(/_/g, " ").replace(/^./, (character) => character.toUpperCase());
}

function readCasesByType(body: unknown): CasesByType {
  const root = isObject(body) ? body : {};
  const rawSlices = Array.isArray(body) ? body : pick(root, ["slices", "types", "buckets", "items", "breakdown"]);
  const slices: TypeSlice[] = [];
  if (Array.isArray(rawSlices)) {
    for (const entry of rawSlices) {
      if (!isObject(entry)) continue;
      const key = toText(pick(entry, ["key", "issue_type", "type", "id"]));
      const count = toNumber(pick(entry, ["count", "value", "total"]));
      if (count === null) continue;
      const label = toText(pick(entry, ["label", "name"]));
      if (key === null && label === null) continue;
      const resolved = key ?? label ?? "other";
      slices.push({
        key: resolved,
        label: sliceLabel(resolved, label),
        count,
        percent: toNumber(pick(entry, ["percent", "percentage", "share"])) ?? 0,
      });
    }
  }
  const total = toNumber(pick(root, ["total", "count", "total_cases"]));
  const summed = slices.reduce((sum, slice) => sum + slice.count, 0);
  return { total: total ?? summed, slices };
}

function readNeedsAttention(body: unknown): AttentionGroup[] {
  const root = isObject(body) ? body : {};
  const raw = Array.isArray(body) ? body : pick(root, ["groups", "alerts", "items", "attention"]);
  if (!Array.isArray(raw)) return [];
  const groups: AttentionGroup[] = [];
  for (const entry of raw) {
    if (!isObject(entry)) continue;
    const title = toText(pick(entry, ["title", "label", "name", "headline"]));
    const count = toNumber(pick(entry, ["count", "value", "total"]));
    if (title === null || count === null) continue;
    groups.push({
      key: toText(pick(entry, ["key", "id", "kind"])) ?? title,
      count,
      title,
      detail: toText(pick(entry, ["detail", "description", "hint", "subtitle", "reason"])) ?? "",
    });
  }
  return groups;
}

// ------------------------------------------------------------------ reads

export const statsApi = {
  async summary(): Promise<Summary> {
    return readSummary(await request<unknown>("/api/stats/summary"));
  },

  async callVolume(days: number): Promise<CallVolume> {
    return readCallVolume(await request<unknown>(`/api/stats/call-volume?days=${days}`));
  },

  async casesByType(): Promise<CasesByType> {
    return readCasesByType(await request<unknown>("/api/stats/cases-by-type"));
  },

  async needsAttention(): Promise<AttentionGroup[]> {
    return readNeedsAttention(await request<unknown>("/api/stats/needs-attention"));
  },
};

// ------------------------------------------------------------ presentation

/**
 * Which way is good for each tile, which is not the same way for all of them.
 * More cases opened is the intake working; a slower resolution and a rising
 * escalation count are both bad news; live calls is a snapshot, so neither.
 */
export const GOOD_DIRECTION: Record<SummaryKey, "up" | "down" | "neutral"> = {
  open_cases: "up",
  live_calls: "neutral",
  avg_resolution_days: "down",
  escalations: "down",
};

export function deltaTone(key: SummaryKey, delta: number | null): "good" | "bad" | "flat" {
  if (delta === null || delta === 0) return "flat";
  const direction = GOOD_DIRECTION[key];
  if (direction === "neutral") return "flat";
  const rising = delta > 0;
  return (direction === "up") === rising ? "good" : "bad";
}

/** `18` -> `+18`, `-2` -> `-2`. One decimal only where the value carries one. */
export function signed(value: number): string {
  const rounded = Number.isInteger(value) ? value : Math.round(value * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded}`;
}

export function percentText(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}
