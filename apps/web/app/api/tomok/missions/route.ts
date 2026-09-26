import { after } from "next/server";
import { createMission, listMissions } from "@/lib/tomok/missions/service";
import { reconcileMission } from "@/lib/tomok/missions/worker";
import { jsonResult, projectError, readProjectJson, requestPrincipal, requireSameOrigin } from "@/lib/tomok/http";

export async function GET() {
  try { return jsonResult(await listMissions(await requestPrincipal())); }
  catch (error) { return projectError(error); }
}
export async function POST(request: Request) {
  try {
    const principal = await requestPrincipal(); requireSameOrigin(request);
    const result = await createMission(await readProjectJson(request), principal);
    // Dispatch intent is persisted first. The worker/schedule can reconcile if this request exits early.
    after(async () => { await reconcileMission(result.mission.id).catch(() => {}); });
    return jsonResult(result);
  } catch (error) { return projectError(error); }
}
