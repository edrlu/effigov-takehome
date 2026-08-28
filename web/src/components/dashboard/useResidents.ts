"use client";

/**
 * Resident names for the Recent Cases table.
 *
 * A case carries no reporter of its own - the name lives on its reports - so
 * the visible rows are resolved through `/api/cases/{id}/reports`, oldest
 * report first, and cached. Only the rows actually on screen are fetched, and
 * a case whose reports captured no name resolves to null so the table can show
 * a muted dash instead of guessing.
 */

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

export interface Residents {
  /** The reporter's name, or null once we know there is none. */
  name: (caseId: number) => string | null;
  /** False while the lookup for this case is still outstanding. */
  resolved: (caseId: number) => boolean;
}

/** `caseIds` must be referentially stable - memoize it in the caller. */
export function useResidents(caseIds: number[], invalidateToken: number): Residents {
  const cache = useRef(new Map<number, string | null>());
  const inflight = useRef(new Set<number>());
  const token = useRef(invalidateToken);
  const [, bump] = useState(0);

  useEffect(() => {
    let cancelled = false;

    if (token.current !== invalidateToken) {
      token.current = invalidateToken;
      cache.current.clear();
      inflight.current.clear();
    }

    const missing = caseIds.filter((id) => !cache.current.has(id) && !inflight.current.has(id));
    if (missing.length === 0) return;
    for (const id of missing) inflight.current.add(id);

    void Promise.all(
      missing.map(async (id) => {
        try {
          const reports = await api.caseReports(id);
          const named = (reports ?? []).find((report) => report.reporter_name?.trim());
          cache.current.set(id, named?.reporter_name?.trim() ?? null);
        } catch {
          // Leave it unresolved rather than caching a wrong answer; the next
          // render that still needs the row will ask again.
        } finally {
          inflight.current.delete(id);
        }
      }),
    ).then(() => {
      if (!cancelled) bump((value) => value + 1);
    });

    return () => {
      cancelled = true;
    };
  }, [caseIds, invalidateToken]);

  return {
    name: (caseId) => cache.current.get(caseId) ?? null,
    resolved: (caseId) => cache.current.has(caseId),
  };
}
