import { Suspense } from "react";
import { ReplayWorkspace } from "@/components/tomok/replay-workspace";

export const metadata = { title: "Case replay · Tomok" };

export default function ReplaysPage() {
  return (
    <Suspense
      fallback={
        <div className="p-16 text-sm text-muted-foreground" role="status">
          Opening case replay…
        </div>
      }
    >
      <ReplayWorkspace />
    </Suspense>
  );
}
