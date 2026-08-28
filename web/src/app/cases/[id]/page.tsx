import { notFound } from "next/navigation";
import { CaseDetail } from "@/components/CaseDetail";

export default async function CaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caseId = Number(id);
  if (!Number.isInteger(caseId) || caseId <= 0) notFound();

  return <CaseDetail caseId={caseId} />;
}
