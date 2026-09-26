import { requireProjectAccess } from "../project-files/access";
import { SourceError } from "../project-files/catalog";
import { projectAuthMode, type ProjectPrincipal } from "./auth";
import { TomokError } from "./errors";
export { requireSameOrigin } from "./origin";

export async function requestPrincipal(): Promise<ProjectPrincipal> {
  const viewer = await requireProjectAccess();
  const mode = projectAuthMode();
  return {
    principalId: viewer.id,
    attributes: { name: viewer.name },
    principalType: mode === "local-dev" ? "local-dev" : "user",
    authenticator: mode === "vercel" ? "better-auth" : mode === "password" ? "password" : "local-dev",
    issuer: mode === "vercel" ? "better-auth" : "eve-chat-template",
  };
}

export function jsonResult(result: unknown) {
  return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
}

export function projectError(error: unknown) {
  const known = error instanceof TomokError || error instanceof SourceError;
  return Response.json({ error: known ? error.message : "Unable to complete this project request." }, {
    status: known ? error.status : 500, headers: { "Cache-Control": "private, no-store" },
  });
}

export async function readProjectJson(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new TomokError("Enter a valid JSON request.", 400);
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 20_000) {
        await reader.cancel();
        throw new TomokError("This request is too large.", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new TomokError("Enter a valid JSON request.", 400); }
}
