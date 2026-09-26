import { defineTool } from "eve/tools";
import { z } from "zod";
import { getScheduleContext } from "../../apps/web/lib/tomok/service";

export default defineTool({
  description:
    "Retrieve one imported P6 activity by its exact activity code, with its schedule snapshot dates, relationships, and source links. This is imported schedule context, not a newly calculated critical path or an approved baseline determination.",
  inputSchema: z.strictObject({
    activityCode: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .describe("Exact P6 activity code, such as 2A-SP01-GRND-710C-XP."),
  }),
  async execute(input, ctx) {
    return getScheduleContext(input, ctx.session.auth.current);
  },
});
