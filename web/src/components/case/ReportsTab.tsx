"use client";

/**
 * The residents behind the case, and what each of them actually said.
 *
 * This tab is supporting evidence, not the case. Everything a staff member
 * needs to work the incident - what it is, where, how many people, how urgent -
 * is answered on the Overview without coming here. What is here is the part
 * the case cannot hold: one resident, their own wording, their own account of
 * the location, and a number a crew chief can ring in one click.
 *
 * One resident is one card, however many times they called: the backend keys a
 * report by phone number within the case, so a neighbour ringing back updates
 * their account rather than adding a second one.
 *
 * The promote control is the one thing on this page that writes. The case's
 * canonical wording is frozen at whatever the first caller happened to say, on
 * purpose, so a later and vaguer account cannot overwrite a sharper one. This
 * is the deliberate way a better one moves up, and it is audited and broadcast
 * as the staff edit it is.
 */

import { useState } from "react";
import { api } from "@/lib/api";
import { formatPhone, reportersPhrase } from "@/lib/labels";
import { formatDateTime } from "@/lib/time";
import type { Case, PromotableField, Report } from "@/lib/types";
import { Icon } from "./icons";
import { Absent, Card, ErrorCard, Pill, SkeletonBar } from "./ui";

/** The two fields a report can lend the case, worded for the button. */
const PROMOTABLE: { field: PromotableField; label: string; noun: string }[] = [
  { field: "description", label: "Their account", noun: "description" },
  { field: "location", label: "Their location", noun: "location" },
];

