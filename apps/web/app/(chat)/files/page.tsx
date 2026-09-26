import { Suspense } from "react";
import { FilesWorkspace } from "@/components/project-files/workspace";
export const metadata = { title: "Project files · Tomok" };
export default function FilesPage() {
  return (
    <Suspense
      fallback={
        <div className="p-16 text-sm text-muted-foreground">
          Opening project files…
        </div>
      }
    >
      <FilesWorkspace />
    </Suspense>
  );
}
