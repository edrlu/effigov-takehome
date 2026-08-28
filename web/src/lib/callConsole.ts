/**
 * Presentation rules for the resident call console.
 *
 * The console shows one live call three ways at once - what the agent has
 * extracted, what the case has recorded, and what was said - so the mapping
 * from raw domain rows to the words on screen lives here rather than being
 * spread across five components.
 */

import {
  DEPARTMENT_LABEL,
  PHASE_HINT,
  PRIORITY_LABEL,
  departmentLabel,
  fieldLabel,
  formatPhone,
  issueLabel,
  prettyValue,
  reportersCount,
} from "./labels";
import { callPhase, type Call, type CaseEvent, type Priority, type Sentiment } from "./types";

export type ConfidenceBand = "high" | "medium" | "low";

/**
 * `issue_type_confidence` is a 0-1 float; staff read a band. The medium floor
 * is the backend's own commit gate, so "Medium" and above is exactly the range
 * in which `issue_type` is allowed to be set.
 */
export function confidenceBand(confidence: number | null | undefined): ConfidenceBand | null {
  if (typeof confidence !== "number" || Number.isNaN(confidence)) return null;
  if (confidence >= 0.8) return "high";
  if (confidence >= 0.6) return "medium";
  return "low";
}

export const CONFIDENCE_LABEL: Record<ConfidenceBand, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const CONFIDENCE_PILL: Record<ConfidenceBand, string> = {
  high: "bg-emerald-50 text-emerald-700",
  medium: "bg-amber-50 text-amber-700",
  low: "bg-rose-50 text-rose-700",
};

export const SENTIMENT_LABEL: Record<Sentiment, string> = {
  positive: "Positive",
  neutral: "Neutral",
  negative: "Negative",
};

export const SENTIMENT_PILL: Record<Sentiment, string> = {
  positive: "bg-emerald-50 text-emerald-700",
  neutral: "bg-slate-100 text-slate-600",
  negative: "bg-rose-50 text-rose-700",
};

export const PRIORITY_PILL: Record<Priority, string> = {
  low: "bg-slate-100 text-slate-600",
  normal: "bg-amber-50 text-amber-700",
  high: "bg-rose-50 text-rose-700",
};

/** The mockup's `Medium`; our domain calls the middle band `normal`. */
export const PRIORITY_CHIP_LABEL: Record<Priority, string> = {
  low: PRIORITY_LABEL.low,
  normal: "Medium",
  high: PRIORITY_LABEL.high,
};

/**
 * The caller's number the way the mockup writes it. The backend may send a
 * pre-formatted string; when it does not, derive one rather than showing raw
 * digits, and fall back to the raw value for anything not North-American.
 */
export function displayPhone(phone: string | null | undefined, preformatted?: string | null): string | null {
  if (preformatted) return preformatted;
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (national.length === 10) return `+1 ${formatPhone(national)}`;
  return phone;
}

/** What the voice agent is doing, in one sentence, for the Voice Agent panel. */
export function activityLine(call: Call | null): string {
  if (!call) return "Waiting for a call to come in.";
  if (call.activity_line) return call.activity_line;
  if (call.status === "completed") return call.summary ?? "Call finished. Wrap-up notes filed.";
  return PHASE_HINT[callPhase(call)] ?? "Handling the call.";
}

export type ActivityTone = "blue" | "purple" | "amber" | "green" | "red" | "slate";

export const ACTIVITY_BADGE: Record<ActivityTone, string> = {
  blue: "bg-blue-100 text-blue-600",
  purple: "bg-purple-100 text-purple-600",
  amber: "bg-amber-100 text-amber-600",
  green: "bg-emerald-100 text-emerald-600",
  red: "bg-rose-100 text-rose-600",
  slate: "bg-slate-100 text-slate-500",
};

export interface ActivityEntry {
  id: number;
  at: string;
  title: string;
  subtitle: string;
  tone: ActivityTone;
}

function departmentFrom(value: string | null): string {
  if (!value) return "a department";
  return DEPARTMENT_LABEL[value as keyof typeof DEPARTMENT_LABEL] ?? departmentLabel(null);
}

/** Routing to `unassigned` is the absence of a decision, not a destination. */
function routedEntry(base: { id: number; at: string }, to: string | null): ActivityEntry {
  if (to === null || to === "unassigned") {
    return { ...base, title: "Awaiting routing", subtitle: "No department assigned yet", tone: "slate" };
  }
  const name = departmentFrom(to);
  return { ...base, title: `Routed to ${name}`, subtitle: `Assigned to the ${name.toLowerCase()} queue`, tone: "purple" };
}

const SENTIMENT_TONE: Record<string, ActivityTone> = {
  positive: "green",
  neutral: "slate",
  negative: "red",
};

/**
 * `call.updated` audits an edit to the call itself - who is on the line, how
 * they sound, what the agent is doing - so the field, not the kind, decides
 * how the row reads.
 */
