"use client";

/**
 * Every field the case holds, including the ones the Overview leaves out.
 *
 * This tab is the "show me everything" view: raw geocoding output, the
 * classifier's confidence, the routing decision, and each report on file.
 */

import {
  CONFIDENCE_THRESHOLD,
  confidencePercent,
  departmentLabel,
  formatPhone,
  issueLabel,
  PRIORITY_LABEL,
  STATUS_LABEL,
} from "@/lib/labels";
import { formatDateTime } from "@/lib/time";
import type { Case, Report } from "@/lib/types";
import type { CaseGeo } from "@/lib/geo";
import { Absent, Card, Field, Pill, PRIORITY_TONE, STATUS_TONE } from "./ui";
import type { CaseFacts } from "./derive";

const PRECISION_LABEL: Record<CaseGeo["precision"], string> = {
  exact: "Exact",
  approximate: "Approximate",
  unresolved: "Unresolved",
};

export function DetailsTab({
  item,
  facts,
  reports,
  duration,
  changed,
}: {
  item: Case;
  facts: CaseFacts;
  reports: Report[] | null;
  duration: string | null;
  changed: ReadonlySet<string>;
}) {
  const { geo, call } = facts;
  const confidence = confidencePercent(item.issue_type_confidence);

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
          <Field icon="user" label="Reports on file" flashing={changed.has("report_count")}>
            <span className="tabular-nums">{item.report_count ?? 0}</span>
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

        <Card title="Call">
          {call ? (
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
            </div>
          ) : (
            <p className="py-2 text-[13px] text-slate-400">No call is linked to this case.</p>
          )}
        </Card>

        <Card title="Reports">
          {reports === null ? (
            <p className="py-2 text-[13px] text-slate-400">Loading reports.</p>
          ) : reports.length === 0 ? (
            <p className="py-2 text-[13px] text-slate-400">No reports are on file for this case.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {reports.map((report) => (
                <li key={report.id} className="rounded-xl border border-slate-200 px-3 py-2.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="min-w-0 truncate text-[13px] font-medium text-slate-900">
                      {report.reporter_name || <Absent>Anonymous resident</Absent>}
                    </p>
                    <span className="shrink-0 text-[11.5px] whitespace-nowrap text-slate-400">
                      {formatDateTime(report.created_at)}
                    </span>
                  </div>
                  <p className="mt-0.5 font-mono text-[12px] text-slate-500">
                    {report.reporter_phone ? formatPhone(report.reporter_phone) : "No callback number"}
                  </p>
                  {report.description ? (
                    <p className="mt-1.5 text-[12.5px] leading-5 text-slate-600">{report.description}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
