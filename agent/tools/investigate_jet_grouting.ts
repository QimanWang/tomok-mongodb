import { defineTool } from "eve/tools";
import { z } from "zod";
import { investigateJetGrouting } from "../../apps/web/lib/tomok/service";

export default defineTool({
  description:
    "Investigate South Portal jet-grouting progress as of a reporting cutoff using imported P6, field-plan, and daily-report evidence. Return deterministic findings, source links, applicability warnings, and a saved investigation URL. Does not calculate a new project finish or establish a delay cause.",
  inputSchema: z.strictObject({
    cutoff: z.iso
      .date()
      .describe("Reporting cutoff as a real calendar date in YYYY-MM-DD form."),
    question: z
      .string()
      .trim()
      .min(1)
      .max(2_000)
      .describe("The user's South Portal jet-grouting investigation question."),
  }),
  async execute(input, ctx) {
    return investigateJetGrouting(input, ctx.session.auth.current);
  },
});
