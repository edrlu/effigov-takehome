/**
 * Light-theme primitives for the case detail page.
 *
 * The surface language is the product-wide one defined in `globals.css`:
 * `sheet` is both the page and the cards standing on it, so nothing floats.
 * A card is a hairline border and the whitespace around it - no shadow, no
 * colour step - and every card here uses the same header and body padding so
 * the column reads on one vertical rhythm.
 */

import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons";

export function Card({
  title,
  action,
  children,
  className = "",
  flush = false,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  /**
   * Drop the body padding, for a body that has to reach the card's edges - a
   * scrolling list with its own row padding, say. Everything else takes the
   * one padding below, so a column of cards shares a vertical rhythm.
   */
  flush?: boolean;
}) {
  const body = flush ? "pb-0" : `px-5 pb-5 ${title ? "" : "pt-5"}`;
  return (
    <section className={`overflow-hidden rounded-2xl border border-hairline bg-sheet ${className}`}>
      {title ? (
        <header className="flex min-h-[26px] items-center justify-between gap-3 px-5 pt-5 pb-3">
          <h2 className="truncate text-[14px] leading-[26px] font-semibold tracking-tight text-slate-900">{title}</h2>
          {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
        </header>
      ) : null}
      <div className={body}>{children}</div>
    </section>
  );
}

/** A small labelled value with its own outline glyph. The page's workhorse. */
export function Field({
  icon,
  label,
  children,
  flashing = false,
  className = "",
}: {
  icon: IconName;
  label: string;
  children: ReactNode;
  flashing?: boolean;
  className?: string;
}) {
  return (
    <div className={`-mx-1.5 flex gap-2.5 rounded-lg px-1.5 py-1 ${flashing ? "flash" : ""} ${className}`}>
      <Icon name={icon} className="mt-[3px] h-4 w-4 shrink-0 text-slate-400" />
      <div className="min-w-0">
        <p className="text-[12px] leading-[18px] text-slate-500">{label}</p>
        <div className="mt-1 text-[13.5px] leading-5 break-words text-slate-900">{children}</div>
      </div>
    </div>
  );
}

export function Absent({ children = "Not captured yet" }: { children?: ReactNode }) {
  return <span className="text-slate-400 italic">{children}</span>;
}

export type PillTone = "blue" | "amber" | "purple" | "green" | "red" | "slate";

const PILL_TONE: Record<PillTone, string> = {
  blue: "border-blue-200 bg-blue-50 text-blue-700",
  amber: "border-amber-200 bg-amber-50 text-amber-700",
  purple: "border-purple-200 bg-purple-50 text-purple-700",
  green: "border-emerald-200 bg-emerald-50 text-emerald-700",
  red: "border-red-200 bg-red-50 text-red-700",
  slate: "border-slate-200 bg-slate-50 text-slate-600",
};

export function Pill({
  tone = "slate",
  children,
  className = "",
}: {
  tone?: PillTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] leading-5 font-medium whitespace-nowrap ${PILL_TONE[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function SkeletonBar({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-inset ${className}`} />;
}

export function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="px-1 py-6 text-center text-[13px] text-slate-400">{children}</p>;
}

export function ErrorCard({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 px-5 py-4">
      <p className="text-[13px] text-red-700">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg border border-red-300 bg-sheet px-2.5 py-1 text-[12px] font-medium text-red-700 transition-colors hover:bg-red-100"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

/** Status and priority colours, light-theme, shared by every card here. */
export const STATUS_TONE: Record<string, PillTone> = {
  new: "blue",
  in_progress: "amber",
  needs_info: "purple",
  resolved: "green",
};

export const PRIORITY_TONE: Record<string, PillTone> = {
  low: "slate",
  normal: "blue",
  high: "red",
};
