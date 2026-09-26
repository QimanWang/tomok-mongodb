import { connect } from "@vercel/connect/eve";
import { defineDynamic, defineMcpClientConnection } from "eve/connections";

import { isBoundedProjectSession } from "../lib/session-scope";

// LINEAR_CONNECTOR is the UID returned by Vercel Connect. For local setup,
// create a connector with `vercel connect create https://mcp.linear.app/mcp --name linear`.
const linearConnector = process.env.LINEAR_CONNECTOR ?? "linear";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      if (await isBoundedProjectSession(ctx.session)) return null;
      return defineMcpClientConnection({
        instanceKey: linearConnector,
        url: "https://mcp.linear.app/mcp",
        description:
          "Linear workspace: search and update issues, projects, cycles, comments, and planning work.",
        auth: connect(linearConnector),
      });
    },
  },
});
