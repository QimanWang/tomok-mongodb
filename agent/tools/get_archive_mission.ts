import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { getMissionContext } from "../../apps/web/lib/tomok/missions/service";
import { missionWorkAvailable, missionToolResult } from "../lib/mission-tools";

export const missionTool = defineTool({
  description: "Load this session's authorized archive mission, source-range coverage, committed facts, remaining budget and eligible jobs. The mission, owner, source release and reporting cutoff are bound by the server; this tool takes no arguments. Use its committed records to recover after compaction or restart.",
  inputSchema: z.strictObject({}),
  async execute(input, ctx) { return missionToolResult(() => getMissionContext(input, ctx.session)); },
});

export default defineDynamic({ events: { "step.started": async (_event, ctx) =>
  await missionWorkAvailable(ctx.session) ? missionTool : null } });
