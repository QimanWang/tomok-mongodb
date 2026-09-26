import { defineDynamic, defineTool } from "eve/tools";
import { missionWorkAvailable, missionToolResult } from "../lib/mission-tools";
import { commitMissionJob } from "../../apps/web/lib/tomok/missions/service";
import { commitMissionJobSchema } from "../../apps/web/lib/tomok/missions/types";

export const missionTool = defineTool({
  description: "Propose bounded facts from a previously read source unit and commit only validated exact source claims. The service checks each value, unit/date semantics and citation against the pinned source range, then publishes immutable output only for the current lease. Copy exact unitId, locator and quote from the reader. No human-reviewed knowledge is created. A rejected fact must be corrected from the source; do not repeatedly submit equivalent unsupported claims.",
  inputSchema: commitMissionJobSchema,
  async execute(input, ctx) { return missionToolResult(() => commitMissionJob(input, ctx.session)); },
});

export default defineDynamic({ events: { "step.started": async (_event, ctx) =>
  await missionWorkAvailable(ctx.session) ? missionTool : null } });
