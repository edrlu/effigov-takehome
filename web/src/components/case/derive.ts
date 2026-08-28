/**
 * Everything the Overview tab reads off the case, in one place.
 *
 * The six progress steps are the interesting part. They are **not** a script of
 * what the agent is supposed to say: each one is a predicate over data the
 * intake actually captured, so a step only lights up once the corresponding
 * fact exists on the case, the report or the call. A call that skips a question
 * leaves its step honestly pending.
 */

import { readGeo, type CaseGeo } from "@/lib/geo";
import { parseServerTime } from "@/lib/time";
import type { Call, Case, Report } from "@/lib/types";

export type StepState = "complete" | "current" | "pending";

export interface ProgressStep {
  key: string;
  name: string;
  state: StepState;
  /** What made it complete, or what is still missing. Shown on hover. */
  detail: string;
}

export interface CaseFacts {
  geo: CaseGeo;
  /** The most recent report on this case, which is the one being filed live. */
  report: Report | null;
  /** The most recent call linked to the case. */
  call: Call | null;
  residentName: string | null;
  residentPhone: string | null;
  /** When this resident first reported anything on this case. */
  firstReportedAt: string | null;
  description: string | null;
  callLive: boolean;
}

function text(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function byNewest<T extends { created_at?: string; started_at?: string }>(rows: T[]): T | null {
  if (rows.length === 0) return null;
  const at = (row: T) => parseServerTime((row.started_at ?? row.created_at) as string).getTime();
  return rows.reduce((latest, row) => (at(row) >= at(latest) ? row : latest));
}

function byOldest<T extends { created_at: string }>(rows: T[]): T | null {
  if (rows.length === 0) return null;
  return rows.reduce((first, row) =>
    parseServerTime(row.created_at).getTime() <= parseServerTime(first.created_at).getTime() ? row : first,
  );
}

export function newestCall(calls: Call[]): Call | null {
  return byNewest(calls);
}

export function caseFacts(item: Case | null, reports: Report[], call: Call | null): CaseFacts {
  const report = byNewest(reports);
  const first = byOldest(reports);
  // Identity is assembled per field, not taken wholesale from one report: a
  // second caller who gave only a description must not blank out the name and
  // number the first caller left.
  const named = byNewest(reports.filter((row) => text(row.reporter_name) !== null));
  const phoned = byNewest(reports.filter((row) => text(row.reporter_phone) !== null));
  const callEnded = call ? call.ended_at !== null || call.status === "completed" || call.phase === "ended" : false;

  return {
    geo: readGeo(item),
    report,
    call,
    // The call carries the caller before a report exists, so a live console and
    // this page agree on who is on the line.
    residentName: text(named?.reporter_name) ?? text((call as { caller_name?: string } | null)?.caller_name),
    residentPhone: text(phoned?.reporter_phone) ?? text(call?.caller_phone),
    firstReportedAt: first?.created_at ?? null,
    description: text(item?.description) ?? text(report?.description),
    callLive: call !== null && !callEnded,
  };
}

/** mm:ss for a call, live or finished. Null when there is no call to time. */
export function callDuration(call: Call | null, now: number): string | null {
  if (!call) return null;
  const start = parseServerTime(call.started_at).getTime();
  if (Number.isNaN(start)) return null;
  const end = call.ended_at ? parseServerTime(call.ended_at).getTime() : now;
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

interface StepRule {
  key: string;
  name: string;
  done: boolean;
  /** Some evidence has landed but the step is not satisfied yet. */
  partial: boolean;
  doneDetail: string;
  todoDetail: string;
}

/**
 * The six steps, each derived from captured data:
 *
 * 1. **Issue Type** - `issue_type` is committed. The backend only writes it at
 *    or above its confidence gate, so a case carrying only a confidence is
 *    still being classified, which is exactly "in progress".
 * 2. **Location** - the caller's location survived in some form:
 *    `location_formatted`, `location_text`, or the legacy `location`.
 * 3. **Details** - a description exists, on the case or on the report.
 * 4. **Contact Info** - both a reporter name and a callback number are on file;
 *    one of the two is partial credit.
 * 5. **Creating Case** - the case has its number *and* a report is filed
 *    against it. A case row with no report yet is mid-creation.
 * 6. **Confirmation** - the linked call has ended. No call linked at all leaves
 *    this pending rather than guessing.
 */
export function progressSteps(item: Case | null, facts: CaseFacts): ProgressStep[] {
  const { geo, call, callLive } = facts;
  const classifying = item?.issue_type == null && typeof item?.issue_type_confidence === "number";
  const locationValue = geo.formatted ?? geo.spoken;
  const hasName = facts.residentName !== null;
  const hasPhone = facts.residentPhone !== null;
  const filed = (item?.report_count ?? 0) > 0 || facts.report !== null;
  const callEnded = call !== null && !callLive;

  const rules: StepRule[] = [
    {
      key: "issue_type",
      name: "Issue Type",
      done: item?.issue_type != null,
      partial: classifying,
      doneDetail: "Issue type committed by the classifier",
      todoDetail: classifying ? "Classifier is not confident enough to commit yet" : "No issue type captured",
    },
    {
      key: "location",
      name: "Location",
      done: locationValue !== null,
      partial: false,
      doneDetail: locationValue ? `Location captured: ${locationValue}` : "",
      todoDetail: "No location captured",
    },
    {
      key: "details",
      name: "Details",
      done: facts.description !== null,
      partial: false,
      doneDetail: "Description captured",
      todoDetail: "No description captured",
    },
    {
      key: "contact",
      name: "Contact Info",
      done: hasName && hasPhone,
      partial: hasName || hasPhone,
      doneDetail: "Reporter name and callback number on file",
      todoDetail: hasName ? "Callback number still missing" : hasPhone ? "Reporter name still missing" : "No contact details captured",
    },
    {
      key: "created",
      name: "Creating Case",
      done: Boolean(item?.case_number) && filed,
      partial: Boolean(item?.case_number),
      doneDetail: item ? `Case ${item.case_number} created with a report attached` : "",
      todoDetail: "Case exists, no report filed against it yet",
    },
    {
      key: "confirmation",
      name: "Confirmation",
      done: callEnded,
      partial: callLive,
      doneDetail: "Call completed",
      todoDetail: call ? "Call is still on the line" : "No call linked to this case",
    },
  ];

  const currentIndex = rules.findIndex((rule) => !rule.done);

  return rules.map((rule, index) => ({
    key: rule.key,
    name: rule.name,
    // Exactly one step is current: the earliest unfinished one, and only while
    // there is something in flight to justify the word.
    state: rule.done ? "complete" : index === currentIndex && (rule.partial || callLive) ? "current" : "pending",
    detail: rule.done ? rule.doneDetail : rule.todoDetail,
  }));
}

export const STEP_STATE_LABEL: Record<StepState, string> = {
  complete: "Completed",
  current: "In Progress",
  pending: "Pending",
};
