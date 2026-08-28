/** The backend serializes naive UTC timestamps, so they need an explicit zone. */

export function parseServerTime(value: string): Date {
  const hasZone = /(?:Z|z|[+-]\d{2}:?\d{2})$/.test(value);
  return new Date(hasZone ? value : `${value}Z`);
}

export function relativeTime(value: string, now: number = Date.now()): string {
  const then = parseServerTime(value).getTime();
  if (Number.isNaN(then)) return "-";

  const seconds = Math.round((now - then) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return parseServerTime(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatClock(value: string): string {
  return parseServerTime(value).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function formatDateTime(value: string): string {
  return parseServerTime(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** mm:ss elapsed, used for live call duration. */
export function formatDuration(fromIso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - parseServerTime(fromIso).getTime()) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
