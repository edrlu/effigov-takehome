"use client";

/**
 * The staff dashboard.
 *
 * Four headline tiles, the case table, and three analytics panels. Every
 * number on this page is read from the API - `/api/cases` for the table and
 * `/api/stats/*` for the tiles and charts - and every panel that cannot read
 * its data says so rather than showing a placeholder.
 *
 * The page shares the one websocket the rest of the app uses: case traffic
 * updates the table in place with the usual field highlight, and schedules a
 * debounced re-read of the analytics so the tiles do not go stale.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StatTiles } from "@/components/dashboard/StatTiles";
import { RecentCases } from "@/components/dashboard/RecentCases";
import { CallVolumePanel } from "@/components/dashboard/CallVolumePanel";
import { CasesByTypePanel } from "@/components/dashboard/CasesByTypePanel";
import { NeedsAttentionPanel } from "@/components/dashboard/NeedsAttentionPanel";
import { api } from "@/lib/api";
import { statsApi, type AttentionGroup, type CallVolume, type CasesByType, type Summary } from "@/lib/stats";
import type { Call, Case } from "@/lib/types";
import { useFlash } from "@/lib/useFlash";
import { useLiveEvents } from "@/lib/useLiveEvents";
import { useNow } from "@/lib/useNow";

/** Case traffic arrives in bursts; re-read the analytics once the burst ends. */
const STATS_DEBOUNCE_MS = 1_200;

type Loaded<T> = { data: T | null; error: string | null };

const pending = <T,>(): Loaded<T> => ({ data: null, error: null });

function settle<T>(result: PromiseSettledResult<T>): Loaded<T> {
  if (result.status === "fulfilled") return { data: result.value, error: null };
  const reason = result.reason;
  return { data: null, error: reason instanceof Error ? reason.message : "Request failed" };
}

