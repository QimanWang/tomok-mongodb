import { Suspense } from "react";
import { SavedInvestigation } from "@/components/tomok/investigation-workspace";

export const metadata = { title: "Saved investigation · Tomok" };

export default function InvestigationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <Suspense
      fallback={
        <div className="p-16 text-sm text-muted-foreground">
          Opening saved investigation…
        </div>
      }
    >
      <ResolvedInvestigation params={params} />
    </Suspense>
  );
}

async function ResolvedInvestigation({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <SavedInvestigation id={id} />;
}
