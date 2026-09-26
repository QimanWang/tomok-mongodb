import { getProjectStatus } from "@/lib/tomok/service";
import { jsonResult, projectError, requestPrincipal } from "@/lib/tomok/http";

export async function GET() {
  try { return jsonResult(await getProjectStatus(await requestPrincipal())); }
  catch (error) { return projectError(error); }
}