export default function DashboardPage() {
  const [cases, setCases] = useState<Case[] | null>(null);
  const [casesError, setCasesError] = useState<string | null>(null);

  /**
   * The calls behind the Live Calls tile. The tile is the only way into a
   * call from this page, so it needs the id of one, not just the count.
   */
  const [liveCalls, setLiveCalls] = useState<Call[]>([]);

  const [days, setDays] = useState(7);
  const [summary, setSummary] = useState<Loaded<Summary>>(pending);
  const [volume, setVolume] = useState<Loaded<CallVolume>>(pending);
  const [byType, setByType] = useState<Loaded<CasesByType>>(pending);
  const [attention, setAttention] = useState<Loaded<AttentionGroup[]>>(pending);
  const [statsLoading, setStatsLoading] = useState(true);

  /** Bumped when a report lands, so cached resident names are re-read. */
  const [reportsToken, setReportsToken] = useState(0);

  const { flash: flashField, flashed: flashedFields } = useFlash<string>();
  const now = useNow(10_000);

  const loadCases = useCallback(() => {
    return api
      .listCases()
      .then((rows) => {
        setCases(rows);
        setCasesError(null);
      })
      .catch((cause: Error) => {
        setCases([]);
        setCasesError(cause.message);
      });
  }, []);

  const loadActiveCalls = useCallback(() => {
    return api
      .activeCalls()
      .then(setLiveCalls)
      .catch(() => {
        // The tile falls back to a plain number; the panels below already
        // report an unreachable API.
      });
  }, []);

  // The four analytics reads are independent: one endpoint being unavailable
  // must not blank the panels that answered.
  const loadStats = useCallback(async (window: number) => {
    const [summaryResult, volumeResult, typeResult, attentionResult] = await Promise.allSettled([
      statsApi.summary(),
      statsApi.callVolume(window),
      statsApi.casesByType(),
      statsApi.needsAttention(),
    ]);
    setSummary(settle(summaryResult));
    setVolume(settle(volumeResult));
    setByType(settle(typeResult));
    setAttention(settle(attentionResult));
    setStatsLoading(false);
  }, []);

  useEffect(() => {
    void loadCases();
  }, [loadCases]);

  useEffect(() => {
    void loadActiveCalls();
  }, [loadActiveCalls]);

  useEffect(() => {
    void loadStats(days);
  }, [loadStats, days]);

  const daysRef = useRef(days);
  useEffect(() => {
    daysRef.current = days;
  }, [days]);

  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleStatsRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void loadStats(daysRef.current);
    }, STATS_DEBOUNCE_MS);
  }, [loadStats]);

  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    [],
  );

  const upsert = useCallback((incoming: Case) => {
    setCases((previous) => {
      const rows = previous ?? [];
      const index = rows.findIndex((item) => item.id === incoming.id);
      if (index === -1) return [incoming, ...rows];
      const next = rows.slice();
      next[index] = incoming;
      return next;
    });
  }, []);

  const highlight = useCallback(
    (item: Case, changed: string[]) => {
      for (const field of changed) flashField(`${item.id}:${field}`);
    },
    [flashField],
  );

  /** Newest first, and a call that ended leaves rather than lingering. */
  const applyCall = useCallback((call: Call) => {
    setLiveCalls((previous) => {
      const rest = previous.filter((item) => item.id !== call.id);
      return call.status === "active" ? [call, ...rest] : rest;
    });
  }, []);

  const resync = useCallback(() => {
    return Promise.all([loadCases(), loadStats(daysRef.current), loadActiveCalls()]);
  }, [loadCases, loadStats, loadActiveCalls]);

  useLiveEvents(
    {
      "case.created": (payload) => {
        upsert(payload);
        highlight(payload, ["created"]);
        scheduleStatsRefresh();
      },
      "case.updated": (payload) => {
        upsert(payload.case);
        highlight(payload.case, payload.changed);
        scheduleStatsRefresh();
      },
      "case.escalated": (payload) => {
        upsert(payload);
        highlight(payload, ["escalated", "priority"]);
        scheduleStatsRefresh();
      },
      "report.filed": (payload) => {
        upsert(payload.case);
        highlight(payload.case, payload.merged ? ["report_count"] : ["created"]);
        setReportsToken((token) => token + 1);
        scheduleStatsRefresh();
      },
      "report.updated": () => {
        setReportsToken((token) => token + 1);
      },
      // A call starting or ending moves the Live Calls tile and the volume
      // chart even when no case changed.
      "call.started": (payload) => {
        applyCall(payload);
        scheduleStatsRefresh();
      },
      "call.updated": (payload) => {
        applyCall(payload.call);
        scheduleStatsRefresh();
      },
    },
    resync,
  );

  const fieldFlash = useCallback(
    (id: number, field: string) => flashedFields.has(`${id}:${field}`),
    [flashedFields],
  );

  const rows = useMemo(() => cases ?? [], [cases]);

  // The call console lives at /calls/[id] and nothing else on this page links
  // to it. Point the tile at the newest call that is still up.
  const liveCallHref = liveCalls.length > 0 ? `/calls/${liveCalls[0].id}` : null;

  return (
    // The rest of the product is dark; this page is the light surface, so it
    // breaks out of the shell's width and paints its own background. That
    // background is `sheet` - the same colour the cards are - so the panels
    // sit flat on it and are told apart by their hairlines alone.
    <div className="relative left-1/2 -my-6 min-h-[calc(100vh-3.5rem)] w-screen -translate-x-1/2 bg-sheet px-4 py-7 sm:px-6">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-4">
        <header className="flex flex-wrap items-end justify-between gap-3 pb-1">
          <div>
            <h1 className="text-[22px] leading-7 font-semibold tracking-tight text-slate-900">Case Dashboard</h1>
            <p className="mt-1 text-[13px] text-slate-500">
              Live 311 intake across every department, updated as calls come in.
            </p>
          </div>
        </header>

        <StatTiles summary={summary.data} loading={statsLoading} liveCallHref={liveCallHref} />

        <RecentCases
          cases={rows}
          loading={cases === null}
          error={casesError}
          fieldFlash={fieldFlash}
          reportsToken={reportsToken}
          now={now}
        />

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <CallVolumePanel
            volume={volume.data}
            days={days}
            onDaysChange={setDays}
            loading={statsLoading}
            error={volume.error}
          />
          <CasesByTypePanel breakdown={byType.data} loading={statsLoading} error={byType.error} />
          <NeedsAttentionPanel groups={attention.data} loading={statsLoading} error={attention.error} />
        </div>
      </div>
    </div>
  );
}
