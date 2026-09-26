import { Suspense } from "react";
import { SavedMission } from "@/components/tomok/mission-workspace";

export const metadata = { title: "Saved archive mission · Tomok" };

export default function MissionPage({ params }: { params: Promise<{ id: string }> }) {
  return <Suspense fallback={<div className="p-16 text-sm text-muted-foreground" role="status">Opening saved mission…</div>}><ResolvedMission params={params} /></Suspense>;
}

async function ResolvedMission({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SavedMission id={id} />;
}
