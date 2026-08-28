/**
 * The light surface language for the staff dashboard: white cards on a very
 * light page, hairline borders, soft shadow. The rest of the product is dark,
 * so these classes are written out here rather than pushed into the shared
 * theme tokens.
 */

import type { ReactNode } from "react";
import { ArrowRightIcon } from "./icons";

export const CARD =
  "rounded-2xl border border-[#e6e8ec] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.05),0_1px_3px_rgba(16,24,40,0.04)]";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`${CARD} ${className}`}>{children}</section>;
}

export function CardHeader({
  title,
  action,
  className = "",
}: {
  title: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <header className={`flex items-center justify-between gap-3 px-5 pt-5 pb-4 ${className}`}>
      <h2 className="text-[15px] leading-5 font-semibold tracking-tight text-slate-900">{title}</h2>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </header>
  );
}

/**
 * The footer link every panel carries in the mockup. It reveals the rows the
 * panel is holding back; with nothing left to reveal it stays as a label
 * rather than becoming a click that does nothing.
 */
export function RevealFooter({
  label,
  expandedLabel,
  expanded,
  hasMore,
  onToggle,
}: {
  label: string;
  expandedLabel: string;
  expanded: boolean;
  hasMore: boolean;
  onToggle: () => void;
}) {
  const interactive = hasMore || expanded;
  const text = expanded ? expandedLabel : label;

  return (
    <div className="border-t border-[#eef0f3] px-5 py-3">
      {interactive ? (
        <button
          type="button"
          onClick={onToggle}
          className="inline-flex items-center gap-1.5 rounded text-[13px] font-medium text-[#2563eb] transition-colors hover:text-[#1d4ed8]"
        >
          {text}
          <ArrowRightIcon className={`h-3.5 w-3.5 ${expanded ? "rotate-180" : ""}`} />
        </button>
      ) : (
        <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-slate-400">
          {text}
          <ArrowRightIcon className="h-3.5 w-3.5" />
        </span>
      )}
    </div>
  );
}

/** Says plainly that a panel has nothing to show, and why. */
export function PanelEmpty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 px-5 py-10 text-center">
      <p className="text-[13px] font-medium text-slate-600">{title}</p>
      {hint ? <p className="max-w-xs text-[12px] leading-5 text-slate-400">{hint}</p> : null}
    </div>
  );
}

export function Shimmer({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-slate-100 ${className}`} />;
}
