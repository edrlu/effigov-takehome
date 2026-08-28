import type { CaseStatus, Department, IssueType, Priority } from "@/lib/types";
import {
  departmentLabel,
  scoreTone,
  ISSUE_LABEL,
  PRIORITY_DOT,
  PRIORITY_LABEL,
  PRIORITY_TEXT,
  STATUS_BADGE,
  STATUS_DOT,
  STATUS_LABEL,
} from "@/lib/labels";

export function StatusBadge({ status, className = "" }: { status: CaseStatus; className?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap ${STATUS_BADGE[status]} ${className}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`} />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function PriorityTag({ priority }: { priority: Priority }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 text-[12px] whitespace-nowrap ${PRIORITY_TEXT[priority]}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${PRIORITY_DOT[priority]}`} />
      {PRIORITY_LABEL[priority]}
    </span>
  );
}

export function IssueTag({ issue }: { issue: IssueType | null }) {
  if (!issue) {
    return <span className="text-[12px] text-faint">Unclassified</span>;
  }
  return (
    <span className="inline-flex max-w-full items-center truncate rounded border border-line bg-raised px-1.5 py-0.5 text-[11px] leading-4 text-muted">
      {ISSUE_LABEL[issue] ?? issue}
    </span>
  );
}

export function DepartmentTag({ department }: { department: Department | null | undefined }) {
  if (!department) return null;
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 truncate rounded border border-line bg-raised px-1.5 py-0.5 text-[11px] leading-4 text-muted">
      <svg viewBox="0 0 16 16" aria-hidden className="h-3 w-3 shrink-0 text-faint" fill="currentColor">
        <path d="M2 14V6.5L8 3l6 3.5V14h-4.5v-4h-3v4H2Z" />
      </svg>
      {departmentLabel(department)}
    </span>
  );
}

/** The demo money shot: how many residents reported this same incident. */
export function ReportCountPill({
  count,
  flashing = false,
  className = "",
}: {
  count: number;
  flashing?: boolean;
  className?: string;
}) {
  const many = count > 1;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap ${
        many ? "border-accent/35 bg-accent/12 text-accent" : "border-line bg-raised text-faint"
      } ${flashing ? "flash" : ""} ${className}`}
      title={`${count} resident ${count === 1 ? "report" : "reports"} on this incident`}
    >
      <svg viewBox="0 0 16 16" aria-hidden className="h-3 w-3 shrink-0" fill="currentColor">
        <path d="M6 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm5.2.4a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM1 13c0-2.2 2.2-3.6 5-3.6S11 10.8 11 13H1Zm11.2 0c0-1.3-.5-2.4-1.4-3.2 2.2.1 4.2 1.2 4.2 3.2h-2.8Z" />
      </svg>
      {count} {count === 1 ? "report" : "reports"}
    </span>
  );
}

/** Makes it obvious the ranking is computed, not typed in by a clerk. */
export function ScorePill({ score }: { score: number | null | undefined }) {
  if (typeof score !== "number") return null;
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 font-mono text-[11px] leading-4 tabular-nums ${scoreTone(score)}`}
      title="Computed priority score"
    >
      {Math.round(score)}
    </span>
  );
}

export function EscalationBanner({
  reason,
  className = "",
  compact = false,
}: {
  reason: string | null | undefined;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      role="alert"
      className={`flex items-start gap-2 rounded-md border border-red-400/40 bg-red-500/12 ${
        compact ? "px-2 py-1" : "px-3 py-2.5"
      } ${className}`}
    >
      <svg
        viewBox="0 0 16 16"
        aria-hidden
        className={`${compact ? "mt-0.5 h-3.5 w-3.5" : "mt-px h-4 w-4"} shrink-0 text-red-400`}
        fill="currentColor"
      >
        <path d="M8 1.5 15 14H1L8 1.5Zm-.75 4.25v4h1.5v-4h-1.5Zm0 5.25v1.5h1.5v-1.5h-1.5Z" />
      </svg>
      <p className={`min-w-0 ${compact ? "truncate text-[12px]" : "text-[13px] leading-5"} text-red-200`}>
        <span className="font-semibold text-red-300">Escalated</span>
        {reason ? <span className="text-red-200/85"> - {reason}</span> : null}
      </p>
    </div>
  );
}