function text(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Initials for the avatar glyph, at most two. */
function initials(name: string | null): string | null {
  const parts = (name ?? "").split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export function ReportsTab({
  item,
  reports,
  count,
  /** The report the reader arrived here to see, from `?report=` on the URL. */
  focused,
  changed,
  onPromoted,
}: {
  item: Case;
  /** Null while the first fetch is outstanding; an empty array is an answer. */
  reports: Report[] | null;
  count: number;
  focused: number | null;
  changed: ReadonlySet<string>;
  onPromoted: (next: Case) => void;
}) {
  return (
    <div className="flex max-w-[880px] flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <p
          className={`-mx-1.5 flex items-center gap-2 rounded-lg px-1.5 py-1 text-[14px] leading-6 font-semibold text-slate-900 ${
            changed.has("report_count") ? "flash" : ""
          }`}
        >
          <Icon name="users" className="h-4 w-4 shrink-0 text-slate-400" />
          {reportersPhrase(count)}
        </p>
        <p className="text-[12.5px] leading-5 text-slate-500">
          Each account below is one resident&rsquo;s own words. The case above is what staff work.
        </p>
      </div>

      {reports === null ? (
        <div className="flex flex-col gap-4">
          <SkeletonBar className="h-40 rounded-2xl" />
          <SkeletonBar className="h-40 rounded-2xl" />
        </div>
      ) : reports.length === 0 ? (
        <Card>
          <p className="py-6 text-center text-[13px] text-slate-400">
            No resident has filed a report on this case yet.
          </p>
        </Card>
      ) : (
        reports.map((report, index) => (
          <ReportCard
            key={report.id}
            item={item}
            report={report}
            ordinal={index + 1}
            focused={report.id === focused}
            changed={changed}
            onPromoted={onPromoted}
          />
        ))
      )}
    </div>
  );
}

function ReportCard({
  item,
  report,
  ordinal,
  focused,
  changed,
  onPromoted,
}: {
  item: Case;
  report: Report;
  ordinal: number;
  focused: boolean;
  changed: ReadonlySet<string>;
  onPromoted: (next: Case) => void;
}) {
  const [promoting, setPromoting] = useState<PromotableField | null>(null);
  const [error, setError] = useState<string | null>(null);

  const name = text(report.reporter_name);
  const phone = text(report.reporter_phone);
  const badge = initials(name);

  const promote = async (field: PromotableField) => {
    setPromoting(field);
    setError(null);
    try {
      // The returned case is the answer; the `case.updated` frame that follows
      // is the same edit arriving over the socket, and applying it twice is
      // the same as applying it once.
      onPromoted(await api.promoteReport(item.id, report.id, [field]));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not promote this report");
    } finally {
      setPromoting(null);
    }
  };

  return (
    <Card
      className={focused ? "border-blue-300" : ""}
      title={
        <span className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-blue-100 bg-blue-50 text-[11px] font-semibold text-blue-700">
            {badge ?? <Icon name="user" className="h-3.5 w-3.5 text-blue-500" />}
          </span>
          <span className="truncate">{name ?? "Anonymous resident"}</span>
        </span>
      }
      action={
        <>
          {focused ? <Pill tone="blue">From this call</Pill> : null}
          <span className="text-[11.5px] whitespace-nowrap text-slate-400">Reporter {ordinal}</span>
        </>
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-hairline-soft pb-3.5">
        <div className={`-mx-1 min-w-0 rounded px-1 ${changed.has("reporter_phone") ? "flash" : ""}`}>
          {phone ? (
            <a
              href={`tel:${phone}`}
              className="inline-flex items-center gap-1.5 font-mono text-[13px] text-blue-600 transition-colors hover:text-blue-700"
            >
              <Icon name="phone" className="h-3.5 w-3.5 shrink-0" />
              {formatPhone(phone)}
            </a>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[12.5px] text-slate-400 italic">
              <Icon name="phone" className="h-3.5 w-3.5 shrink-0" />
              No callback number left
            </span>
          )}
        </div>
        <span className="text-[12px] whitespace-nowrap text-slate-400">
          Reported {formatDateTime(report.created_at)}
        </span>
      </div>

      <div className="mt-3.5 flex flex-col gap-3.5">
        {PROMOTABLE.map(({ field, label, noun }) => (
          <PromotableRow
            key={field}
            label={label}
            noun={noun}
            value={text(report[field])}
            onCase={text(item[field])}
            busy={promoting === field}
            disabled={promoting !== null}
            onPromote={() => void promote(field)}
          />
        ))}
      </div>

      {error ? (
        <div className="mt-3.5">
          <ErrorCard message={error} />
        </div>
      ) : null}
    </Card>
  );
}

/**
 * One of the resident's own fields, beside the control that adopts it.
 *
 * Three states, and each says something different: nothing captured, already
 * the case's wording, or a different account the staff member can promote. A
 * button is only offered for the third - the other two have nothing to do.
 */
function PromotableRow({
  label,
  noun,
  value,
  onCase,
  busy,
  disabled,
  onPromote,
}: {
  label: string;
  noun: string;
  value: string | null;
  onCase: string | null;
  busy: boolean;
  disabled: boolean;
  onPromote: () => void;
}) {
  const isOnCase = value !== null && value === onCase;

  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-[min(100%,320px)] flex-1">
        <p className="text-[12px] leading-[18px] text-slate-500">{label}</p>
        <p className="mt-1 text-[13.5px] leading-5 break-words text-slate-900">
          {value ?? <Absent>Not given</Absent>}
        </p>
      </div>

      <div className="flex shrink-0 items-center pt-[18px]">
        {value === null ? null : isOnCase ? (
          <span className="inline-flex items-center gap-1.5 text-[12px] whitespace-nowrap text-slate-400">
            <Icon name="check" className="h-3.5 w-3.5 shrink-0" />
            On the case
          </span>
        ) : (
          <button
            type="button"
            onClick={onPromote}
            disabled={disabled}
            title={`Replace the case's ${noun} with this resident's wording`}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-hairline bg-sheet px-2.5 text-[12.5px] font-medium whitespace-nowrap text-slate-700 transition-colors hover:bg-inset disabled:cursor-default disabled:opacity-50"
          >
            <Icon name="arrow-up" className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            {busy ? "Promoting" : "Use on case"}
          </button>
        )}
      </div>
    </div>
  );
}
