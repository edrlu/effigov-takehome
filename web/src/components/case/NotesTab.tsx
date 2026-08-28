"use client";

/** Staff notes. Stored as one stamped, newline-joined string on the case. */

import { useState } from "react";
import { api } from "@/lib/api";
import type { Case } from "@/lib/types";
import { Card } from "./ui";

type ParsedNote = { stamp: string | null; body: string };

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

export function NotesTab({ item, onSaved }: { item: Case; onSaved: (next: Case) => void }) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notes = parseNotes(item.notes);

  const submit = async () => {
    const note = draft.trim();
    if (!note || saving) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await api.addNote(item.id, note));
      setDraft("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the note");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Notes">
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
        className="w-full resize-y rounded-xl border border-hairline bg-sheet px-3 py-2 text-[13px] leading-5 text-slate-900 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none"
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-[11.5px] text-slate-400">
          {error ? <span className="text-red-600">{error}</span> : "Cmd + Enter to save"}
        </p>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={saving || draft.trim().length === 0}
          className="h-8 shrink-0 rounded-lg bg-blue-600 px-3 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? "Saving" : "Add note"}
        </button>
      </div>

      {notes.length === 0 ? (
        <p className="mt-4 border-t border-hairline-soft pt-4 text-[13px] text-slate-400">
          No notes yet. Notes are stamped and stay with the case for every later caller.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-hairline-soft border-t border-hairline-soft">
          {notes.map((note, index) => (
            <li key={`${note.stamp ?? "note"}-${index}`} className="py-2.5">
              {note.stamp ? <p className="text-[11.5px] text-slate-400 tabular-nums">{note.stamp}</p> : null}
              <p className="mt-0.5 text-[13px] leading-5 break-words whitespace-pre-wrap text-slate-800">{note.body}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
