"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLiveEvents } from "@/lib/useLiveEvents";

const LINKS = [
  { href: "/", label: "Cases" },
  { href: "/call", label: "Start a call" },
];

const STATUS_COPY = {
  connecting: { label: "Connecting", dot: "bg-faint", text: "text-faint", pulse: false },
  live: { label: "Live", dot: "bg-green-400", text: "text-green-300", pulse: true },
  reconnecting: { label: "Reconnecting", dot: "bg-amber-400", text: "text-amber-300", pulse: false },
} as const;

export function TopNav() {
  const pathname = usePathname();
  const { status } = useLiveEvents({});
  const copy = STATUS_COPY[status];

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-canvas/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-[1280px] items-center gap-6 px-4 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2.5">
          <span className="flex h-6 w-6 items-center justify-center rounded bg-accent text-[12px] font-bold text-canvas">
            E
          </span>
          <span className="text-[14px] font-semibold tracking-tight">
            EffiGov <span className="text-faint">311</span>
          </span>
        </Link>

        <nav className="flex min-w-0 items-center gap-1">
          {LINKS.map((link) => {
            const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`rounded px-2.5 py-1.5 text-[13px] transition-colors ${
                  active ? "bg-raised text-ink" : "text-muted hover:bg-raised/60 hover:text-ink"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-2" title={`Realtime feed: ${copy.label}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${copy.dot} ${copy.pulse ? "live-dot" : ""}`} />
          <span className={`hidden text-[12px] sm:inline ${copy.text}`}>{copy.label}</span>
        </div>
      </div>
    </header>
  );
}
