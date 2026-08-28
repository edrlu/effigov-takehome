"use client";

/**
 * Everything the call console knows about the call it is showing.
 *
 * One hook, one websocket (the shared `useLiveEvents` client), three panels.
 * REST is used exactly twice - to seed the active call on mount and to load a
 * case's history the moment the call names a case - and everything after that
 * arrives as frames, so the console updates during a call without a refresh.
 *
 * Which call is "the" call: the one whose room matches the LiveKit session this
 * browser started, if there is one, and otherwise the newest call the stream
 * has mentioned. That keeps the resident looking at their own call while still
 * letting the page be watched against a backend or fixture driving somebody
 * else's.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Call, Case, CaseEvent, Report } from "./types";
import { useFlash } from "./useFlash";
import { useLiveEvents } from "./useLiveEvents";

/** Extracted-Information rows, keyed so a `changed` list can flash one row. */
export type ExtractedField = "name" | "phone" | "issue_type" | "location" | "status" | "department" | "priority";

const CASE_FIELD_TO_ROW: Record<string, ExtractedField> = {
  issue_type: "issue_type",
  location: "location",
  address: "location",
  status: "status",
  department: "department",
  priority: "priority",
  caller_name: "name",
  phone: "phone",
};

const REPORT_FIELD_TO_ROW: Record<string, ExtractedField> = {
  reporter_name: "name",
  reporter_phone: "phone",
};

const CALL_FIELD_TO_ROW: Record<string, ExtractedField> = {
  caller_name: "name",
  caller_phone: "phone",
  caller_phone_display: "phone",
};

export interface CallConsoleState {
  call: Call | null;
  kase: Case | null;
  report: Report | null;
  events: CaseEvent[];
  /** Extracted-Information rows that changed in the last couple of seconds. */
  flashed: ReadonlySet<ExtractedField>;
}

