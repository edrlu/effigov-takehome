import { notFound } from "next/navigation";
import { CallDetail } from "@/components/CallDetail";

export default async function CallPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const callId = Number(id);
  if (!Number.isInteger(callId) || callId <= 0) notFound();

  return <CallDetail callId={callId} />;
}
