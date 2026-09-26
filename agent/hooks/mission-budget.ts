import { defineHook } from "eve/hooks";
import { completeMissionModelStep, startMissionModelStep } from "../../apps/web/lib/tomok/missions/model-budget";

export default defineHook({ events: {
  "step.started": async (event, ctx) => { await startMissionModelStep(ctx.session, event); },
  "step.completed": async (event, ctx) => { await completeMissionModelStep(ctx.session, event); },
} });
