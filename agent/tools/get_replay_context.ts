import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { getReplayContext, getSessionReplay } from "../../apps/web/lib/tomok/replay-chat-service";

export const replayTool = defineTool({
  description: "Read the frozen source excerpts, findings, and reviewed note revisions belonging to this replay conversation. Takes no inputs. The saved stage, cutoff, project, and release are fixed by the server and cannot be advanced in this chat.",
  inputSchema: z.strictObject({}),
  async execute(input, ctx) { return getReplayContext(input, ctx.session); },
});

export default defineDynamic({ events: { "turn.started": async (_event, ctx) =>
  await getSessionReplay(ctx.session) ? replayTool : null } });
