import type { ReactNode } from "react";

export function Panel({
  title,
  action,
  children,
  className = "",
  bodyClassName = "p-4",
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`overflow-hidden rounded-lg border border-line bg-panel ${className}`}>
      {title ? (
        <header className="flex h-11 items-center justify-between gap-3 border-b border-line px-4">
          <h2 className="truncate text-[12px] font-semibold tracking-wide text-muted uppercase">{title}</h2>
          {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
        </header>
      ) : null}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export function EmptyState({
  title,
  hint,
  icon,
}: {
  title: string;
  hint?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon ? <div className="text-faint">{icon}</div> : null}
      <p className="text-[13px] font-medium text-ink">{title}</p>
      {hint ? <p className="max-w-xs text-[12px] leading-5 text-faint">{hint}</p> : null}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-400/25 bg-red-400/8 px-4 py-3">
      <p className="text-[13px] text-red-300">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="rounded border border-red-400/30 px-2 py-1 text-[12px] text-red-200 transition-colors hover:bg-red-400/10"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton rounded ${className}`} />;
}

export function FieldRow({
  label,
  children,
  flashing = false,
}: {
  label: string;
  children: ReactNode;
  flashing?: boolean;
}) {
  return (
    <div
      className={`grid grid-cols-[104px_minmax(0,1fr)] items-start gap-3 rounded px-2 py-1.5 -mx-2 ${flashing ? "flash" : ""}`}
    >
      <dt className="pt-px text-[12px] text-faint">{label}</dt>
      <dd className="min-w-0 text-[13px] break-words text-ink">{children}</dd>
    </div>
  );
}
