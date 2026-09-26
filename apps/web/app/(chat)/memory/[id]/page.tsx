import { Suspense } from "react";
import { MemoryDetail } from "@/components/tomok/memory-detail";

export const metadata = { title: "Project note · Tomok" };

export default function MemoryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <Suspense
      fallback={
        <div className="p-16 text-sm text-muted-foreground">
          Opening project note…
        </div>
      }
    >
      <ResolvedMemory params={params} />
    </Suspense>
  );
}

async function ResolvedMemory({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <MemoryDetail id={id} />;
}
