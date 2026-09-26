import { advanceCaseReplay } from "@/lib/tomok/replay-service";
import { jsonResult, projectError, readProjectJson, requestPrincipal, requireSameOrigin } from "@/lib/tomok/http";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requestPrincipal();
    requireSameOrigin(request);
    return jsonResult(await advanceCaseReplay((await context.params).id, await readProjectJson(request), principal));
  } catch (error) { return projectError(error); }
}