function callUpdatedEntry(base: { id: number; at: string }, event: CaseEvent): ActivityEntry {
  const to = event.new_value;
  switch (event.field) {
    case "caller_name":
      return { ...base, title: "Caller identified", subtitle: to ?? "Name captured from the call", tone: "green" };
    case "sentiment":
      return {
        ...base,
        title: `Caller sounds ${prettyValue(to)}`,
        subtitle: "Read from the caller's tone",
        tone: SENTIMENT_TONE[to ?? "neutral"] ?? "slate",
      };
    case "activity_line":
      return { ...base, title: "Agent focus changed", subtitle: to ?? "", tone: "slate" };
    default:
      return { ...base, title: `${fieldLabel(event.field)} recorded`, subtitle: prettyValue(to), tone: "slate" };
  }
}

/**
 * One audit row rendered the way the mockup's timeline reads: a bold thing that
 * happened, and a gray line saying why or to what.
 *
 * `case.updated` carries a field name, so it splits into the several distinct
 * moments a viewer actually cares about (a location landing, a classification
 * settling, a priority moving) instead of seven identical "Field updated" rows.
 */
export function activityEntry(event: CaseEvent, caseNumber: string | null): ActivityEntry {
  const base = { id: event.id, at: event.created_at };
  const to = event.new_value;
  const from = event.old_value;

  switch (event.kind) {
    case "case.created":
      return { ...base, title: "Case created", subtitle: caseNumber ? `Case ${caseNumber}` : "Intake record opened", tone: "blue" };
    case "case.routed":
      return routedEntry(base, to);
    case "case.escalated":
      return { ...base, title: "Case escalated", subtitle: to ?? "Flagged for supervisor review", tone: "red" };
    case "note.added":
      return { ...base, title: "Notes added", subtitle: to ?? "Note recorded on the case", tone: "green" };
    case "priority.changed":
      // The backend audits this either as a band (low/normal/high) or as the
      // 0-100 score, depending on which one moved.
      return event.field === "priority"
        ? {
            ...base,
            title: `Priority updated to ${PRIORITY_CHIP_LABEL[to as Priority] ?? prettyValue(to)}`,
            subtitle: "Recalculated from the reports so far",
            tone: "amber",
          }
        : {
            ...base,
            title: "Priority score recalculated",
            subtitle: from && to ? `Score moved from ${from} to ${to}` : "Recalculated from the latest reports",
            tone: "amber",
          };
    case "call.started":
      return { ...base, title: "Call started", subtitle: "Voice agent answered the line", tone: "blue" };
    case "call.ended":
      return { ...base, title: "Call ended", subtitle: "Voice agent closed out the call", tone: "slate" };
    case "call.updated":
      return callUpdatedEntry(base, event);
    case "call.phase":
      return {
        ...base,
        title: `Call moved to ${prettyValue(to)}`,
        subtitle: PHASE_HINT[to as keyof typeof PHASE_HINT] ?? "Call progressed",
        tone: "slate",
      };
    case "report.filed":
      return { ...base, title: "Report filed", subtitle: "Resident report attached to the case", tone: "blue" };
    case "report.merged":
      return {
        ...base,
        title: "Duplicate report merged",
        subtitle: countSubtitle(to) ?? "Folded into the existing incident",
        tone: "purple",
      };
    case "case.updated":
      return updatedEntry(base, event);
    default:
      return { ...base, title: prettyValue(event.kind), subtitle: to ? prettyValue(to) : "", tone: "slate" };
  }
}

function updatedEntry(base: { id: number; at: string }, event: CaseEvent): ActivityEntry {
  const to = event.new_value;
  const from = event.old_value;

  switch (event.field) {
    case "priority":
      return {
        ...base,
        title: `Priority updated to ${PRIORITY_CHIP_LABEL[to as Priority] ?? prettyValue(to)}`,
        subtitle: "Based on resident input",
        tone: "amber",
      };
    case "location":
      return { ...base, title: "Location captured", subtitle: to ?? "Address recorded from the call", tone: "green" };
    case "issue_type":
      return { ...base, title: "Issue classified", subtitle: issueLabel(to as never), tone: "green" };
    case "issue_type_confidence":
      return {
        ...base,
        title: "Classification confidence updated",
        subtitle: to ? `Now ${Math.round(Number(to) * 100)}% sure of the issue type` : "Confidence recorded",
        tone: "slate",
      };
    case "department":
      return routedEntry(base, to);
    case "status":
      return { ...base, title: `Status set to ${prettyValue(to)}`, subtitle: `Was ${prettyValue(from)}`, tone: "blue" };
    case "summary":
      return { ...base, title: "Summary written", subtitle: to ?? "Agent summarised the call", tone: "green" };
    case "description":
      return { ...base, title: "Description captured", subtitle: to ?? "Details recorded from the call", tone: "green" };
    default:
      return {
        ...base,
        title: `${fieldLabel(event.field)} updated`,
        subtitle: from && to ? `${prettyValue(from)} to ${prettyValue(to)}` : prettyValue(to),
        tone: "slate",
      };
  }
}

/**
 * `report_count` is audited as a bare number, and a bare number reads as calls.
 * It counts distinct residents, so the audit line says people.
 */
function countSubtitle(value: string | null): string | null {
  const count = Number(value);
  if (!value || Number.isNaN(count)) return null;
  return `Now ${reportersCount(count)} reporting this incident`;
}

/** Wall-clock the way the mockup prints it: `10:34 AM`. */
export function clock12(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true });
}
