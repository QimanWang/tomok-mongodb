import { reviseProjectMemory } from "@/lib/tomok/memory-service";
import { jsonResult, projectError, requestPrincipal, requireSameOrigin, readProjectJson } from "@/lib/tomok/http";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requestPrincipal();
    requireSameOrigin(request);
    return jsonResult(await reviseProjectMemory((await params).id, await readProjectJson(request), principal));
  } catch (error) { return projectError(error); }
}
