import { listCaseReplays, startCaseReplay } from "@/lib/tomok/replay-service";
import { jsonResult, projectError, readProjectJson, requestPrincipal, requireSameOrigin } from "@/lib/tomok/http";

export async function GET() {
  try { return jsonResult(await listCaseReplays(await requestPrincipal())); }
  catch (error) { return projectError(error); }
}

export async function POST(request: Request) {
  try {
    const principal = await requestPrincipal();
    requireSameOrigin(request);
    return jsonResult(await startCaseReplay(await readProjectJson(request), principal));
  } catch (error) { return projectError(error); }
}
