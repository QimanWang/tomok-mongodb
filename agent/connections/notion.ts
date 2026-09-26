import { connect } from "@vercel/connect/eve";
import { defineDynamic, defineMcpClientConnection } from "eve/connections";

import { isBoundedProjectSession } from "../lib/session-scope";

// NOTION_CONNECTOR is provisioned by the "Deploy with Vercel" flow. For local
// setup, create a connector with `vercel connect create mcp.notion.com --name notion`.
const notionConnector = process.env.NOTION_CONNECTOR ?? "notion";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      if (await isBoundedProjectSession(ctx.session)) return null;
      return defineMcpClientConnection({
        instanceKey: notionConnector,
        url: "https://mcp.notion.com/mcp",
        description: "Notion workspace: search and edit pages and databases.",
        auth: connect(notionConnector),
      });
    },
  },
});
