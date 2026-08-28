"use client";

/**
 * Every field the case holds, including the ones the Overview leaves out.
 *
 * This tab is the "show me everything" view: raw geocoding output, the
 * classifier's confidence, the routing decision, and the call record. The
 * residents themselves live on the Reports tab, which is their one home - two
 * lists of the same people would drift apart.
 */

import Link from "next/link";
import {
  CONFIDENCE_THRESHOLD,
  confidencePercent,
  departmentLabel,
  formatPhone,
  issueLabel,
  PRIORITY_LABEL,
  reportersPhrase,
  STATUS_LABEL,
} from "@/lib/labels";
import { formatDateTime } from "@/lib/time";
import { isSealed, type Case } from "@/lib/types";
import type { CaseGeo } from "@/lib/geo";
import { Icon } from "./icons";
import { Absent, Card, Field, Pill, PRIORITY_TONE, STATUS_TONE } from "./ui";
import { reportForCall, type CaseFacts } from "./derive";

const PRECISION_LABEL: Record<CaseGeo["precision"], string> = {
  exact: "Exact",
  approximate: "Approximate",
  unresolved: "Unresolved",
};

export function DetailsTab({
  item,
  facts,
  duration,
  changed,
  onViewReport,
}: {
  item: Case;
  facts: CaseFacts;
  duration: string | null;
  changed: ReadonlySet<string>;
  /** Jump to one resident's account on the Reports tab. */
  onViewReport: (reportId: number) => void;
}) {
  const { geo, call } = facts;
  const confidence = confidencePercent(item.issue_type_confidence);
  const callReport = reportForCall(facts.reporters, call);

  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <Card title="Case">
        <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          <Field icon="hash" label="Case number">
            <span className="font-mono">{item.case_number}</span>
          </Field>
          <Field icon="refresh" label="Status" flashing={changed.has("status")}>
            <Pill tone={STATUS_TONE[item.status] ?? "slate"}>{STATUS_LABEL[item.status] ?? item.status}</Pill>
          </Field>
          <Field icon="tag" label="Issue type" flashing={changed.has("issue_type")}>
            <span className="flex flex-wrap items-center gap-2">
              {item.issue_type ? issueLabel(item.issue_type) : <Absent>Being classified</Absent>}
              {confidence ? (
                <span className="text-[12px] text-slate-400 tabular-nums">
                  {confidence} confident
                  {item.issue_type === null
                    ? `, needs ${Math.round(CONFIDENCE_THRESHOLD * 100)}% to commit`
                    : null}
                </span>
              ) : null}
            </span>
          </Field>
          <Field icon="building" label="Department" flashing={changed.has("department")}>
            {departmentLabel(item.department)}
          </Field>
          <Field icon="flag" label="Priority" flashing={changed.has("priority")}>
            <span className="flex items-center gap-2">
              <Pill tone={PRIORITY_TONE[item.priority] ?? "slate"}>
                {PRIORITY_LABEL[item.priority] ?? item.priority}
              </Pill>
              <span className="text-[12px] text-slate-400 tabular-nums">score {item.priority_score ?? 0}</span>
            </span>
          </Field>
          <Field icon="users" label="Residents reporting" flashing={changed.has("report_count")}>
            {reportersPhrase(facts.reporterCount)}
          </Field>
          <Field icon="calendar" label="Created">
            {formatDateTime(item.created_at)}
          </Field>
          <Field icon="clock" label="Last updated" flashing={changed.has("updated_at")}>
            {formatDateTime(item.updated_at)}
          </Field>
        </div>

        {item.escalated ? (
          <div className={`mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 ${changed.has("escalated") ? "flash" : ""}`}>
            <p className="text-[12px] font-semibold text-red-700">Escalated</p>
            <p className="mt-0.5 text-[12.5px] leading-5 text-red-700/90">
              {item.escalation_reason || "No reason recorded."}
            </p>
          </div>
        ) : null}

        <div className="mt-4 grid gap-4 border-t border-hairline-soft pt-4">
          <Field icon="note" label="Description" flashing={changed.has("description")}>
            {facts.description ?? <Absent>No description captured yet</Absent>}
          </Field>
          <Field icon="note" label="Summary" flashing={changed.has("summary")}>
            {item.summary ?? <Absent>No summary written yet</Absent>}
          </Field>
        </div>
      </Card>

      <div className="flex flex-col gap-6">
        <Card title="Location">
          <div className="grid gap-4">
            <Field icon="mic" label="Caller's words" flashing={changed.has("location_text") || changed.has("location")}>
              {geo.spoken ?? <Absent>No location captured yet</Absent>}
            </Field>
            <Field icon="pin" label="Normalized address" flashing={changed.has("location_formatted")}>
              {geo.formatted ?? <Absent>Not resolved</Absent>}
            </Field>
            <Field icon="crosshair" label="On-site detail" flashing={changed.has("location_detail")}>
              {geo.detail ?? <Absent>None given</Absent>}
            </Field>
            <Field
              icon="map"
              label="Precision"
              flashing={changed.has("location_precision") || changed.has("latitude") || changed.has("longitude")}
            >
              <span className="flex flex-wrap items-center gap-2">
                <Pill tone={geo.precision === "exact" ? "green" : geo.precision === "approximate" ? "amber" : "slate"}>
                  {PRECISION_LABEL[geo.precision]}
                </Pill>
                {geo.hasPoint ? (
                  <span className="font-mono text-[12px] text-slate-500 tabular-nums">
                    {(geo.latitude as number).toFixed(5)}, {(geo.longitude as number).toFixed(5)}
                  </span>
                ) : (
                  <span className="text-[12px] text-slate-400">
                    {geo.pending ? "Geocoding has not answered yet" : "No coordinates"}
                  </span>
                )}
              </span>
            </Field>
          </div>
        </Card>

        <Card
          title="Call"
          action={
            call ? (
              <Link
                href={`/calls/${call.id}`}
                className="text-[12px] font-medium text-blue-600 transition-colors hover:text-blue-700"
              >
                Open call record
              </Link>
            ) : null
          }
        >
          {call ? (
            <>
              <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
                <Field icon="mic" label="Room">
                  <span className="font-mono">{call.room}</span>
                </Field>
                <Field icon="refresh" label="Phase">
                  <Pill tone={call.status === "active" ? "green" : "slate"}>{call.phase}</Pill>
                </Field>
                <Field icon="phone" label="Caller number">
                  {call.caller_phone ? formatPhone(call.caller_phone) : <Absent>Withheld</Absent>}
                </Field>
                <Field icon="clock" label="Duration">
                  {duration ? <span className="tabular-nums">{duration}</span> : <Absent>Unknown</Absent>}
                </Field>
                <Field icon="calendar" label="Started">
                  {formatDateTime(call.started_at)}
                </Field>
                <Field icon="calendar" label="Ended">
                  {call.ended_at ? formatDateTime(call.ended_at) : <Absent>Still on the line</Absent>}
                </Field>
                {/* Call -> Report -> Case. The report is the account the call
                    produced; a call that produced none is a real outcome and
                    says so rather than showing a dead link. */}
                <Field icon="users" label="Report">
                  {callReport ? (
                    <button
                      type="button"
                      onClick={() => onViewReport(callReport.id)}
                      className="text-left font-medium text-blue-600 transition-colors hover:text-blue-700"
                    >
                      {callReport.reporter_name?.trim() || "Anonymous resident"}
                    </button>
                  ) : call.produced_report ? (
                    <Absent>Filed, but not on this case</Absent>
                  ) : (
                    <Absent>This call produced no report</Absent>
                  )}
                </Field>
              </div>

              {/* A completed call is the record of a conversation that
                  happened; the backend answers 409 to anything that would
                  rewrite it. Say so, and say where a correction does go. */}
              {isSealed(call) ? (
                <p className="mt-4 flex gap-2.5 border-t border-hairline-soft pt-4 text-[12.5px] leading-5 text-slate-500">
                  <Icon name="lock" className="mt-[3px] h-4 w-4 shrink-0 text-slate-400" />
                  <span>
                    This call has ended and its record is sealed. A correction goes on the caller&rsquo;s report.
                  </span>
                </p>
              ) : null}
            </>
          ) : (
            <p className="py-2 text-[13px] text-slate-400">No call is linked to this case.</p>
          )}
        </Card>
      </div>
    </div>
  );
}
