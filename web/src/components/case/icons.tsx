/**
 * Hand-authored glyphs.
 *
 * Every icon on this page is a 16x16 outline drawn on the same grid with the
 * same stroke weight, so a row of them reads as one set. Colour and size come
 * from the caller (`currentColor`, `className`); nothing here is themed.
 */

import type { SVGProps } from "react";

export type IconName =
  | "user"
  | "tag"
  | "calendar"
  | "phone"
  | "pencil"
  | "dots"
  | "chevron-left"
  | "chevron-right"
  | "check"
  | "pin"
  | "clock"
  | "hash"
  | "mic"
  | "note"
  | "crosshair"
  | "external"
  | "alert"
  | "flag"
  | "flame"
  | "building"
  | "map"
  | "refresh"
  | "plus";

const PATHS: Record<IconName, React.ReactNode> = {
  user: (
    <>
      <circle cx="8" cy="5.25" r="2.75" />
      <path d="M2.75 13.75c0-2.35 2.35-3.75 5.25-3.75s5.25 1.4 5.25 3.75" />
    </>
  ),
  tag: (
    <>
      <path d="M2.75 8.4V3.4a.65.65 0 0 1 .65-.65h5l7.1 7.1a.65.65 0 0 1 0 .92l-4.08 4.08a.65.65 0 0 1-.92 0z" />
      <circle cx="6" cy="6" r="1" />
    </>
  ),
  calendar: (
    <>
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.6" />
      <path d="M2.5 6.5h11M5.5 2.25v2.5M10.5 2.25v2.5" />
    </>
  ),
  phone: (
    <path d="M3.1 2.9h2.4l1.1 2.7-1.4 1a7.6 7.6 0 0 0 3.2 3.2l1-1.4 2.7 1.1v2.4a.9.9 0 0 1-1 .9A10.6 10.6 0 0 1 2.2 3.9a.9.9 0 0 1 .9-1z" />
  ),
  pencil: (
    <>
      <path d="M11.4 2.9a1.4 1.4 0 0 1 2 2l-7.3 7.3-2.7.7.7-2.7z" />
      <path d="M10 4.3 11.7 6" />
    </>
  ),
  dots: (
    <>
      <circle cx="3.5" cy="8" r="1.05" />
      <circle cx="8" cy="8" r="1.05" />
      <circle cx="12.5" cy="8" r="1.05" />
    </>
  ),
  "chevron-left": <path d="M9.75 3.75 5.5 8l4.25 4.25" />,
  "chevron-right": <path d="M6.25 3.75 10.5 8l-4.25 4.25" />,
  check: <path d="M3.5 8.4 6.5 11.4 12.5 5" />,
  pin: (
    <>
      <path d="M8 14s4.75-4.1 4.75-7.5a4.75 4.75 0 0 0-9.5 0C3.25 9.9 8 14 8 14z" />
      <circle cx="8" cy="6.4" r="1.7" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 4.75V8l2.25 1.5" />
    </>
  ),
  hash: <path d="M3 6.1h10M2.6 10.1h10M6.6 2.6 5.4 13.4M10.9 2.6 9.7 13.4" />,
  mic: (
    <>
      <rect x="6" y="2" width="4" height="7.5" rx="2" />
      <path d="M3.75 7.75a4.25 4.25 0 0 0 8.5 0M8 12v2" />
    </>
  ),
  note: (
    <>
      <path d="M3.25 2.75h9.5v10.5h-9.5z" />
      <path d="M5.5 5.75h5M5.5 8.25h5M5.5 10.75h3" />
    </>
  ),
  crosshair: (
    <>
      <circle cx="8" cy="8" r="4.25" />
      <path d="M8 1.5v2.25M8 12.25v2.25M1.5 8h2.25M12.25 8h2.25" />
    </>
  ),
  external: <path d="M9.25 2.75h4v4M13.25 2.75 7.5 8.5M11.5 9.5v3.75h-8.75V4.5H6.5" />,
  alert: (
    <>
      <path d="M8 2.75 14 13.25H2z" />
      <path d="M8 6.4v3M8 11.3v.1" />
    </>
  ),
  flag: <path d="M4 14V2.75h8l-1.6 2.9L12 8.5H4" />,
  flame: <path d="M8 1.75s3.9 3 3.9 6.6a3.9 3.9 0 1 1-7.8 0c0-1.2.5-2.2 1.2-3 .2 1 .8 1.6 1.5 1.6.9 0 1.4-.9 1.2-2.3z" />,
  building: (
    <>
      <path d="M3 13.5V3.25h6.5V13.5M9.5 6.75H13V13.5M2 13.5h12" />
      <path d="M5.25 5.75h2M5.25 8.25h2M5.25 10.75h2" />
    </>
  ),
  map: <path d="M2.5 3.9 6 2.6l4 1.4 3.5-1.3v9.4L10 13.4l-4-1.4-3.5 1.3zM6 2.6v9.4M10 4v9.4" />,
  refresh: <path d="M13.25 8a5.25 5.25 0 1 1-1.6-3.78M13.4 2.4v3.1h-3.1" />,
  plus: <path d="M8 3.25v9.5M3.25 8h9.5" />,
};

export function Icon({
  name,
  className = "h-4 w-4",
  ...rest
}: { name: IconName; className?: string } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      focusable="false"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
