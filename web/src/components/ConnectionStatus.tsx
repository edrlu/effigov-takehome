"use client";

import { liveSocket, useLiveEvents, type LiveStatus } from "@/lib/useLiveEvents";
import { useNow } from "@/lib/useNow";

/**
 * The one indicator on screen that is allowed to be pessimistic.
 *
 * A dashboard that has quietly lost its feed while still showing confident
 * numbers is the worst failure mode here, so `Reconnecting` also says how stale
 * the data is and offers an immediate retry. `Catching up` is kept distinct
 * from `Live`: replaying an outbox is not the same as being current.
 */
const COPY: Record<LiveStatus, { label: string; dot: string; text: string; pulse: boolean }> = {
  connecting: { label: "Connecting", dot: "bg-slate-300", text: "text-slate-400", pulse: false },
  "catching-up": { label: "Catching up", dot: "bg-blue-600", text: "text-blue-600", pulse: true },
  live: { label: "Live", dot: "bg-emerald-500", text: "text-emerald-600", pulse: true },
  reconnecting: { label: "Reconnecting", dot: "bg-amber-500", text: "text-amber-600", pulse: false },
};

function staleness(downSince: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - downSince) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

export function ConnectionStatus() {
  const { status, downSince } = useLiveEvents({});
  // Only tick while the number on screen is actually moving.
  const now = useNow(downSince === null ? 60_000 : 1000);
  const copy = COPY[status];
  const down = status === "reconnecting" && downSince !== null;
  const stale = down ? staleness(downSince, now) : null;

  const announcement = down ? `Realtime feed lost, ${stale} stale` : `Realtime feed ${copy.label.toLowerCase()}`;

  return (
    <div className="flex shrink-0 items-center">
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>

      <button
        type="button"
        onClick={() => liveSocket.retryNow()}
        disabled={!down}
        title={down ? `No live updates for ${stale}. Click to retry now.` : `Realtime feed: ${copy.label}`}
        aria-label={down ? `${announcement}. Retry now.` : announcement}
        className={`flex h-7 items-center gap-2 rounded-md border px-2 text-[12px] transition-colors ${
          down
            ? "border-amber-300 bg-amber-50 hover:border-amber-400 hover:bg-amber-100"
            : "cursor-default border-transparent"
        }`}
      >
        <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${copy.dot} ${copy.pulse ? "live-dot" : ""}`} />
        <span aria-hidden className={`hidden sm:inline ${copy.text}`}>
          {copy.label}
        </span>
        {stale ? (
          <span aria-hidden className="tabular-nums text-amber-600">
            {stale} stale
          </span>
        ) : null}
      </button>
    </div>
  );
}
