"use client";

/** Native select, restyled. Changing it fires a PATCH in the parent. */
export function EnumSelect<T extends string>({
  value,
  options,
  labels,
  onChange,
  busy = false,
  label,
  className = "",
}: {
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (next: T) => void;
  busy?: boolean;
  label: string;
  className?: string;
}) {
  return (
    <div className={`relative inline-flex ${className}`}>
      <select
        aria-label={label}
        value={value}
        disabled={busy}
        onChange={(event) => onChange(event.target.value as T)}
        className="h-8 w-full appearance-none rounded-md border border-line bg-panel py-0 pr-7 pl-2.5 text-[12px] text-ink transition-colors hover:border-line-strong focus:border-accent/60 focus:outline-none disabled:opacity-60"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {labels[option]}
          </option>
        ))}
      </select>
      <svg
        viewBox="0 0 16 16"
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-2 h-3 w-3 -translate-y-1/2 text-faint"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="m4 6.5 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
