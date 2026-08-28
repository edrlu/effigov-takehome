import { notFound } from "next/navigation";
import { CasePage } from "@/components/case/CasePage";

/**
 * `?report=<id>` opens the case on that resident's account and marks it - the
 * link a call record follows to reach the report it produced. Read here rather
 * than with `useSearchParams` so the client component needs no Suspense
 * boundary around it.
 */
export default async function CaseDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ report?: string }>;
}) {
  const { id } = await params;
  const caseId = Number(id);
  if (!Number.isInteger(caseId) || caseId <= 0) notFound();

  const { report } = await searchParams;
  const focus = Number(report);

  return <CasePage caseId={caseId} focusReport={Number.isInteger(focus) && focus > 0 ? focus : null} />;
}
