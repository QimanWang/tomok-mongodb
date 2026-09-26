import { setTimeout } from "node:timers/promises";
import { closeProjectDb } from "../apps/web/lib/tomok/db";
import { reconcilePendingMissions } from "../apps/web/lib/tomok/missions/worker";

const hostAt = process.argv.indexOf("--host");
if (hostAt !== -1) process.env.VERCEL_URL = process.argv[hostAt + 1];
if (!process.env.VERCEL_URL) process.env.VERCEL_URL = "localhost:3001";
let stopped = false;
process.on("SIGINT", () => { stopped = true; });
process.on("SIGTERM", () => { stopped = true; });
let previous = "";
try {
  do {
    try {
      const results = await reconcilePendingMissions(), compact = JSON.stringify(results);
      if (compact !== previous) { console.log(compact); previous = compact; }
    } catch { console.error("Mission reconciliation is unavailable; checkpoints remain saved."); }
    if (process.argv.includes("--once")) break;
    await setTimeout(5_000);
  } while (!stopped);
} finally { await closeProjectDb(); }
