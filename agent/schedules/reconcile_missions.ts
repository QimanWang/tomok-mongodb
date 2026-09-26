import { defineSchedule } from "eve/schedules";
import { reconcilePendingMissions } from "../../apps/web/lib/tomok/missions/worker";

export default defineSchedule({
  cron: "* * * * *",
  async run() { await reconcilePendingMissions(); },
});
