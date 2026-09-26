import { Suspense } from "react";
import { InvestigationWorkspace } from "@/components/tomok/investigation-workspace";

export const metadata = { title: "Investigate · Tomok" };

export default function InvestigationsPage() {
  return (
    <Suspense
      fallback={
        <div className="p-16 text-sm text-muted-foreground">
          Opening investigation…
        </div>
      }
    >
      <InvestigationWorkspace />
    </Suspense>
  );
}
