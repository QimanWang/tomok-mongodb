import { investigateJetGrouting } from "@/lib/tomok/service";
import { jsonResult, projectError, requestPrincipal, requireSameOrigin } from "@/lib/tomok/http";
import { TomokError } from "@/lib/tomok/errors";

export async function POST(request: Request) {
  try {
    const principal = await requestPrincipal();
    requireSameOrigin(request);
    const text = await request.text();
    if (text.length > 10_000) throw new TomokError("This request is too large.", 413);
    let input;
    try { input = JSON.parse(text); } catch { throw new TomokError("Enter a valid JSON request.", 400); }
    return jsonResult(await investigateJetGrouting(input, principal));
  } catch (error) { return projectError(error); }
}
