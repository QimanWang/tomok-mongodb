import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { isBoundedProjectSession, requireLiveProjectSession } from "../lib/session-scope";
import { getScheduleContext } from "../../apps/web/lib/tomok/service";

export const liveTool = defineTool({
  description:
    "Retrieve one imported P6 activity by its exact activity code, with its schedule snapshot dates, relationships, and source links. Optionally inspect an imported dependency path to MS-260 or MS-280 when the user selects that target; neither is an accepted default. This is schedule context, not a verified driving path, newly calculated critical path, or approved baseline determination.",
  inputSchema: z.strictObject({
    activityCode: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .describe("Exact P6 activity code, such as 2A-SP01-GRND-710C-XP."),
    targetMilestoneCode: z.enum(["MS-260", "MS-280"]).optional().describe("Optional target explicitly selected for inspection. Does not establish milestone acceptance or governing logic."),
  }),
  async execute(input, ctx) {
    await requireLiveProjectSession(ctx.session);
    return getScheduleContext(input, ctx.session.auth.current);
  },
});

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      if (await isBoundedProjectSession(ctx.session)) return null;
      return liveTool;
    },
  },
});
