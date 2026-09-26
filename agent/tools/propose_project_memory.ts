import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { isBoundedProjectSession, requireLiveProjectSession } from "../lib/session-scope";
import { proposeProjectMemory } from "../../apps/web/lib/tomok/memory-service";

export const liveTool = defineTool({
  description:
    "Save a draft mapping or interpretation for human review when the user requests it. Requires an existing investigation and exact supporting evidence IDs. This only creates a proposal: it does not approve knowledge, impersonate a reviewer, or change an existing memory's review status. Human review and corrections happen in the Tomok UI.",
  inputSchema: z.strictObject({
    investigationId: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .describe("Exact ID of the investigation that supports this proposal."),
    kind: z.enum(["mapping", "interpretation"]),
    title: z.string().trim().min(1).max(120),
    statement: z
      .string()
      .trim()
      .min(1)
      .max(2_000)
      .describe("Proposed project knowledge, preserving uncertainty and source qualifications."),
    validFrom: z.iso
      .date()
      .describe("First reporting date to which the proposed knowledge applies."),
    validThrough: z.iso
      .date()
      .nullable()
      .describe("Last applicable reporting date, inclusive; null when no end is proposed."),
    evidenceIds: z
      .array(z.string().trim().min(1).max(300))
      .min(1)
      .max(10)
      .describe("Exact evidence _id values retrieved from get_project_evidence; do not invent IDs."),
  }).refine(
    ({ validFrom, validThrough }) => validThrough === null || validThrough >= validFrom,
    { message: "The validity end must not precede its start.", path: ["validThrough"] },
  ),
  async execute(input, ctx) {
    await requireLiveProjectSession(ctx.session);
    const { memory, href } = await proposeProjectMemory(input, ctx.session.auth.current);
    return {
      href,
      memory: {
        id: memory.id,
        status: memory.latest.status,
        revision: memory.latest.revision,
      },
      message:
        "Open this note to review its current state. This proposal call does not accept or review knowledge; a repeated proposal may return a note whose status has since changed.",
    };
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
