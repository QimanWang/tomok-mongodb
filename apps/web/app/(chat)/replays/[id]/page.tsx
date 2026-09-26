import { Suspense } from "react";
import { SavedReplay } from "@/components/tomok/replay-workspace";

export const metadata = { title: "Saved case replay · Tomok" };

export default function ReplayPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <Suspense
      fallback={
        <div className="p-16 text-sm text-muted-foreground" role="status">
          Opening saved replay…
        </div>
      }
    >
      <ResolvedReplay params={params} />
    </Suspense>
  );
}

async function ResolvedReplay({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SavedReplay id={id} />;
}
