import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { proposeMissionPolicy } from "../../apps/web/lib/tomok/missions/service";
import { missionWorkAvailable, missionToolResult } from "../lib/mission-tools";

export const missionTool = defineTool({
  description: "Propose a bounded workbook-context policy that omits empty cells while preserving source values, formulas, date markers and exact citations. State the actual observed inefficiency. This only creates a candidate; it does not claim an improvement or promote it. Use evaluate_archive_policy to run the independent deterministic gate.",
  inputSchema: z.strictObject({ reason: z.string().trim().min(10).max(600), omitEmptyCells: z.literal(true) }),
  async execute(input, ctx) { return missionToolResult(() => proposeMissionPolicy(input, ctx.session)); },
});
export default defineDynamic({ events: { "step.started": async (_event, ctx) =>
  await missionWorkAvailable(ctx.session) ? missionTool : null } });
