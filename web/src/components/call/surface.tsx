"use client";

/**
 * The call console's light surface.
 *
 * The rest of the app is a dark staff dashboard; this page is the resident-side
 * console and carries its own palette. Keeping the card and pill primitives
 * here rather than in `components/ui.tsx` is deliberate: nothing outside this
 * folder should pick up the light theme by accident.
 */

import type { ReactNode } from "react";

export function ConsoleCard({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    // Flat by design: the card and the page are the same colour, and a card is
    // separated by its hairline and by spacing, never by elevation or a colour
    // step. No shadow belongs here.
    <section className={`rounded-[13px] border border-slate-200/90 bg-white ${className}`}>{children}</section>
  );
}

export function CardHeading({
  title,
  action,
  className = "",
}: {
  title: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    // A fixed height keeps the three column titles on one baseline whatever
    // their trailing action is - a chevron, a line of text, or a bordered pill.
    <div className={`flex h-[26px] shrink-0 items-center justify-between gap-3 ${className}`}>
      <h2 className="truncate text-[15px] leading-5 font-semibold tracking-[-0.01em] whitespace-nowrap text-slate-900">
        {title}
      </h2>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

export function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-[3px] text-[12px] leading-4 font-medium ${tone}`}>
      {children}
    </span>
  );
}

/** The green "this is streaming" dot used in the panel headers. */
export function LiveDot({ live = true }: { live?: boolean }) {
  return (
    <span
      aria-hidden
      className={`h-[7px] w-[7px] shrink-0 rounded-full ${live ? "live-dot bg-emerald-500" : "bg-slate-300"}`}
    />
  );
}
