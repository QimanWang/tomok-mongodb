import { Suspense } from "react";
import { MissionWorkspace } from "@/components/tomok/mission-workspace";

export const metadata = { title: "Archive missions · Tomok" };

export default function MissionsPage() {
  return <Suspense fallback={<div className="p-16 text-sm text-muted-foreground" role="status">Opening archive missions…</div>}><MissionWorkspace /></Suspense>;
}
