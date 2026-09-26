import { getMemoryContext } from "@/lib/tomok/memory-service";
import { jsonResult, projectError, requestPrincipal } from "@/lib/tomok/http";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { return jsonResult(await getMemoryContext((await params).id, await requestPrincipal())); }
  catch (error) { return projectError(error); }
}
