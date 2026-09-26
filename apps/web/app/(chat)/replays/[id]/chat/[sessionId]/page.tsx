import { Suspense } from "react";
import { ReplayChatWorkspace } from "@/components/tomok/replay-chat-workspace";

export const metadata = { title: "Replay chat · Tomok" };

export default function ReplayChatPage({ params }: { params: Promise<{ id: string; sessionId: string }> }) {
  return (
    <Suspense fallback={<div className="p-16 text-sm text-muted-foreground" role="status">Opening replay chat…</div>}>
      <ResolvedReplayChat params={params} />
    </Suspense>
  );
}

async function ResolvedReplayChat({ params }: { params: Promise<{ id: string; sessionId: string }> }) {
  const { id, sessionId } = await params;
  return <ReplayChatWorkspace key={`${id}:${sessionId}`} replayId={id} sessionId={sessionId} />;
}
