import { defineDynamic, defineTool } from "eve/tools";
import { missionWorkAvailable, missionToolResult } from "../lib/mission-tools";
import { completeMission } from "../../apps/web/lib/tomok/missions/service";
import { completeMissionSchema } from "../../apps/web/lib/tomok/missions/types";

export const missionTool = defineTool({
  description: "Propose the mission report after all scoped source jobs have an outcome. Cite committed fact IDs for every connection and draft lesson. Exact identifiers may establish a documented link; mappings, temporal comparisons and conflicts stay proposed. The service validates references and coverage and determines completion or completion with disclosed gaps. Never use this to mark paused, unread or over-budget work complete.",
  inputSchema: completeMissionSchema,
  async execute(input, ctx) { return missionToolResult(() => completeMission(input, ctx.session)); },
});

export default defineDynamic({ events: { "step.started": async (_event, ctx) =>
  await missionWorkAvailable(ctx.session) ? missionTool : null } });
