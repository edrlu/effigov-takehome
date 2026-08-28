<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## The dashboard is the one light surface

`src/app/page.tsx` renders a light page inside a dark shell. The shell
(`src/app/layout.tsx`) paints `bg-canvas` and constrains width, so the dashboard
breaks out with `left-1/2 w-screen -translate-x-1/2 -my-6` and paints its own
background. That is deliberate, not a stray utility class: removing it drops a
card grid onto a near-black page.

Its analytics reads live in `src/lib/stats.ts`, separate from `src/lib/api.ts`,
and its panels in `src/components/dashboard/`.

## The light pages are one flat surface

`globals.css` carries the light surface tokens alongside the dark palette:
`sheet`, `hairline`, `hairline-soft`, `inset`. The rule they encode is that the
page and the cards standing on it are the *same* colour, and a card is told
apart only by its hairline border and the whitespace around it.

So: no `shadow-*` on a card, and no white-card-on-grey-page colour step. When a
surface genuinely has to read as recessed - a table head, an input well, a
placeholder - use `bg-inset`, never elevation. Reach for the token rather than
writing the hex again, so the next page inherits the rule instead of drifting
from it.

The case page's `Card` (`src/components/case/ui.tsx`) owns the one header and
body padding every card on that page uses; pass `flush` for a body that must
reach the card's edges rather than passing padding classes, which would race
the defaults on stylesheet order.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this
directory. Do not repeat what the codebase already shows; point to the
authoritative file or command instead. Prefer rewriting or pruning existing
entries over appending new ones.
