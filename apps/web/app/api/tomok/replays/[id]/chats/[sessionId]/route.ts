import { getReplayChat } from "@/lib/tomok/replay-chat-service";
import { jsonResult, projectError, requestPrincipal } from "@/lib/tomok/http";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; sessionId: string }> }) {
  try {
    const principal = await requestPrincipal();
    const { id, sessionId } = await params;
    return jsonResult(await getReplayChat(id, sessionId, principal));
  } catch (error) { return projectError(error); }
}
