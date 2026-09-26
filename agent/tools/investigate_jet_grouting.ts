import { defineDynamic, defineTool } from "eve/tools";
import { isBoundedProjectSession, requireLiveProjectSession } from "../lib/session-scope";
import { investigationInput, investigateJetGrouting } from "../../apps/web/lib/tomok/service";

export const liveTool = defineTool({
  description:
    "Investigate South Portal jet-grouting progress as of a reporting cutoff using imported P6, field-plan, and daily-report evidence. Return deterministic findings, source links, applicability warnings, and a saved investigation URL. Include targetMilestoneCode only when the user selects MS-260 or MS-280; neither is an accepted default. The optional selectedSource must contain the exact registered source ID, SHA-256 and locator from the user's selection, never a guessed source. A selected page or cell does not ingest it. Dependency context is an imported path, not a driving path, new finish, or delay cause.",
  inputSchema: investigationInput,
  async execute(input, ctx) {
    await requireLiveProjectSession(ctx.session);
    return investigateJetGrouting(input, ctx.session.auth.current);
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
