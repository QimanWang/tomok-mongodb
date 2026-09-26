import { defineDynamic, defineTool } from "eve/tools";
import { missionWorkAvailable, missionToolResult } from "../lib/mission-tools";
import { claimMissionJob } from "../../apps/web/lib/tomok/missions/service";
import { claimMissionJobSchema } from "../../apps/web/lib/tomok/missions/types";

export const missionTool = defineTool({
  description: "Choose and claim one eligible source-unit job from get_archive_mission. Explain why this source range is useful for the mission or an unresolved discrepancy. Only one lease may be active; the service enforces serial work, retries, generation and budget. Reuse its returned leaseToken for reading and committing.",
  inputSchema: claimMissionJobSchema,
  async execute(input, ctx) { return missionToolResult(() => claimMissionJob(input, ctx.session)); },
});

export default defineDynamic({ events: { "step.started": async (_event, ctx) =>
  await missionWorkAvailable(ctx.session) ? missionTool : null } });
