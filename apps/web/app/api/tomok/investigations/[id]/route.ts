import { getInvestigation } from "@/lib/tomok/service";
import { jsonResult, projectError, requestPrincipal } from "@/lib/tomok/http";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { return jsonResult(await getInvestigation((await params).id, await requestPrincipal())); }
  catch (error) { return projectError(error); }
}
