import { after } from "next/server";
import { missionAction } from "@/lib/tomok/missions/service";
import { reconcileMission } from "@/lib/tomok/missions/worker";
import { jsonResult, projectError, readProjectJson, requestPrincipal, requireSameOrigin } from "@/lib/tomok/http";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requestPrincipal(); requireSameOrigin(request);
    const id = (await params).id;
    const result = await missionAction(id, await readProjectJson(request), principal);
    if (result.mission.status === "queued") after(async () => { await reconcileMission(id).catch(() => {}); });
    return jsonResult(result);
  } catch (error) { return projectError(error); }
}
