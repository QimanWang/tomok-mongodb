import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { isBoundedProjectSession, requireLiveProjectSession } from "../lib/session-scope";
import { getProjectEvidence } from "../../apps/web/lib/tomok/service";

export const liveTool = defineTool({
  description:
    "Retrieve bounded, source-linked project evidence and current applicable reviewed knowledge as of a reporting cutoff. Optional plain-language queries use Atlas Vector Search within eligible evidence; check retrieval.mode for explicit keyword fallback. Initial coverage is selected South Portal jet-grouting field records. Read reviewedMemory alongside source evidence, keeping human interpretation separate. Preserve applicability warnings, including undated plans and unreviewed mappings; similarity is not confidence and absence does not prove work did not occur.",
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
    await requireLiveProjectSession(ctx.session);
    return getProjectEvidence(input, ctx.session.auth.current);
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
