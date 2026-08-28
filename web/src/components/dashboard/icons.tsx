/**
 * Hand-authored glyphs for the dashboard. Small enough that a dependency would
 * cost more than it saves; each one inherits `currentColor` from its holder.
 */

type IconProps = { className?: string };

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export function FolderIcon({ className = "h-[18px] w-[18px]" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden className={className} {...STROKE}>
      <path d="M2.75 5.5A1.75 1.75 0 0 1 4.5 3.75h2.6c.5 0 .96.24 1.26.64l.78 1.06h6.36c.97 0 1.75.78 1.75 1.75v7.05c0 .97-.78 1.75-1.75 1.75H4.5a1.75 1.75 0 0 1-1.75-1.75z" />
    </svg>
  );
}

export function PhoneIcon({ className = "h-[18px] w-[18px]" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden className={className} {...STROKE}>
      <path d="M6.2 3.3 4.2 4.4c-.7.4-1 1.2-.8 2 .8 3 2.3 5.4 4.4 7.3 2 1.9 4.2 3 6.5 3.4.8.1 1.6-.3 1.9-1l.9-2.1-3.3-2-1.4 1.6a12 12 0 0 1-4.4-4.6L9.5 6.6z" />
    </svg>
  );
}

export function ClockIcon({ className = "h-[18px] w-[18px]" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden className={className} {...STROKE}>
      <circle cx="10" cy="10" r="6.75" />
      <path d="M10 6.1V10l2.6 1.7" />
    </svg>
  );
}

export function TrendUpIcon({ className = "h-[18px] w-[18px]" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden className={className} {...STROKE}>
      <path d="M4 12.8 8.2 8.6l2.7 2.7 4.6-4.9" />
      <path d="M11.5 6.1h4.2v4.2" />
    </svg>
  );
}

export function DocumentIcon({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} {...STROKE}>
      <path d="M4.4 2.2h4.3l3 3v8.6a.9.9 0 0 1-.9.9H4.4a.9.9 0 0 1-.9-.9V3.1a.9.9 0 0 1 .9-.9z" />
      <path d="M8.6 2.3v3h3" />
    </svg>
  );
}

export function AlertIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden className={className} {...STROKE}>
      <path d="M10 3.4 2.9 15.5h14.2z" />
      <path d="M10 8v3.1" />
      <path d="M10 13.4h.01" />
    </svg>
  );
}

export function ChevronRightIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden className={className} {...STROKE}>
      <path d="M8 5.5 12.5 10 8 14.5" />
    </svg>
  );
}

export function ChevronDownIcon({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden className={className} {...STROKE}>
      <path d="M5.5 8 10 12.5 14.5 8" />
    </svg>
  );
}

export function ArrowRightIcon({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} {...STROKE}>
      <path d="M3 8h9.2" />
      <path d="M9 4.6 12.5 8 9 11.4" />
    </svg>
  );
}
