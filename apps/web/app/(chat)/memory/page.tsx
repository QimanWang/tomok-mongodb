import { Suspense } from "react";
import { MemoryWorkspace } from "@/components/tomok/memory-workspace";

export const metadata = { title: "Project memory · Tomok" };

export default function MemoryPage() {
  return (
    <Suspense
      fallback={
        <div className="p-16 text-sm text-muted-foreground">
          Opening project memory…
        </div>
      }
    >
      <MemoryWorkspace />
    </Suspense>
  );
}