export function useCallConsole(sessionRoom: string | null): CallConsoleState {
  const [call, setCall] = useState<Call | null>(null);
  const [kase, setCase] = useState<Case | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [events, setEvents] = useState<CaseEvent[]>([]);
  const { flash, flashed } = useFlash<ExtractedField>();

  // Handlers register once, so everything they need to make a decision has to
  // be readable from a ref rather than closed over.
  const roomRef = useRef(sessionRoom);
  const callRef = useRef<Call | null>(null);
  const caseIdRef = useRef<number | null>(null);
  /** Cases seen on the wire before a call claimed them, so adoption is instant. */
  const seenCases = useRef(new Map<number, Case>());

  roomRef.current = sessionRoom;

  const flashFields = useCallback(
    (changed: string[] | undefined, map: Record<string, ExtractedField>) => {
      for (const field of changed ?? []) {
        const row = map[field];
        if (row) flash(row);
      }
    },
    [flash],
  );

  /**
   * Is this call the one we should be showing? Our own room always wins; with
   * no session of our own, the newest call does, and a call we are already
   * showing keeps the slot until something newer starts.
   */
  const shouldAdopt = useCallback((candidate: Call): boolean => {
    const room = roomRef.current;
    const current = callRef.current;
    if (room !== null) return candidate.room === room;
    if (current === null) return true;
    if (candidate.id === current.id) return true;
    return candidate.id > current.id;
  }, []);

  const adopt = useCallback((next: Call) => {
    const previous = callRef.current;
    // Eagerly, not on the next render: `call.started` and the `event.appended`
    // that announces it arrive in the same dispatch, so a handler reading a ref
    // that only updates on render would drop the event as belonging to nobody.
    callRef.current = next;
    if (previous && previous.id !== next.id) {
      // A different call took the slot: its case history is not ours.
      caseIdRef.current = null;
      setCase(null);
      setReport(null);
      setEvents([]);
    }
    // The call names its case before the REST snapshot of that case lands, and
    // `case.updated` frames start arriving immediately. Claim the id here or
    // those first frames are discarded as belonging to some other case.
    if (next.case_id !== null) caseIdRef.current = next.case_id;
    setCall(next);
  }, []);

  const applyCase = useCallback((next: Case) => {
    caseIdRef.current = next.id;
    setCase(next);
  }, []);

  const mergeEvents = useCallback((rows: CaseEvent[]) => {
    setEvents((previous) => {
      const byId = new Map(previous.map((row) => [row.id, row]));
      for (const row of rows) byId.set(row.id, row);
      return [...byId.values()].sort((a, b) => a.id - b.id);
    });
  }, []);

  const seed = useCallback(async () => {
    try {
      const active = await api.activeCalls();
      const room = roomRef.current;
      const match = room !== null ? active.find((row) => row.room === room) : active[active.length - 1];
      if (match) adopt(match);
    } catch {
      // No backend yet is a legitimate state for this page: the console renders
      // its empty shell and fills in as soon as frames start arriving.
    }
  }, [adopt]);

  useEffect(() => {
    void seed();
  }, [seed]);

  // A session that starts after the page loaded needs the matching call, and it
  // may already have been announced before we knew our own room name.
  useEffect(() => {
    if (sessionRoom === null) return;
    if (callRef.current?.room === sessionRoom) return;
    void seed();
  }, [sessionRoom, seed]);

  const caseId = call?.case_id ?? null;

  const loadCase = useCallback(
    async (id: number) => {
      const cached = seenCases.current.get(id);
      if (cached) applyCase(cached);
      const [item, rows, reports] = await Promise.allSettled([
        api.getCase(id),
        api.caseEvents(id),
        api.caseReports(id),
      ]);
      if (item.status === "fulfilled") applyCase(item.value);
      // Merge rather than replace: frames that landed while the fetch was in
      // flight are newer than the snapshot, not redundant with it.
      if (rows.status === "fulfilled") mergeEvents(rows.value);
      if (reports.status === "fulfilled" && reports.value) {
        const callId = callRef.current?.id ?? null;
        const mine = reports.value.find((row) => row.call_id === callId) ?? reports.value[0] ?? null;
        setReport(mine);
      }
    },
    [applyCase, mergeEvents],
  );

  useEffect(() => {
    if (caseId === null) return;
    void loadCase(caseId);
  }, [caseId, loadCase]);

  const onCallStarted = useCallback(
    (next: Call) => {
      if (shouldAdopt(next)) adopt(next);
    },
    [adopt, shouldAdopt],
  );

  const onCallUpdated = useCallback(
    ({ call: next, changed }: { call: Call; changed: string[] }) => {
      if (!shouldAdopt(next)) return;
      adopt(next);
      flashFields(changed, CALL_FIELD_TO_ROW);
    },
    [adopt, flashFields, shouldAdopt],
  );

  const onCaseCreated = useCallback(
    (next: Case) => {
      seenCases.current.set(next.id, next);
      if (callRef.current?.case_id === next.id) applyCase(next);
    },
    [applyCase],
  );

  const onCaseUpdated = useCallback(
    ({ case: next, changed }: { case: Case; changed: string[] }) => {
      seenCases.current.set(next.id, next);
      if (next.id !== caseIdRef.current) return;
      applyCase(next);
      flashFields(changed, CASE_FIELD_TO_ROW);
    },
    [applyCase, flashFields],
  );

  const onCaseEscalated = useCallback(
    (next: Case) => {
      seenCases.current.set(next.id, next);
      if (next.id === caseIdRef.current) applyCase(next);
    },
    [applyCase],
  );

  const onReportFiled = useCallback(
    ({ report: next, case: item }: { report: Report; case: Case }) => {
      seenCases.current.set(item.id, item);
      const currentCall = callRef.current;
      const mine = next.call_id !== null && next.call_id === currentCall?.id;
      if (!mine && item.id !== caseIdRef.current) return;
      applyCase(item);
      if (mine) setReport(next);
    },
    [applyCase],
  );

  const onReportUpdated = useCallback(
    ({ report: next, changed }: { report: Report; case_id: number; changed: string[] }) => {
      setReport((previous) => {
        const mine = previous?.id === next.id || (next.call_id !== null && next.call_id === callRef.current?.id);
        return mine ? next : previous;
      });
      if (next.call_id !== null && next.call_id !== callRef.current?.id) return;
      flashFields(changed, REPORT_FIELD_TO_ROW);
    },
    [flashFields],
  );

  const onEventAppended = useCallback((event: CaseEvent) => {
    const matchesCase = event.case_id !== null && event.case_id === caseIdRef.current;
    const matchesCall = event.call_id !== null && event.call_id === callRef.current?.id;
    if (!matchesCase && !matchesCall) return;
    mergeEvents([event]);
  }, [mergeEvents]);

  const resync = useCallback(async () => {
    await seed();
    const id = callRef.current?.case_id ?? null;
    if (id !== null) await loadCase(id);
  }, [loadCase, seed]);

  useLiveEvents(
    {
      "call.started": onCallStarted,
      "call.updated": onCallUpdated,
      "case.created": onCaseCreated,
      "case.updated": onCaseUpdated,
      "case.escalated": onCaseEscalated,
      "report.filed": onReportFiled,
      "report.updated": onReportUpdated,
      "event.appended": onEventAppended,
    },
    resync,
  );

  return { call, kase, report, events, flashed };
}
