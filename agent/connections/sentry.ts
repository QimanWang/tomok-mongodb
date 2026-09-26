import { connect } from "@vercel/connect/eve";
import { defineDynamic, defineMcpClientConnection } from "eve/connections";

import { isBoundedProjectSession } from "../lib/session-scope";

// SENTRY_CONNECTOR is the UID returned by Vercel Connect. For local setup,
// create a connector with `vercel connect create https://mcp.sentry.dev/mcp --name sentry`.
const sentryConnector = process.env.SENTRY_CONNECTOR ?? "sentry";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      if (await isBoundedProjectSession(ctx.session)) return null;
      return defineMcpClientConnection({
        instanceKey: sentryConnector,
        url: "https://mcp.sentry.dev/mcp",
        description:
          "Sentry workspace: investigate issues, events, traces, releases, and project health.",
        auth: connect(sentryConnector),
      });
    },
  },
});
