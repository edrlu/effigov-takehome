"use client";

/**
 * The three read-only Overview cards: the case summary, what the agent
 * extracted, and how many residents corroborate it.
 *
 * Nothing here invents a value. Every field either shows what the intake
 * captured or says plainly that it has not been captured yet, and the fields
 * named in a live frame's `changed` list are the only ones that highlight.
 */

import { issueLabel, formatPhone, PRIORITY_LABEL, reportersPhrase, STATUS_LABEL } from "@/lib/labels";
import { formatDateTime } from "@/lib/time";
import type { Case, Report } from "@/lib/types";
import type { CaseGeo } from "@/lib/geo";
import { Icon } from "./icons";
import { Absent, Card, Field, Pill, PRIORITY_TONE, STATUS_TONE } from "./ui";
import type { CaseFacts } from "./derive";

export function CaseSummaryCard({
  item,
  duration,
  reporterCount,
  changed,
}: {
  item: Case;
  /** mm:ss for the linked call, or null when no call is attached. */
  duration: string | null;
  /** Distinct residents, not calls. See `reportersPhrase`. */
  reporterCount: number;
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
        <Field icon="users" label="Reported by" flashing={changed.has("report_count")}>
          {reporterCount > 0 ? (
            reportersPhrase(reporterCount)
          ) : (
            <Absent>No resident report on file yet</Absent>
          )}
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

        <Field icon="mic" label="Source">
          Voice Call
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

/**
 * Corroboration, as people.
 *
 * The count is the point of the card, so it is the sentence at the top rather
 * than a number in a corner: "3 residents reported this" cannot be misread as
 * one neighbour ringing back three times, which a bare 3 can.
 *
 * Underneath it are the residents themselves, each dialable in one click. Only
 * the first few are listed - a crew chief ringing round needs the names and the
 * numbers, and everything else about a resident lives on the Reports tab, one
 * click away.
 */
const LISTED = 3;

export function ReportersCard({
  facts,
  changed,
  onViewAll,
}: {
  facts: CaseFacts;
  changed: ReadonlySet<string>;
  onViewAll: () => void;
}) {
  const { reporters, reporterCount } = facts;
  const shown = reporters.slice(0, LISTED);
  const hidden = reporterCount - shown.length;

  return (
    <Card
      title="Reporters"
      action={
        reporterCount > 0 ? (
          <button
            type="button"
            onClick={onViewAll}
            className="text-[12px] font-medium text-blue-600 transition-colors hover:text-blue-700"
          >
            View reports
          </button>
        ) : null
      }
    >
      <p
        className={`-mx-1.5 flex items-center gap-2 rounded-lg px-1.5 py-1 text-[13.5px] leading-5 font-semibold text-slate-900 ${
          changed.has("report_count") ? "flash" : ""
        }`}
      >
        <Icon name="users" className="h-4 w-4 shrink-0 text-slate-400" />
        {reporterCount > 0 ? reportersPhrase(reporterCount) : "No residents on file yet"}
      </p>

      {shown.length === 0 ? (
        <p className="mt-2.5 text-[12.5px] leading-5 text-slate-400">
          {facts.callLive
            ? "A report is filed once the caller gives their details."
            : "Nobody has filed a report against this case."}
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-3 border-t border-hairline-soft pt-3.5">
          {shown.map((report) => (
            <ReporterRow key={report.id} report={report} changed={changed} />
          ))}
        </ul>
      )}

      {hidden > 0 ? (
        <button
          type="button"
          onClick={onViewAll}
          className="mt-3 text-[12.5px] font-medium text-blue-600 transition-colors hover:text-blue-700"
        >
          {hidden} more {hidden === 1 ? "resident" : "residents"} on the Reports tab
        </button>
      ) : null}

      {/* The mockup carries a "resident since" line. We do not hold that, so
          this says the one thing we do know: when the first report landed. */}
      {facts.firstReportedAt ? (
        <p className="mt-3 border-t border-hairline-soft pt-3 text-[11.5px] leading-4 text-slate-400">
          First reported {formatDateTime(facts.firstReportedAt)}
        </p>
      ) : null}
    </Card>
  );
}

function ReporterRow({ report, changed }: { report: Report; changed: ReadonlySet<string> }) {
  const name = report.reporter_name?.trim() || null;
  const phone = report.reporter_phone?.trim() || null;
  const badge = initials(name);

  return (
    <li className="flex items-center gap-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-blue-100 bg-blue-50 text-[12px] font-semibold text-blue-700">
        {badge ?? <Icon name="user" className="h-4 w-4 text-blue-500" />}
      </span>
      <div className="min-w-0">
        <p
          className={`-mx-1 truncate rounded px-1 text-[13.5px] leading-5 font-medium text-slate-900 ${
            changed.has("reporter_name") ? "flash" : ""
          }`}
        >
          {name ?? <Absent>Name not given</Absent>}
        </p>
        <div className={`-mx-1 rounded px-1 ${changed.has("reporter_phone") ? "flash" : ""}`}>
          {phone ? (
            <a
              href={`tel:${phone}`}
              className="font-mono text-[12.5px] text-slate-600 transition-colors hover:text-blue-600"
            >
              {formatPhone(phone)}
            </a>
          ) : (
            <span className="text-[12.5px] text-slate-400 italic">No callback number</span>
          )}
        </div>
      </div>
    </li>
  );
}
