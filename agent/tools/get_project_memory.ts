import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { isBoundedProjectSession, requireLiveProjectSession } from "../lib/session-scope";
import { getProjectMemory } from "../../apps/web/lib/tomok/memory-service";

export const liveTool = defineTool({
  description:
    "Retrieve currently reviewed project knowledge applicable to a reporting date and exact activity. Use before project answers, including in a fresh chat. Returns applicable reviewed knowledge and exclusion counts, not draft or superseded statements. Review may have occurred after the reporting date; this is not a reconstruction of what was known then.",
  inputSchema: z.strictObject({
    query: z.string().trim().min(1).max(200).optional()
      .describe("Optional plain-language semantic ranking within currently eligible reviewed notes. Omit to read all eligible notes."),
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
    await requireLiveProjectSession(ctx.session);
    return getProjectMemory(input, ctx.session.auth.current);
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
