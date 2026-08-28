"use client";

import { useState } from "react";
import { EmptyState, Panel } from "@/components/ui";
import { api } from "@/lib/api";
import type { Case } from "@/lib/types";

type ParsedNote = { stamp: string | null; body: string };

/** Notes come back as one stamped, newline-joined string. */
function parseNotes(notes: string | null | undefined): ParsedNote[] {
  if (!notes) return [];
  return notes
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^\[([^\]]+)\]\s*(.*)$/.exec(line);
      return match ? { stamp: match[1], body: match[2] } : { stamp: null, body: line };
    })
    .reverse();
}

export function NotesPanel({ caseItem, onSaved }: { caseItem: Case; onSaved: (next: Case) => void }) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notes = parseNotes(caseItem.notes);

  const submit = async () => {
    const note = draft.trim();
    if (!note || saving) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.addNote(caseItem.id, note);
      onSaved(updated);
      setDraft("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the note");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel title="Staff notes" bodyClassName="p-0">
      <div className="border-b border-line p-3">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
          }}
          rows={3}
          placeholder="Add a note for the crew or the next agent"
          className="w-full resize-y rounded-md border border-line bg-canvas px-3 py-2 text-[13px] leading-5 text-ink placeholder:text-faint focus:border-accent/60 focus:outline-none"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="min-w-0 truncate text-[11px] text-faint">
            {error ? <span className="text-red-300">{error}</span> : "Cmd + Enter to save"}
          </p>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={saving || draft.trim().length === 0}
            className="h-8 shrink-0 rounded-md bg-accent px-3 text-[12px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? "Saving" : "Add note"}
          </button>
        </div>
      </div>

      {notes.length === 0 ? (
        <EmptyState title="No notes yet" hint="Notes are stamped and kept with the case for every later caller." />
      ) : (
        <ul className="divide-y divide-line/60">
          {notes.map((note, index) => (
            <li key={`${note.stamp ?? "note"}-${index}`} className="px-4 py-2.5">
              {note.stamp ? <p className="text-[11px] tabular-nums text-faint">{note.stamp}</p> : null}
              <p className="mt-0.5 text-[13px] leading-5 break-words whitespace-pre-wrap text-ink">{note.body}</p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
