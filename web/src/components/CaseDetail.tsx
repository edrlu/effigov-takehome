"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuditTimeline } from "@/components/AuditTimeline";
import { DepartmentTag, EscalationBanner, IssueTag, StatusBadge } from "@/components/Badge";
import { EnumSelect } from "@/components/EnumSelect";
import { NotesPanel } from "@/components/NotesPanel";
import { ReportsPanel } from "@/components/ReportsPanel";
import { Transcript } from "@/components/Transcript";
import { ErrorNote, FieldRow, Panel, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import {
  CONFIDENCE_THRESHOLD,
  PRIORITY_LABEL,
  PRIORITY_TEXT,
  STATUS_LABEL,
  confidencePercent,
  departmentLabel,
} from "@/lib/labels";
import {
  CASE_STATUSES,
  PRIORITIES,
  caseLocation,
  isEscalated,
  type Call,
  type Case,
  type CasePatch,
  type CaseStatus,
  type Priority,
} from "@/lib/types";
import { formatDateTime, parseServerTime, relativeTime } from "@/lib/time";
import { useFlash } from "@/lib/useFlash";
import { useLiveEvents } from "@/lib/useLiveEvents";
import { useNow } from "@/lib/useNow";

function newestCall(calls: Call[]): Call | null {
  if (calls.length === 0) return null;
  return calls.reduce((latest, call) =>
    parseServerTime(call.started_at).getTime() >= parseServerTime(latest.started_at).getTime() ? call : latest,
  );
}

function Stat({
  label,
  children,
  flashing = false,
}: {
  label: string;
  children: React.ReactNode;
  flashing?: boolean;
}) {
  return (
    <div className={`rounded-lg border border-line bg-panel px-3 py-2.5 ${flashing ? "flash" : ""}`}>
      <p className="text-[11px] tracking-wide text-faint uppercase">{label}</p>
      <div className="mt-1 flex min-h-6 items-center gap-1.5 text-[15px] leading-6 font-medium text-ink">
        {children}
      </div>
    </div>
  );
}

export function CaseDetail({ caseId }: { caseId: number }) {
  const [item, setItem] = useState<Case | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState<"status" | "priority" | "escalate" | null>(null);
  const [call, setCall] = useState<Call | null>(null);
  const [callsLoading, setCallsLoading] = useState(true);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { flash, flashed } = useFlash<string>();
  const now = useNow(10_000);

  /**
   * Fields with a staff write in flight. The websocket echo of a case is a
   * snapshot from before our PATCH landed, so applying it wholesale would
   * visibly undo the edit the user just made. Locally-owned fields win until
   * the PATCH resolves.
   */
  const pending = useRef(new Set<string>());

  const load = useCallback(() => {
    setLoadError(null);
    return api
      .getCase(caseId)
      .then((next) => setItem(next))
      .catch((cause: Error) => setLoadError(cause.message));
  }, [caseId]);

  const loadCalls = useCallback(() => {
    setCallsLoading(true);
    return api
      .caseCalls(caseId)
      .then((calls) => setCall(newestCall(calls)))
      .catch(() => setCall(null))
      .finally(() => setCallsLoading(false));
  }, [caseId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadCalls();
  }, [loadCalls]);

  const applyCase = useCallback(
    (next: Case, changed: string[]) => {
      setItem((previous) => {
        if (!previous) return next;
        if (pending.current.size === 0) return next;
        const merged = { ...next } as Record<string, unknown>;
        const held = previous as unknown as Record<string, unknown>;
        for (const field of pending.current) merged[field] = held[field];
        return merged as unknown as Case;
      });
      for (const field of changed) {
        if (!pending.current.has(field)) flash(field);
      }
    },
    [flash],
  );

  const applyCall = useCallback(
    (incoming: Call) => {
      if (incoming.case_id !== caseId) return;
      setCall((previous) => {
        if (!previous) return incoming;
        if (previous.id === incoming.id) return incoming;
        return parseServerTime(incoming.started_at).getTime() >= parseServerTime(previous.started_at).getTime()
          ? incoming
          : previous;
      });
    },
    [caseId],
  );

  useLiveEvents(
    {
      "case.updated": (payload) => {
        if (payload.case.id === caseId) applyCase(payload.case, payload.changed);
      },
      "case.escalated": (payload) => {
        if (payload.id === caseId) applyCase(payload, ["escalated", "escalation_reason", "priority_score"]);
      },
      "report.filed": (payload) => {
        if (payload.case.id === caseId) applyCase(payload.case, ["report_count", "priority_score"]);
      },
      "call.started": applyCall,
      "call.updated": (payload) => applyCall(payload.call),
    },
    () => Promise.all([load(), loadCalls()]),
  );

  const patch = async (change: CasePatch, key: "status" | "priority") => {
    if (!item) return;
    const fields = Object.keys(change);
    const previous = item;
    setSaving(key);
    setActionError(null);
    for (const field of fields) pending.current.add(field);
    setItem({ ...item, ...change });
    try {
      const updated = await api.updateCase(item.id, change);
      for (const field of fields) pending.current.delete(field);
      applyCase(updated, []);
    } catch (cause) {
      for (const field of fields) pending.current.delete(field);
      setItem((current) => (current ? ({ ...current, ...pickFields(previous, fields) } as Case) : current));
      setActionError(cause instanceof Error ? cause.message : "Update failed");
    } finally {
      setSaving(null);
    }
  };

  const escalate = async () => {
    if (!item) return;
    const text = reason.trim();
    if (!text) return;
    setSaving("escalate");
    setActionError(null);
    try {
      const updated = await api.escalateCase(item.id, text);
      applyCase(updated, []);
      setReason("");
      setReasonOpen(false);
      flash("escalated");
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Escalation failed");
    } finally {
      setSaving(null);
    }
  };

  const created = useMemo(() => (item ? relativeTime(item.created_at, now) : ""), [item, now]);

  if (loadError) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <ErrorNote message={loadError} onRetry={() => void load()} />
      </div>
    );
  }

  if (!item) {
    return (
      <div className="flex flex-col gap-5">
        <BackLink />
        <Skeleton className="h-8 w-56" />
        <div className="grid gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-16 rounded-lg" />
          ))}
        </div>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)]">
          <Skeleton className="h-72 rounded-lg" />
          <Skeleton className="h-72 rounded-lg" />
        </div>
      </div>
    );
  }

  const escalated = isEscalated(item);
  const settling = flashed.has("issue_type") && item.issue_type !== null;
  const confidence = confidencePercent(item.issue_type_confidence);

  return (
    <div className="flex flex-col gap-5">
      <BackLink />

      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="font-mono text-[20px] leading-7 font-semibold tracking-tight">{item.case_number}</h1>
            <StatusBadge status={item.status} className={flashed.has("status") ? "flash" : ""} />
            <IssueTag issue={item.issue_type} confidence={item.issue_type_confidence} settling={settling} />
          </div>
          <p className="mt-1 max-w-2xl text-[13px] leading-5 text-muted">
            {item.description || "No description captured yet."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <EnumSelect
            label="Case status"
            value={item.status}
            options={CASE_STATUSES}
            labels={STATUS_LABEL}
            busy={saving === "status"}
            onChange={(next: CaseStatus) => void patch({ status: next }, "status")}
          />
          <EnumSelect
            label="Case priority"
            value={item.priority}
            options={PRIORITIES}
            labels={PRIORITY_LABEL}
            busy={saving === "priority"}
            onChange={(next: Priority) => void patch({ priority: next }, "priority")}
          />
          {!escalated ? (
            <button
              type="button"
              onClick={() => setReasonOpen((open) => !open)}
              className="h-8 rounded-md border border-red-400/30 px-2.5 text-[12px] text-red-300 transition-colors hover:border-red-400/50 hover:bg-red-400/10"
            >
              Escalate
            </button>
          ) : null}
        </div>
      </div>

      {reasonOpen && !escalated ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel p-3">
          <input
            value={reason}
            autoFocus
            onChange={(event) => setReason(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void escalate();
              if (event.key === "Escape") setReasonOpen(false);
            }}
            placeholder="Why does this need escalating?"
            aria-label="Escalation reason"
            className="h-8 min-w-0 flex-1 rounded-md border border-line bg-canvas px-2.5 text-[13px] text-ink placeholder:text-faint focus:border-accent/60 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void escalate()}
            disabled={saving === "escalate" || reason.trim().length === 0}
            className="h-8 rounded-md bg-red-500/90 px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving === "escalate" ? "Escalating" : "Confirm"}
          </button>
          <button
            type="button"
            onClick={() => setReasonOpen(false)}
            className="h-8 rounded-md border border-line px-2.5 text-[12px] text-muted transition-colors hover:text-ink"
          >
            Cancel
          </button>
        </div>
      ) : null}

      {escalated ? (
        <EscalationBanner
          reason={item.escalation_reason}
          className={flashed.has("escalated") || flashed.has("escalation_reason") ? "flash" : ""}
        />
      ) : null}

      {actionError ? <ErrorNote message={actionError} /> : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Reports" flashing={flashed.has("report_count")}>
          <span className="tabular-nums">{item.report_count ?? 0}</span>
          <span className="text-[12px] font-normal text-faint">
            {(item.report_count ?? 0) === 1 ? "resident" : "residents"}
          </span>
        </Stat>
        <Stat label="Priority score" flashing={flashed.has("priority_score")}>
          <span className={`tabular-nums ${PRIORITY_TEXT[item.priority]}`}>{item.priority_score ?? 0}</span>
          <span className="text-[12px] font-normal text-faint">{PRIORITY_LABEL[item.priority].toLowerCase()}</span>
        </Stat>
        <Stat label="Department" flashing={flashed.has("department")}>
          <span className="truncate text-[14px]">{departmentLabel(item.department)}</span>
        </Stat>
        <Stat label="Opened">
          <span className="truncate text-[14px]" title={formatDateTime(item.created_at)}>
            {created}
          </span>
        </Stat>
      </div>

      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)]">
        <div className="flex min-w-0 flex-col gap-5">
          <Panel title="Incident">
            <dl className="flex flex-col gap-0.5">
              <FieldRow
                label="Issue type"
                flashing={flashed.has("issue_type") || flashed.has("issue_type_confidence")}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <IssueTag issue={item.issue_type} confidence={item.issue_type_confidence} settling={settling} />
                  {item.issue_type === null && confidence ? (
                    <span className="text-[12px] text-faint">
                      {confidence} confident, needs {Math.round(CONFIDENCE_THRESHOLD * 100)}% to commit
                    </span>
                  ) : null}
                </div>
              </FieldRow>
              <FieldRow label="Location" flashing={flashed.has("location")}>
                {caseLocation(item) || <span className="text-faint">Not captured</span>}
              </FieldRow>
              <FieldRow label="Department" flashing={flashed.has("department")}>
                <DepartmentTag department={item.department ?? "unassigned"} />
              </FieldRow>
              <FieldRow label="Description" flashing={flashed.has("description")}>
                {item.description || <span className="text-faint">Not captured</span>}
              </FieldRow>
              <FieldRow label="Summary" flashing={flashed.has("summary")}>
                {item.summary || <span className="text-faint">No summary yet</span>}
              </FieldRow>
              <FieldRow label="Updated" flashing={flashed.has("updated_at")}>
                <span title={formatDateTime(item.updated_at)}>{relativeTime(item.updated_at, now)}</span>
              </FieldRow>
            </dl>
          </Panel>

          <ReportsPanel caseItem={item} />

          <NotesPanel caseItem={item} onSaved={(next) => applyCase(next, ["notes"])} />
        </div>

        <div className="min-w-0 lg:sticky lg:top-20 lg:h-[calc(100vh-6.5rem)]">
          <Transcript call={call} loading={callsLoading} className="h-[420px] lg:h-full" />
        </div>
      </div>

      <AuditTimeline caseId={caseId} />
    </div>
  );
}

function pickFields(source: Case, fields: string[]): Record<string, unknown> {
  const held = source as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field] = held[field];
  return out;
}

function BackLink() {
  return (
    <Link
      href="/"
      className="inline-flex w-fit items-center gap-1.5 text-[12px] text-muted transition-colors hover:text-ink"
    >
      <svg viewBox="0 0 16 16" aria-hidden className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M9.5 4 5.5 8l4 4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Cases
    </Link>
  );
}
