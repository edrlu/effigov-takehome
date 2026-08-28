/**
 * The call console's icon set, hand-authored so the page carries no icon
 * dependency. Every glyph is a 24x24 stroked outline that inherits
 * `currentColor` and takes its size from the class the caller passes.
 */

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Outline({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}

export function PhoneIcon(props: IconProps) {
  return (
    <Outline {...props}>
      <path d="M6.6 3.5h-.9A2.7 2.7 0 0 0 3 6.2c0 8.2 6.6 14.8 14.8 14.8a2.7 2.7 0 0 0 2.7-2.7v-.9a1.3 1.3 0 0 0-1-1.3l-3.3-.8a1.3 1.3 0 0 0-1.3.5l-.8 1.1a11.6 11.6 0 0 1-5-5l1.1-.8a1.3 1.3 0 0 0 .5-1.3l-.8-3.3a1.3 1.3 0 0 0-1.3-1Z" />
    </Outline>
  );
}

export function PersonIcon(props: IconProps) {
  return (
    <Outline {...props}>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" />
    </Outline>
  );
}

export function PeopleIcon(props: IconProps) {
  return (
    <Outline {...props}>
      <circle cx="9.5" cy="8.5" r="3.1" />
      <path d="M3.4 19.5a6.1 6.1 0 0 1 12.2 0" />
      <path d="M16.4 5.8a3.1 3.1 0 0 1 0 5.9M17.6 14.2a6.1 6.1 0 0 1 3 5.3" />
    </Outline>
  );
}

export function TagIcon(props: IconProps) {
  return (
    <Outline {...props}>
      <path d="M3.8 11.3V4.8a1 1 0 0 1 1-1h6.5a1 1 0 0 1 .7.3l8 8a1 1 0 0 1 0 1.4l-6.5 6.5a1 1 0 0 1-1.4 0l-8-8a1 1 0 0 1-.3-.7Z" />
      <circle cx="8.2" cy="8.2" r="1.3" />
    </Outline>
  );
}

export function PinIcon(props: IconProps) {
  return (
    <Outline {...props}>
      <path d="M12 21.2s6.8-5.6 6.8-11a6.8 6.8 0 1 0-13.6 0c0 5.4 6.8 11 6.8 11Z" />
      <circle cx="12" cy="10.2" r="2.5" />
    </Outline>
  );
}

export function ListIcon(props: IconProps) {
  return (
    <Outline {...props}>
      <path d="M9 6.5h11M9 12h11M9 17.5h11M4.4 6.5h.01M4.4 12h.01M4.4 17.5h.01" />
    </Outline>
  );
}

export function BuildingIcon(props: IconProps) {
  return (
    <Outline {...props}>
      <path d="M4 20.5h16M6 20.5V4.5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v16M14 9.5h3.5a1 1 0 0 1 1 1v10" />
      <path d="M9 7.5h2M9 11h2M9 14.5h2" />
    </Outline>
  );
}

export function FlagIcon(props: IconProps) {
  return (
    <Outline {...props}>
      <path d="M6 21V4M6 4.6h10.8a.6.6 0 0 1 .48.96l-2.2 2.94a.6.6 0 0 0 0 .72l2.2 2.94a.6.6 0 0 1-.48.96H6" />
    </Outline>
  );
}

export function GlobeIcon(props: IconProps) {
  return (
    <Outline {...props}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M3.4 12h17.2" />
      <path d="M12 3.4c2.2 2.4 3.4 5.4 3.4 8.6s-1.2 6.2-3.4 8.6c-2.2-2.4-3.4-5.4-3.4-8.6s1.2-6.2 3.4-8.6Z" />
    </Outline>
  );
}

export function CheckCircleIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.98 7.42-5.6 6.6a1.1 1.1 0 0 1-1.62.06L6.9 12.84a1.1 1.1 0 1 1 1.56-1.56l2.02 2.02 4.82-5.68a1.1 1.1 0 1 1 1.68 1.42Z" />
    </svg>
  );
}

export function ChevronIcon(props: IconProps) {
  return (
    <Outline strokeWidth={1.8} {...props}>
      <path d="m6 9.5 6 6 6-6" />
    </Outline>
  );
}

export function MicIcon(props: IconProps) {
  return (
    <Outline {...props}>
      <rect x="9" y="2.8" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.2" />
    </Outline>
  );
}

export function MicOffIcon(props: IconProps) {
  return (
    <Outline {...props}>
      <path d="M15 5.6v-.3a3 3 0 0 0-6 0v5.6M9 13.4a3 3 0 0 0 5.1 1.7" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 9.9 5.6M18.5 11.5c0 .7-.1 1.4-.3 2M12 18v3.2" />
      <path d="m3.5 3.5 17 17" />
    </Outline>
  );
}

export function PauseIcon(props: IconProps) {
  return (
    <Outline {...props}>
      <path d="M9.5 5v14M14.5 5v14" />
    </Outline>
  );
}

export function KeypadIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      {[5, 12, 19].map((y) => [5, 12, 19].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.5" />))}
    </svg>
  );
}

export function EndCallIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M12 6.5c-3.1 0-6 .8-8.4 2.2a2.2 2.2 0 0 0-1 2.4l.4 1.7a1.8 1.8 0 0 0 2.2 1.3l2.5-.6a1.8 1.8 0 0 0 1.4-1.9l-.1-1.2c2-.5 4-.5 6 0l-.1 1.2a1.8 1.8 0 0 0 1.4 1.9l2.5.6a1.8 1.8 0 0 0 2.2-1.3l.4-1.7a2.2 2.2 0 0 0-1-2.4A16.6 16.6 0 0 0 12 6.5Z" />
    </svg>
  );
}

export function FilterIcon(props: IconProps) {
  return (
    <Outline {...props}>
      <path d="M4 6.2h16M7 12h10M10 17.8h4" />
    </Outline>
  );
}

export function SparkleIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M12 2.5 13.6 8 19 9.6 13.6 11.2 12 16.7 10.4 11.2 5 9.6 10.4 8 12 2.5Z" />
      <path d="M18.5 14.5 19.4 17l2.5.9-2.5.9-.9 2.5-.9-2.5-2.5-.9 2.5-.9.9-2.5Z" />
    </svg>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <Outline strokeWidth={1.5} {...props}>
      <rect x="4.8" y="10.2" width="14.4" height="10.4" rx="2.2" />
      <path d="M8.4 10.2V7.4a3.6 3.6 0 0 1 7.2 0v2.8" />
    </Outline>
  );
}
