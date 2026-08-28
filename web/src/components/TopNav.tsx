"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectionStatus } from "@/components/ConnectionStatus";
import { usePageBar } from "@/components/PageBar";
import { useLiveEvents } from "@/lib/useLiveEvents";

const LINKS = [
  { href: "/", label: "Cases" },
  { href: "/call", label: "Start a call" },
];

/**
 * The one bar in the product.
 *
 * Brand, navigation, the current page's title and the current page's action all
 * live on this single row - there is no second header row underneath it. Pages
 * fill the title and action slots with `<PageBar />`.
 *
 * It is a light surface like everything under it: white, one hairline rule at
 * the bottom, no shadow.
 */
export function TopNav() {
  const pathname = usePathname();
  const { status } = useLiveEvents({});
  const { title, action } = usePageBar();
  const down = status === "reconnecting";

  return (
    <header
      className={`sticky top-0 z-30 border-b bg-white transition-colors ${
        // A second, quieter signal that the feed is down, for anyone whose eyes
        // are on the table rather than the indicator.
        down ? "border-amber-300" : "border-slate-200"
      }`}
    >
      <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-4 px-4 sm:gap-5 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2">
          <Image
            src="/emma-logo.png"
            alt="Emma311"
            width={1254}
            height={1254}
            priority
            className="h-7 w-7 shrink-0"
          />
          <span className="text-[14px] font-semibold tracking-tight text-slate-900">Emma311</span>
        </Link>

        <nav className="flex min-w-0 shrink-0 items-center gap-1">
          {LINKS.map((link) => {
            const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`rounded px-2.5 py-1.5 text-[13px] transition-colors ${
                  active
                    ? "bg-blue-50 font-medium text-blue-700"
                    : "text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        {title ? (
          <div className="hidden min-w-0 items-center gap-3 sm:flex">
            <span aria-hidden className="h-4 w-px shrink-0 bg-slate-200" />
            <h1 className="min-w-0 truncate text-[14px] font-semibold tracking-[-0.01em] text-slate-900">{title}</h1>
          </div>
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-4">
          {action ? (
            <Link
              href={action.href}
              className="hidden text-[13px] text-slate-500 underline decoration-slate-300 underline-offset-2 transition-colors hover:text-slate-800 sm:inline"
            >
              {action.label}
            </Link>
          ) : null}
          <ConnectionStatus />
        </div>
      </div>
    </header>
  );
}
