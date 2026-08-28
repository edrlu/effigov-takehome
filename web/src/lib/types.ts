/**
 * Shapes returned by the case API.
 *
 * A Case is the civic incident (one pothole). A Report is one resident's
 * observation of it, so several callers about the same pothole collapse into
 * one case with many reports. Fields marked "legacy" are still emitted by the
 * pre-refactor backend and are read only as a fallback.
 */

export type CaseStatus = "new" | "in_progress" | "needs_info" | "resolved";

export type Priority = "low" | "normal" | "high";

export type IssueType =
  | "missed_collection"
  | "pothole"
  | "streetlight"
  | "noise_complaint"
  | "water_leak"
  | "graffiti"
  | "other";

export type Department =
  | "public_works"
  | "sanitation"
  | "utilities"
  | "code_enforcement"
  | "parks"
  | "unassigned";

export type CallStatus = "active" | "completed";

/**
 * Fine-grained live progression staff watch, orthogonal to `CallStatus`.
 * `status` stays the coarse lifecycle; `phase` is what moves during a call.
 */
export type CallPhase = "greeting" | "gathering" | "filed" | "wrapping" | "ended";

export const CALL_PHASES: CallPhase[] = ["greeting", "gathering", "filed", "wrapping", "ended"];

export type EventKind =
  | "case.created"
  | "case.updated"
  | "note.added"
  | "call.started"
  | "call.ended"
  | "report.filed"
  | "report.merged"
  | "case.escalated"
  | "case.routed"
  | "priority.changed"
  | "call.phase";

export interface Case {
  id: number;
  case_number: string;
  issue_type: IssueType | null;
  /**
   * How sure the agent is of `issue_type`, 0.0-1.0. The backend only commits
   * `issue_type` at or above CONFIDENCE_THRESHOLD, so a case can carry a
   * confidence while `issue_type` is still null: that is "being classified",
   * not "empty".
   */
  issue_type_confidence?: number | null;
  department: Department | null;
  location: string | null;
  description: string | null;
  status: CaseStatus;
  priority: Priority;
  priority_score: number | null;
  report_count: number;
  escalated: boolean;
  escalation_reason: string | null;
  summary: string | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;

  /** Legacy single-caller fields, superseded by Report. */
  caller_name?: string | null;
  phone?: string | null;
  address?: string | null;
}

export interface Report {
  id: number;
  case_id: number;
  call_id: number | null;
  reporter_name: string | null;
  reporter_phone: string | null;
  description: string | null;
  created_at: string;
}

export interface Call {
  id: number;
  room: string;
  case_id: number | null;
  report_id?: number | null;
  status: CallStatus;
  phase: CallPhase;
  caller_phone: string | null;
  summary: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface Turn {
  id: number;
  call_id: number;
  /** Per-call monotonic counter starting at 1; unique per (call_id, turn_seq). */
  turn_seq: number;
  role: TurnRole;
  text: string;
  created_at: string;
}

export type TurnRole = "caller" | "agent";

/**
 * An interim utterance. Never persisted: it carries the `turn_seq` the eventual
 * final `Turn` will use, and the full text so far, so the client replaces
 * rather than concatenates.
 */
export interface TranscriptDelta {
  call_id: number;
  turn_seq: number;
  role: TurnRole;
  text: string;
  final: false;
}

export interface CaseEvent {
  id: number;
  case_id: number | null;
  call_id: number | null;
  kind: EventKind;
  field: string | null;
  old_value: string | null;
  new_value: string | null;
  actor: string;
  created_at: string;
}

export interface TokenResponse {
  token: string;
  url: string;
  room: string;
  identity: string;
}

/** Fields the dashboard is allowed to PATCH. */
export type CasePatch = Partial<{
  issue_type: IssueType;
  department: Department;
  location: string;
  description: string;
  status: CaseStatus;
  priority: Priority;
  summary: string;
}>;

export const CASE_STATUSES: CaseStatus[] = ["new", "in_progress", "needs_info", "resolved"];

export const PRIORITIES: Priority[] = ["low", "normal", "high"];

/** Reports and cases both went through a shape change; read defensively. */
export function reportCount(item: Case): number {
  return typeof item.report_count === "number" && item.report_count > 0 ? item.report_count : 1;
}

export function caseLocation(item: Case): string | null {
  return item.location ?? item.address ?? null;
}

export function isEscalated(item: Case): boolean {
  return item.escalated === true;
}

/** A case the agent has an opinion about but has not committed to yet. */
export function isClassifying(item: Case): boolean {
  return item.issue_type === null && typeof item.issue_type_confidence === "number";
}

export function callPhase(call: Pick<Call, "phase" | "status">): CallPhase {
  if (call.phase) return call.phase;
  return call.status === "completed" ? "ended" : "greeting";
}
