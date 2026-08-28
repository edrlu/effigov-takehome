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
white card grid onto a near-black page. Its colours are written out as literal
Tailwind classes for the same reason - the `@theme` tokens in `globals.css` are
the dark palette, and every other route still uses them.

Its analytics reads live in `src/lib/stats.ts`, separate from `src/lib/api.ts`,
and its panels in `src/components/dashboard/`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this
directory. Do not repeat what the codebase already shows; point to the
authoritative file or command instead. Prefer rewriting or pruning existing
entries over appending new ones.
