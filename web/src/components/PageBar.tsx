"use client";

/**
 * The page's own title and action, rendered inside the top bar.
 *
 * There is one horizontal bar in this product, not a nav bar with a page header
 * row underneath it. A page announces where it is by rendering `<PageBar />`
 * anywhere in its tree; `TopNav` reads it and draws it beside the nav items.
 *
 * The action is passed as plain data rather than as a node on purpose: a JSX
 * node is a new object on every render, which would make the effect below fire
 * forever.
 */

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export interface PageBarAction {
  href: string;
  label: string;
}

interface PageBarState {
  title: string | null;
  action: PageBarAction | null;
}

const EMPTY: PageBarState = { title: null, action: null };

const PageBarContext = createContext<{
  state: PageBarState;
  set: (next: PageBarState) => void;
}>({ state: EMPTY, set: () => {} });

export function PageBarProvider({ children }: { children: ReactNode }) {
  const [state, set] = useState<PageBarState>(EMPTY);
  const value = useMemo(() => ({ state, set }), [state]);
  return <PageBarContext.Provider value={value}>{children}</PageBarContext.Provider>;
}

/** Read by `TopNav`. */
export function usePageBar(): PageBarState {
  return useContext(PageBarContext).state;
}

/** Rendered by a page to put its title and action in the one top bar. */
export function PageBar({ title, action }: { title: string; action?: PageBarAction }) {
  const { set } = useContext(PageBarContext);
  const href = action?.href ?? null;
  const label = action?.label ?? null;

  useEffect(() => {
    set({ title, action: href && label ? { href, label } : null });
    return () => set(EMPTY);
  }, [title, href, label, set]);

  return null;
}
