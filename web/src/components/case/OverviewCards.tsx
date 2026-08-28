"use client";

/**
 * The three read-only Overview cards: the case summary, what the agent
 * extracted, and who reported it.
 *
 * Nothing here invents a value. Every field either shows what the intake
 * captured or says plainly that it has not been captured yet, and the fields
 * named in a live frame's `changed` list are the only ones that highlight.
 */

import { issueLabel, formatPhone, PRIORITY_LABEL, STATUS_LABEL } from "@/lib/labels";
import { formatDateTime } from "@/lib/time";
import type { Case } from "@/lib/types";
import type { CaseGeo } from "@/lib/geo";
import { Icon } from "./icons";
import { Absent, Card, Field, Pill, PRIORITY_TONE, STATUS_TONE } from "./ui";
import type { CaseFacts } from "./derive";

export function CaseSummaryCard({
  item,
  duration,
  changed,
}: {
  item: Case;
  /** mm:ss for the linked call, or null when no call is attached. */
  duration: string | null;
  changed: ReadonlySet<string>;
}) {
  return (
    <Card title="Case Summary">
      <p className={`-mx-1.5 rounded-lg px-1.5 py-1 text-[13.5px] leading-6 text-slate-700 ${changed.has("summary") ? "flash" : ""}`}>
        {item.summary || item.description || <Absent>No summary written yet</Absent>}
      </p>

      <div className="mt-4 grid gap-x-8 gap-y-4 border-t border-hairline-soft pt-4 sm:grid-cols-2">
        <Field icon="tag" label="Issue Type" flashing={changed.has("issue_type")}>
          {item.issue_type ? issueLabel(item.issue_type) : <Absent>Being classified</Absent>}
        </Field>
        <Field icon="mic" label="Source">
          Voice Call
        </Field>

        <Field icon="flag" label="Priority" flashing={changed.has("priority")}>
          <Pill tone={PRIORITY_TONE[item.priority] ?? "slate"}>{PRIORITY_LABEL[item.priority] ?? item.priority}</Pill>
        </Field>
        <Field icon="clock" label="Call Duration">
          {duration ? <span className="tabular-nums">{duration}</span> : <Absent>No call linked</Absent>}
        </Field>

        <Field icon="refresh" label="Status" flashing={changed.has("status")}>
          <Pill tone={STATUS_TONE[item.status] ?? "slate"}>{STATUS_LABEL[item.status] ?? item.status}</Pill>
        </Field>
        <Field icon="hash" label="Case ID">
          <span className="font-mono">{item.case_number}</span>
        </Field>
      </div>
    </Card>
  );
}

export function CollectedDetails({
  geo,
  description,
  changed,
}: {
  geo: CaseGeo;
  description: string | null;
  changed: ReadonlySet<string>;
}) {
  const locationChanged =
    changed.has("location") || changed.has("location_formatted") || changed.has("location_text");

  return (
    <Card title="AI Collected Details">
      <div className="flex flex-col gap-4">
        <Field icon="pin" label="Location" flashing={locationChanged}>
          {geo.formatted ?? <Absent>No location captured yet</Absent>}
        </Field>
        <Field icon="note" label="Description" flashing={changed.has("description")}>
          {description ?? <Absent>No description captured yet</Absent>}
        </Field>
        <Field icon="crosshair" label="Exact Location" flashing={changed.has("location_detail")}>
          {geo.detail ?? <Absent>No on-site detail given</Absent>}
        </Field>
      </div>
    </Card>
  );
}

/** Initials for the avatar glyph; a single dot when we have no name at all. */
function initials(name: string | null): string | null {
  if (!name) return null;
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export function ResidentCard({ facts, changed }: { facts: CaseFacts; changed: ReadonlySet<string> }) {
  const badge = initials(facts.residentName);

  return (
    <Card title="Resident">
      <div className="flex items-center gap-3.5">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-blue-100 bg-blue-50 text-[13px] font-semibold text-blue-700">
          {badge ?? <Icon name="user" className="h-5 w-5 text-blue-500" />}
        </span>
        <div className="min-w-0">
          <p
            className={`-mx-1 rounded px-1 text-[14px] leading-5 font-semibold text-slate-900 ${
              changed.has("reporter_name") ? "flash" : ""
            }`}
          >
            {facts.residentName ?? <Absent>Name not given</Absent>}
          </p>
          <div className={`-mx-1 rounded px-1 ${changed.has("reporter_phone") ? "flash" : ""}`}>
            {facts.residentPhone ? (
              <a
                href={`tel:${facts.residentPhone}`}
                className="font-mono text-[12.5px] text-slate-600 transition-colors hover:text-blue-600"
              >
                {formatPhone(facts.residentPhone)}
              </a>
            ) : (
              <span className="text-[12.5px] text-slate-400 italic">No callback number</span>
            )}
          </div>
          {/* The mockup carries a "resident since" line. We do not hold that,
              so this says the one thing we do know: when they first reported. */}
          {facts.firstReportedAt ? (
            <p className="mt-0.5 text-[11.5px] leading-4 text-slate-400">
              First reported {formatDateTime(facts.firstReportedAt)}
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
