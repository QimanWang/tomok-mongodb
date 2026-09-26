import { listProjectMemory, proposeProjectMemory } from "@/lib/tomok/memory-service";
import { jsonResult, projectError, requestPrincipal, requireSameOrigin, readProjectJson } from "@/lib/tomok/http";
export async function GET() {
  try { return jsonResult(await listProjectMemory(await requestPrincipal())); }
  catch (error) { return projectError(error); }
}
export async function POST(request: Request) {
  try {
    const principal = await requestPrincipal();
    requireSameOrigin(request);
    return jsonResult(await proposeProjectMemory(await readProjectJson(request), principal));
  } catch (error) { return projectError(error); }
}
