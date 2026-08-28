"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment } from "react";
import {
  DepartmentTag,
  EscalationBanner,
  IssueTag,
  PriorityTag,
  ReportCountPill,
  ScorePill,
  StatusBadge,
} from "@/components/Badge";
import { Skeleton } from "@/components/ui";
import { caseLocation, isEscalated, reportCount, type Case } from "@/lib/types";
import { formatDateTime, relativeTime } from "@/lib/time";

const HEAD_CLASS = "px-4 py-2.5 text-[11px] font-medium tracking-wide text-faint uppercase";
const COLUMN_COUNT = 7;

export function CaseTable({
  cases,
  flashClass,
  countFlashClass,
  now,
}: {
  cases: Case[];
  flashClass: (id: number) => string;
  countFlashClass: (id: number) => boolean;
  now: number;
}) {
  const router = useRouter();

  return (
    <table className="w-full table-fixed border-collapse text-left">
      <thead>
        <tr className="border-b border-line">
          <th className={`${HEAD_CLASS} w-[38%] sm:w-[26%]`}>Case</th>
          <th className={`${HEAD_CLASS} hidden w-[20%] lg:table-cell`}>Location</th>
          <th className={`${HEAD_CLASS} hidden w-[14%] md:table-cell`}>Issue</th>
          <th className={`${HEAD_CLASS} w-[26%] sm:w-[13%]`}>Reports</th>
          <th className={`${HEAD_CLASS} w-[36%] sm:w-[14%]`}>Status</th>
          <th className={`${HEAD_CLASS} hidden w-[12%] sm:table-cell`}>Priority</th>
          <th className={`${HEAD_CLASS} hidden w-[11%] text-right sm:table-cell`}>Updated</th>
        </tr>
      </thead>
      <tbody>
        {cases.map((item) => {
          const escalated = isEscalated(item);
          const open = () => router.push(`/cases/${item.id}`);
          return (
            <Fragment key={item.id}>
              <tr
                onClick={open}
                className={`cursor-pointer transition-colors hover:bg-raised/70 ${
                  escalated ? "bg-red-500/5" : ""
                } ${escalated ? "" : "border-b border-line/70"} ${flashClass(item.id)}`}
              >
                <td className="px-4 py-2.5 align-middle">
                  <Link
                    href={`/cases/${item.id}`}
                    onClick={(event) => event.stopPropagation()}
                    className="block truncate font-mono text-[13px] text-ink hover:text-accent"
                  >
                    {item.case_number}
                  </Link>
                  <p className="mt-0.5 truncate text-[12px] text-faint">
                    {item.description || "No description captured"}
                  </p>
                </td>

                <td className="hidden px-4 py-2.5 align-middle lg:table-cell">
                  <p className="truncate text-[13px] text-ink">{caseLocation(item) || "Location unknown"}</p>
                  <div className="mt-1 flex">
                    <DepartmentTag department={item.department} />
                  </div>
                </td>

                <td className="hidden px-4 py-2.5 align-middle md:table-cell">
                  <IssueTag issue={item.issue_type} />
                </td>

                <td className="px-4 py-2.5 align-middle">
                  <ReportCountPill count={reportCount(item)} flashing={countFlashClass(item.id)} />
                </td>

                <td className="px-4 py-2.5 align-middle">
                  <StatusBadge status={item.status} />
                </td>

                <td className="hidden px-4 py-2.5 align-middle sm:table-cell">
                  <div className="flex items-center gap-1.5">
                    <PriorityTag priority={item.priority} />
                    <ScorePill score={item.priority_score} />
                  </div>
                </td>

                <td
                  className="hidden px-4 py-2.5 text-right align-middle text-[12px] whitespace-nowrap text-muted sm:table-cell"
                  title={formatDateTime(item.updated_at)}
                >
                  {relativeTime(item.updated_at, now)}
                </td>
              </tr>

              {escalated ? (
                <tr onClick={open} className={`cursor-pointer border-b border-line/70 bg-red-500/5 ${flashClass(item.id)}`}>
                  <td colSpan={COLUMN_COUNT} className="px-4 pt-0 pb-2.5">
                    <EscalationBanner reason={item.escalation_reason} compact />
                  </td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

export function CaseTableSkeleton() {
  return (
    <div className="divide-y divide-line/70">
      {Array.from({ length: 6 }).map((_, index) => (
        <div key={index} className="flex items-center gap-4 px-4 py-3.5">
          <div className="w-[26%] space-y-1.5">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-3 w-full max-w-40" />
          </div>
          <div className="hidden w-[20%] space-y-1.5 lg:block">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3 w-20" />
          </div>
          <Skeleton className="hidden h-4 w-20 md:block" />
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="ml-auto h-5 w-24 rounded-full" />
          <Skeleton className="hidden h-3.5 w-14 sm:block" />
        </div>
      ))}
    </div>
  );
}
