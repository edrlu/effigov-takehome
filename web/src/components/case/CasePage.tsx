"use client";

/**
 * The case detail page.
 *
 * One REST snapshot per resource, then everything moves over the shared live
 * socket: `case.updated` refreshes the fields (and its `changed` list decides
 * exactly which ones highlight), `report.filed` / `report.updated` fill in the
 * resident, `call.updated` advances the call, and `event.appended` grows the
 * timeline. Nothing here polls, and nothing opens a second socket.
 *
 * The page owns its palette deliberately: light cards, hairline borders, one
 * blue accent, so it reads as the same product as the call console.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { formatPhone, issueLabel, PRIORITY_LABEL, STATUS_LABEL } from "@/lib/labels";
import { formatDateTime, parseServerTime } from "@/lib/time";
import type { Call, Case, CasePatch, CaseStatus, Priority, Report } from "@/lib/types";
import { CASE_STATUSES, PRIORITIES } from "@/lib/types";
import { useFlash } from "@/lib/useFlash";
import { useLiveEvents } from "@/lib/useLiveEvents";
import { useNow } from "@/lib/useNow";
import { ActivityTimeline } from "./ActivityTimeline";
import { CaseProgress } from "./CaseProgress";
import { CaseTranscript } from "./CaseTranscript";
import { DetailsTab } from "./DetailsTab";
import { IncidentLocation } from "./IncidentLocation";
import { NotesTab } from "./NotesTab";
import { CaseSummaryCard, CollectedDetails, ResidentCard } from "./OverviewCards";
import { caseFacts, callDuration, newestCall, progressSteps } from "./derive";
import { Icon, type IconName } from "./icons";
import { ErrorCard, Pill, SkeletonBar, STATUS_TONE } from "./ui";

const TABS = ["Overview", "Transcript", "Details", "Activity", "Notes"] as const;
type Tab = (typeof TABS)[number];

/** One item in the header meta row: an outline glyph and its value. */
function MetaItem({ icon, children }: { icon: IconName; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12.5px] leading-5 text-slate-600">
      <Icon name={icon} className="h-4 w-4 shrink-0 text-slate-400" />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

export function CasePage({ caseId }: { caseId: number }) {
  const [item, setItem] = useState<Case | null>(null);
  const [reports, setReports] = useState<Report[] | null>(null);
  const [call, setCall] = useState<Call | null>(null);
  const [callsLoading, setCallsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("Overview");
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [saving, setSaving] = useState<"status" | "priority" | null>(null);
  const [copied, setCopied] = useState(false);

  const { flash, flashed } = useFlash<string>();
  const now = useNow(1000);

  /**
   * Fields with a staff write in flight. The websocket echo is a snapshot from
   * before our PATCH landed, so applying it wholesale would visibly undo the
   * edit that was just made. Locally-owned fields win until the PATCH resolves.
   */
  const pending = useRef(new Set<string>());

  const loadCase = useCallback(() => {
    setLoadError(null);
    return api
      .getCase(caseId)
      .then(setItem)
      .catch((cause: Error) => setLoadError(cause.message));
  }, [caseId]);

  const loadReports = useCallback(
    () =>
      api
        .caseReports(caseId)
        .then((rows) => setReports(rows ?? []))
        .catch(() => setReports([])),
    [caseId],
  );

  const loadCalls = useCallback(() => {
    setCallsLoading(true);
    return api
      .caseCalls(caseId)
      .then((calls) => setCall(newestCall(calls)))
      .catch(() => setCall(null))
      .finally(() => setCallsLoading(false));
  }, [caseId]);

  useEffect(() => {
    void loadCase();
    void loadReports();
    void loadCalls();
  }, [loadCase, loadReports, loadCalls]);

  const applyCase = useCallback(
    (next: Case, changed: string[]) => {
      setItem((previous) => {
        if (!previous || pending.current.size === 0) return next;
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

  const upsertReport = useCallback((report: Report, changed: string[]) => {
    setReports((previous) => {
      const rest = (previous ?? []).filter((row) => row.id !== report.id);
      return [...rest, report];
    });
    for (const field of changed) flash(field);
  }, [flash]);

  /** The call we are showing, so live frames for it are accepted by id too. */
  const shownCallId = useRef<number | null>(null);
  useEffect(() => {
    shownCallId.current = call?.id ?? null;
  }, [call]);

  /**
   * A call links itself to a case through the report it produced, and the
   * backend does not always backfill `Call.case_id`. When the direct lookup
   * comes back empty, follow the report's `call_id` instead - otherwise a case
   * with a perfectly good transcript claims it has no call.
   */
  useEffect(() => {
    if (call !== null || reports === null) return;
    const linked = [...reports].reverse().find((report) => report.call_id !== null);
    if (!linked?.call_id) return;
    let cancelled = false;
    void api
      .getCall(linked.call_id)
      .then((found) => {
        if (!cancelled) setCall((previous) => previous ?? found);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [call, reports]);

  const applyCall = useCallback(
    (incoming: Call) => {
      if (incoming.case_id !== caseId && incoming.id !== shownCallId.current) return;
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
        if (payload.case.id !== caseId) return;
        applyCase(payload.case, ["report_count", "priority_score"]);
        upsertReport(payload.report, ["reporter_name", "reporter_phone"]);
      },
      "report.updated": (payload) => {
        if (payload.case_id !== caseId) return;
        upsertReport(payload.report, payload.changed);
      },
      "call.started": applyCall,
      "call.updated": (payload) => applyCall(payload.call),
    },
    () => Promise.all([loadCase(), loadReports(), loadCalls()]),
  );

  const facts = useMemo(() => caseFacts(item, reports ?? [], call), [item, reports, call]);
  const steps = useMemo(() => progressSteps(item, facts), [item, facts]);
  const duration = callDuration(call, now);

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
      setItem(previous);
      setActionError(cause instanceof Error ? cause.message : "Update failed");
    } finally {
      setSaving(null);
    }
  };

  if (loadError) {
    return (
      <Shell>
        <BackLink />
        <div className="mt-4">
          <ErrorCard message={loadError} onRetry={() => void loadCase()} />
        </div>
      </Shell>
    );
  }

  if (!item) {
    return (
      <Shell>
        <BackLink />
        <SkeletonBar className="mt-4 h-8 w-56" />
        <SkeletonBar className="mt-3 h-4 w-96" />
        <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]">
          <SkeletonBar className="h-72 rounded-2xl" />
          <SkeletonBar className="h-72 rounded-2xl" />
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <BackLink />

      <div className="mt-3 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-mono text-[26px] leading-8 font-semibold tracking-tight text-slate-900">
              {item.case_number}
            </h1>
            <Pill tone={STATUS_TONE[item.status] ?? "slate"} className={flashed.has("status") ? "flash" : ""}>
              {STATUS_LABEL[item.status] ?? item.status}
            </Pill>
            {item.escalated ? (
              <Pill tone="red">
                <Icon name="flame" className="h-3.5 w-3.5" />
                Escalated
              </Pill>
            ) : null}
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-1.5">
            <MetaItem icon="user">{facts.residentName ?? "Name not given"}</MetaItem>
            <MetaItem icon="tag">{item.issue_type ? issueLabel(item.issue_type) : "Being classified"}</MetaItem>
            <MetaItem icon="calendar">{formatDateTime(item.created_at)}</MetaItem>
            <MetaItem icon="phone">
              {facts.residentPhone ? formatPhone(facts.residentPhone) : "No callback number"}
            </MetaItem>
          </div>
        </div>

        <div className="relative flex shrink-0 items-center gap-2">
          <button
            type="button"
            aria-label="More case actions"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700"
          >
            <Icon name="dots" className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setEditing((open) => !open)}
            aria-expanded={editing}
            className={`flex h-9 items-center gap-1.5 rounded-xl border px-3 text-[13px] font-medium transition-colors ${
              editing
                ? "border-blue-300 bg-blue-50 text-blue-700"
                : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            <Icon name="pencil" className="h-4 w-4" />
            Edit Case
          </button>

          {menuOpen ? (
            <div className="absolute top-11 right-0 z-20 w-52 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(item.case_number).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                  setMenuOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-slate-700 hover:bg-slate-50"
              >
                <Icon name="hash" className="h-4 w-4 text-slate-400" />
                {copied ? "Copied" : "Copy case number"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setTab("Transcript");
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-slate-700 hover:bg-slate-50"
              >
                <Icon name="mic" className="h-4 w-4 text-slate-400" />
                View transcript
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setTab("Notes");
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-slate-700 hover:bg-slate-50"
              >
                <Icon name="note" className="h-4 w-4 text-slate-400" />
                Add a note
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {editing ? (
        <div className="mt-4 flex flex-wrap items-end gap-4 rounded-2xl border border-slate-200 bg-white px-5 py-4">
          <Select
            label="Status"
            value={item.status}
            options={CASE_STATUSES}
            labels={STATUS_LABEL}
            busy={saving === "status"}
            onChange={(next) => void patch({ status: next as CaseStatus }, "status")}
          />
          <Select
            label="Priority"
            value={item.priority}
            options={PRIORITIES}
            labels={PRIORITY_LABEL}
            busy={saving === "priority"}
            onChange={(next) => void patch({ priority: next as Priority }, "priority")}
          />
          <p className="ml-auto text-[12px] text-slate-400">Changes save immediately and broadcast to every viewer.</p>
        </div>
      ) : null}

      {actionError ? (
        <div className="mt-4">
          <ErrorCard message={actionError} />
        </div>
      ) : null}

      <nav className="mt-5 flex gap-6 border-b border-slate-200" aria-label="Case sections">
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setTab(name)}
            aria-current={tab === name ? "page" : undefined}
            className={`-mb-px border-b-2 px-0.5 pb-2.5 text-[13.5px] font-medium transition-colors ${
              tab === name
                ? "border-blue-600 text-blue-700"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            {name}
          </button>
        ))}
      </nav>

      <div className="mt-5">
        {tab === "Overview" ? (
          <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]">
            <div className="flex min-w-0 flex-col gap-5">
              {item.escalated ? (
                <div
                  className={`flex gap-3 rounded-2xl border border-red-200 bg-red-50 px-5 py-4 ${
                    flashed.has("escalated") || flashed.has("escalation_reason") ? "flash" : ""
                  }`}
                >
                  <Icon name="flame" className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-red-700">Escalated</p>
                    <p className="mt-0.5 text-[13px] leading-5 text-red-700/90">
                      {item.escalation_reason || "No reason recorded."}
                    </p>
                  </div>
                </div>
              ) : null}
              <CaseProgress steps={steps} />
              <CaseSummaryCard item={item} duration={duration} changed={flashed} />
              <CollectedDetails geo={facts.geo} description={facts.description} changed={flashed} />
            </div>
            <div className="flex min-w-0 flex-col gap-5">
              <ResidentCard facts={facts} changed={flashed} />
              <IncidentLocation
                geo={facts.geo}
                flashing={
                  flashed.has("location") || flashed.has("location_formatted") || flashed.has("latitude")
                }
              />
              <ActivityTimeline caseId={caseId} limit={5} onViewAll={() => setTab("Activity")} />
            </div>
          </div>
        ) : null}

        {tab === "Transcript" ? (
          <div className="max-w-[880px]">
            <CaseTranscript call={call} loading={callsLoading} />
          </div>
        ) : null}

        {tab === "Details" ? (
          <DetailsTab item={item} facts={facts} reports={reports} duration={duration} changed={flashed} />
        ) : null}

        {tab === "Activity" ? (
          <div className="max-w-[880px]">
            <ActivityTimeline caseId={caseId} />
          </div>
        ) : null}

        {tab === "Notes" ? (
          <div className="max-w-[880px]">
            <NotesTab item={item} onSaved={(next) => applyCase(next, ["notes"])} />
          </div>
        ) : null}
      </div>
    </Shell>
  );
}

/**
 * The app shell is still dark; this page is light. Bleed the light surface to
 * the full viewport width so it reaches the edges instead of floating in a
 * dark frame, and keep the content itself on a centred measure.
 */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative left-1/2 -my-6 min-h-[calc(100vh-3.5rem)] w-screen -translate-x-1/2 bg-[#f6f7f9] px-4 py-7 text-slate-900 sm:px-6">
      <div className="mx-auto w-full max-w-[1180px]">{children}</div>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/"
      className="inline-flex w-fit items-center gap-1.5 text-[12.5px] font-medium text-slate-500 transition-colors hover:text-slate-800"
    >
      <Icon name="chevron-left" className="h-3.5 w-3.5" />
      Back to Cases
    </Link>
  );
}

function Select({
  label,
  value,
  options,
  labels,
  busy,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  labels: Record<string, string>;
  busy: boolean;
  onChange: (next: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11.5px] font-medium text-slate-500">{label}</span>
      <select
        value={value}
        disabled={busy}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-lg border border-slate-200 bg-white px-2.5 text-[13px] text-slate-900 disabled:opacity-50"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {labels[option] ?? option}
          </option>
        ))}
      </select>
    </label>
  );
}
