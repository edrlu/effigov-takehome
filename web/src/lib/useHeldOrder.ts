"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Keeps rows still under the cursor.
 *
 * The displayed order is state that only advances deliberately. Live updates
 * always change the *contents* of a row - a field that moved lights up in
 * place - but they only change the *order* when nobody is reading. While the
 * table is held, an incoming case or a re-sort is withheld and reported back as
 * a count, so the user can take the change when they are ready instead of
 * having a row slide out from under a click.
 *
 * `resetKey` is the user's own filter/sort/search signature: when the user
 * changes what they are looking at, the new order is theirs to expect, so it is
 * committed immediately rather than queued.
 */
export interface HeldOrder<T> {
  /** Rows in the order currently on screen, carrying the latest field values. */
  rows: T[];
  /** Rows that exist but are being withheld to keep the order still. */
  added: number;
  /** Rows on screen that no longer belong (filtered out, or gone). */
  removed: number;
  /** The remaining rows want a different order. */
  reordered: boolean;
  /** Total held changes, for the "N updates" affordance. */
  pending: number;
  /** Take the pending order and keep holding from there. */
  apply: () => void;
}

function sameKeys(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

export function useHeldOrder<T>(
  items: T[],
  keyOf: (item: T) => number,
  { hold, resetKey }: { hold: boolean; resetKey: string },
): HeldOrder<T> {
  const desiredKeys = useMemo(() => items.map(keyOf), [items, keyOf]);
  const byKey = useMemo(() => new Map(items.map((item) => [keyOf(item), item])), [items, keyOf]);

  const [committed, setCommitted] = useState<number[]>(desiredKeys);
  const desiredRef = useRef(desiredKeys);
  desiredRef.current = desiredKeys;
  const resetRef = useRef(resetKey);

  useEffect(() => {
    // The user changed the view themselves; do not make them ask for it twice.
    if (resetRef.current !== resetKey) {
      resetRef.current = resetKey;
      setCommitted(desiredKeys);
      return;
    }
    if (hold) return;
    setCommitted((previous) => (sameKeys(previous, desiredKeys) ? previous : desiredKeys));
  }, [hold, desiredKeys, resetKey]);

  const rows = useMemo(() => {
    const out: T[] = [];
    for (const key of committed) {
      const item = byKey.get(key);
      if (item !== undefined) out.push(item);
    }
    return out;
  }, [committed, byKey]);

  const { added, removed, reordered } = useMemo(() => {
    const shown = new Set(committed);
    let addedCount = 0;
    for (const key of desiredKeys) if (!shown.has(key)) addedCount += 1;

    let removedCount = 0;
    for (const key of committed) if (!byKey.has(key)) removedCount += 1;

    // Ignore withheld rows when asking whether what is on screen is in order.
    const survivors = desiredKeys.filter((key) => shown.has(key));
    return {
      added: addedCount,
      removed: removedCount,
      reordered: !sameKeys(
        rows.map(keyOf),
        survivors,
      ),
    };
  }, [committed, desiredKeys, byKey, rows, keyOf]);

  const apply = useCallback(() => {
    setCommitted(desiredRef.current);
  }, []);

  return {
    rows,
    added,
    removed,
    reordered,
    pending: added + removed + (reordered ? 1 : 0),
    apply,
  };
}

/**
 * True while the user is reading or interacting inside the element: a live
 * reorder now would move a row out from under them.
 */
export function useEngagement(): { engaged: boolean; handlers: Record<string, () => void> } {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  return {
    engaged: hovered || focused,
    handlers: {
      onMouseEnter: () => setHovered(true),
      onMouseLeave: () => setHovered(false),
      onFocusCapture: () => setFocused(true),
      onBlurCapture: () => setFocused(false),
    },
  };
}
