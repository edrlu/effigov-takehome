/** One place for the colour and wording of every enum the UI shows. */

import type { CaseStatus, Department, EventKind, IssueType, Priority } from "./types";

export const STATUS_LABEL: Record<CaseStatus, string> = {
  new: "New",
  in_progress: "In progress",
  needs_info: "Needs info",
  resolved: "Resolved",
};

/** Badge styling: border / tint / text, consistent across every screen. */
export const STATUS_BADGE: Record<CaseStatus, string> = {
  new: "border-blue-400/25 bg-blue-400/10 text-blue-300",
  in_progress: "border-amber-400/25 bg-amber-400/10 text-amber-300",
  needs_info: "border-purple-400/25 bg-purple-400/10 text-purple-300",
  resolved: "border-green-400/25 bg-green-400/10 text-green-300",
};

export const STATUS_DOT: Record<CaseStatus, string> = {
  new: "bg-blue-400",
  in_progress: "bg-amber-400",
  needs_info: "bg-purple-400",
  resolved: "bg-green-400",
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
};

export const PRIORITY_TEXT: Record<Priority, string> = {
  low: "text-faint",
  normal: "text-muted",
  high: "text-red-400",
};

export const PRIORITY_DOT: Record<Priority, string> = {
  low: "bg-line-strong",
  normal: "bg-muted/60",
  high: "bg-red-400",
};

export const ISSUE_LABEL: Record<IssueType, string> = {
  missed_collection: "Missed collection",
  pothole: "Pothole",
  streetlight: "Streetlight",
  noise_complaint: "Noise complaint",
  water_leak: "Water leak",
  graffiti: "Graffiti",
  other: "Other",
};

export const DEPARTMENT_LABEL: Record<Department, string> = {
  public_works: "Public works",
  sanitation: "Sanitation",
  utilities: "Utilities",
  code_enforcement: "Code enforcement",
  parks: "Parks",
  unassigned: "Unassigned",
};

export const FIELD_LABEL: Record<string, string> = {
  caller_name: "Caller",
  phone: "Phone",
  address: "Address",
  location: "Location",
  department: "Department",
  priority_score: "Priority score",
  report_count: "Reports",
  escalated: "Escalated",
  escalation_reason: "Escalation reason",
  issue_type: "Issue type",
  description: "Description",
  status: "Status",
  priority: "Priority",
  notes: "Notes",
  summary: "Summary",
};

export const EVENT_LABEL: Record<EventKind, string> = {
  "case.created": "Case created",
  "case.updated": "Field updated",
  "note.added": "Note added",
  "call.started": "Call started",
  "call.ended": "Call ended",
  "report.filed": "Report filed",
  "report.merged": "Report merged",
  "case.escalated": "Escalated",
  "case.routed": "Routed",
  "priority.changed": "Priority recalculated",
};

export const ACTOR_LABEL: Record<string, string> = {
  voice_agent: "Voice agent",
  staff: "Staff",
  system: "System",
};

export function statusLabel(status: CaseStatus): string {
  return STATUS_LABEL[status] ?? status;
}

export function issueLabel(issue: IssueType | null): string {
  return issue ? (ISSUE_LABEL[issue] ?? issue) : "Unclassified";
}

export function departmentLabel(department: Department | null | undefined): string {
  if (!department) return "Unassigned";
  return DEPARTMENT_LABEL[department] ?? department.replace(/_/g, " ");
}

/** Colour band for the computed priority score, on a 0-100 scale. */
export function scoreTone(score: number): string {
  if (score >= 70) return "border-red-400/25 bg-red-400/10 text-red-300";
  if (score >= 40) return "border-amber-400/25 bg-amber-400/10 text-amber-300";
  return "border-line bg-raised text-muted";
}

export function fieldLabel(field: string | null): string {
  if (!field) return "";
  return FIELD_LABEL[field] ?? field.replace(/_/g, " ");
}

export function actorLabel(actor: string): string {
  return ACTOR_LABEL[actor] ?? actor;
}

/** Renders enum values inside the audit log without shouting snake_case. */
export function prettyValue(value: string | null): string {
  if (value === null || value === "") return "empty";
  return value.replace(/_/g, " ");
}
