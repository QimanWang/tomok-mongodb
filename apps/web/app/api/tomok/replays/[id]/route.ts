import { getCaseReplay } from "@/lib/tomok/replay-service";
import { jsonResult, projectError, requestPrincipal } from "@/lib/tomok/http";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requestPrincipal();
    return jsonResult(await getCaseReplay((await context.params).id, principal));
  } catch (error) { return projectError(error); }
}
