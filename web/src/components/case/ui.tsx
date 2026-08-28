/**
 * Light-theme primitives for the case detail page.
 *
 * The rest of the app still ships its own surfaces; these are deliberately
 * self-contained so this page owns its palette - white cards on a very light
 * neutral page, hairline borders, soft shadows, one blue accent - without
 * reaching into shared theme tokens.
 */

import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons";

export function Card({
  title,
  action,
  children,
  className = "",
  bodyClassName = "px-5 py-4",
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={`overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-16px_rgba(15,23,42,0.18)] ${className}`}
    >
      {title ? (
        <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-1">
          <h2 className="truncate text-[14px] leading-5 font-semibold text-slate-900">{title}</h2>
          {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
        </header>
      ) : null}
      <div className={bodyClassName}>{children}</div>
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
    <div className={`-mx-1.5 flex gap-2.5 rounded-lg px-1.5 py-1.5 ${flashing ? "flash" : ""} ${className}`}>
      <Icon name={icon} className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
      <div className="min-w-0">
        <p className="text-[12px] leading-4 text-slate-500">{label}</p>
        <div className="mt-0.5 text-[13.5px] leading-5 break-words text-slate-900">{children}</div>
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
  return <div className={`animate-pulse rounded bg-slate-200/80 ${className}`} />;
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
          className="rounded-lg border border-red-300 bg-white px-2.5 py-1 text-[12px] font-medium text-red-700 transition-colors hover:bg-red-100"
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
