"use client";

/**
 * The affordance that makes a frozen table honest.
 *
 * It floats over the top of the table rather than sitting above it, so that
 * surfacing a held change never shifts the rows it is protecting. It only
 * exists while something is actually held back.
 */
export function PendingUpdates({
  added,
  removed,
  reordered,
  onApply,
}: {
  added: number;
  removed: number;
  reordered: boolean;
  onApply: () => void;
}) {
  const moved = added + removed;
  if (moved === 0 && !reordered) return null;

  const label =
    added > 0
      ? `${added} new case${added === 1 ? "" : "s"}`
      : removed > 0
        ? `${removed} case${removed === 1 ? "" : "s"} moved out`
        : "New order available";

  return (
    <div className="pointer-events-none absolute inset-x-0 -top-3.5 z-10 flex justify-center">
      <button
        type="button"
        onClick={onApply}
        className="rise-in pointer-events-auto flex items-center gap-2 rounded-full border border-accent/40 bg-raised px-3 py-1 text-[12px] text-accent shadow-lg shadow-canvas/60 transition-colors hover:border-accent/70 hover:bg-accent/12"
      >
        <span aria-hidden className="live-dot h-1.5 w-1.5 rounded-full bg-accent" />
        {label}
        <span className="text-faint">-</span>
        <span className="font-medium">Show</span>
      </button>
    </div>
  );
}
