import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { evaluateMissionPolicy } from "../../apps/web/lib/tomok/missions/service";
import { missionWorkAvailable, missionToolResult } from "../lib/mission-tools";

export const missionTool = defineTool({
  description: "Evaluate an existing workbook-policy candidate on the service's fixed records and predeclared source-preservation gate. The service computes every score, rejects any required-fact loss, and promotes only measured byte-efficiency improvements. A promoted policy schedules source reprocessing and preserves earlier provenance. Byte savings are not measured token savings or model accuracy.",
  inputSchema: z.strictObject({ candidateId: z.string().min(1).max(100) }),
  async execute(input, ctx) { return missionToolResult(() => evaluateMissionPolicy(input, ctx.session)); },
});
export default defineDynamic({ events: { "step.started": async (_event, ctx) =>
  await missionWorkAvailable(ctx.session) ? missionTool : null } });
