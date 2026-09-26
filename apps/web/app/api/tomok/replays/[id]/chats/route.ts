import { Client } from "eve/client";
import { listReplayChats, startReplayChat } from "@/lib/tomok/replay-chat-service";
import { jsonResult, projectError, readProjectJson, requestPrincipal, requireSameOrigin } from "@/lib/tomok/http";
import { TomokError } from "@/lib/tomok/errors";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requestPrincipal();
    return jsonResult(await listReplayChats((await params).id, principal));
  } catch (error) { return projectError(error); }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requestPrincipal();
    requireSameOrigin(request);
    const { id } = await params;
    return jsonResult(await startReplayChat(id, await readProjectJson(request), principal, async () => {
      // Use deployment configuration, never a browser-supplied host, for this credential-bearing request.
      const host = process.env.VERCEL_URL?.trim();
      if (!host || !/^[A-Za-z0-9.[\]:-]+$/.test(host)) throw new TomokError("Start the linked web and chat services with vercel dev before opening a replay conversation.");
      const local = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host);
      const client = new Client({ host: `${local ? "http" : "https"}://${host}`, redirect: "error",
        headers: { cookie: request.headers.get("cookie") ?? "" } });
      // No message: the idle session is bound in MongoDB before it can initialize or read evidence.
      try {
        const { session } = await client.sessions.create({ signal: AbortSignal.timeout(20_000) });
        return session.state.sessionId;
      } catch {
        throw new TomokError("The chat service is unavailable. Check that the linked web and eve services are running, then try again.");
      }
    }));
  } catch (error) { return projectError(error); }
}
