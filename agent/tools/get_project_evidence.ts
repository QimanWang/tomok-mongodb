import { defineTool } from "eve/tools";
import { z } from "zod";
import { getProjectEvidence } from "../../apps/web/lib/tomok/service";

export default defineTool({
  description:
    "Retrieve bounded, source-linked project evidence available as of a reporting cutoff. Initial coverage is selected South Portal jet-grouting field records. Preserve applicability warnings, including undated plans and unreviewed mappings; absence of a record does not prove work did not occur.",
  inputSchema: z.strictObject({
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("Optional plain-language evidence search; not a database query."),
    cutoff: z.iso
      .date()
      .describe("Reporting cutoff as a real calendar date in YYYY-MM-DD form."),
  }),
  async execute(input, ctx) {
    return getProjectEvidence(input, ctx.session.auth.current);
  },
});
