import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { isBoundedProjectSession, requireLiveProjectSession } from "../lib/session-scope";

// The runtime tool name comes from the filename, so the model sees this as
// `get_weather`. Tool filenames must be snake_case ASCII.
export const liveTool = defineTool({
  description: "Get the current weather for a city.",
  inputSchema: z.object({ city: z.string().min(1) }),
  async execute({ city }, ctx) {
    await requireLiveProjectSession(ctx.session);
    return { city, condition: "Sunny", temperatureF: 72 };
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
