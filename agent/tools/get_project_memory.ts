import { defineTool } from "eve/tools";
import { z } from "zod";
import { getProjectMemory } from "../../apps/web/lib/tomok/memory-service";

export default defineTool({
  description:
    "Retrieve currently reviewed project knowledge applicable to a reporting date and exact activity. Use before project answers, including in a fresh chat. Returns applicable reviewed knowledge and exclusion counts, not draft or superseded statements. Review may have occurred after the reporting date; this is not a reconstruction of what was known then.",
  inputSchema: z.strictObject({
    cutoff: z.iso
      .date()
      .describe("Reporting cutoff as a real calendar date in YYYY-MM-DD form."),
    activityCode: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe("Optional exact P6 activity code from the user or retrieved evidence."),
  }),
  async execute(input, ctx) {
    return getProjectMemory(input, ctx.session.auth.current);
  },
});
