import { projectDb } from "../db";
import { TomokError } from "../errors";
import { missions } from "./repository";
import { getSessionMission } from "./service";
import type { MissionDocument, MissionSession } from "./types";

export const MISSION_MODEL_LIMITS = { steps: 60, inputTokens: 500_000, outputTokens: 30_000 } as const;
type ModelEvent = { meta: { id: string }; data: { turnId: string; stepIndex: number; sequence: number } };
type Usage = { inputTokens?: number; outputTokens?: number };
const reached = (mission: MissionDocument) => (mission.budget.modelSteps ?? 0) >= (mission.budget.maxModelSteps ?? MISSION_MODEL_LIMITS.steps)
  || (mission.budget.inputTokens ?? 0) >= (mission.budget.maxInputTokens ?? MISSION_MODEL_LIMITS.inputTokens)
  || (mission.budget.outputTokens ?? 0) >= (mission.budget.maxOutputTokens ?? MISSION_MODEL_LIMITS.outputTokens);

async function pauseForModelBudget(mission: MissionDocument, session: MissionSession) {
  await missions(await projectDb()).updateOne({ _id: mission.id, currentSessionId: session.id, generation: mission.generation, status: { $in: ["queued", "running"] } },
    { $set: { status: "paused", activeLease: null, updatedAt: new Date().toISOString(),
      pauseReason: "The mission reached its model-call or provider-token budget. Resume explicitly to grant another bounded work period.",
      lastCheckpoint: "Model budget reached. Committed source outputs are preserved; remaining work is paused." }, $inc: { revision: 1 } });
}

/** Recorded runtime events, never model arguments, supply usage and deduplication identity. */
export async function startMissionModelStep(session: MissionSession, event: ModelEvent) {
  const mission = await getSessionMission(session);
  if (!mission) return;
  if (mission.currentSessionId !== session.id) throw new TomokError("This archive worker was replaced. Its checkpoint is saved.", 409);
  // A successful report leaves no mission tools enabled; allow its final plain-text response to settle.
  if (["completed", "completed_with_gaps"].includes(mission.status)) return;
  if (!["queued", "running"].includes(mission.status)) throw new TomokError("This archive worker is paused or stopped. Its checkpoint is saved.", 409);
  const id = `start:${event.meta.id}`;
  if (mission.modelStepIds?.includes(id)) return;
  if (reached(mission)) {
    await pauseForModelBudget(mission, session);
    throw new TomokError("The mission's model budget is reached. Resume it explicitly from its workspace.", 409);
  }
  const result = await missions(await projectDb()).findOneAndUpdate({ _id: mission.id, currentSessionId: session.id,
    generation: mission.generation, status: { $in: ["queued", "running"] }, modelStepIds: { $ne: id },
    $expr: { $and: [
      { $lt: [{ $ifNull: ["$budget.modelSteps", 0] }, { $ifNull: ["$budget.maxModelSteps", MISSION_MODEL_LIMITS.steps] }] },
      { $lt: [{ $ifNull: ["$budget.inputTokens", 0] }, { $ifNull: ["$budget.maxInputTokens", MISSION_MODEL_LIMITS.inputTokens] }] },
      { $lt: [{ $ifNull: ["$budget.outputTokens", 0] }, { $ifNull: ["$budget.maxOutputTokens", MISSION_MODEL_LIMITS.outputTokens] }] },
    ] } }, { $addToSet: { modelStepIds: id }, $inc: { "budget.modelSteps": 1, revision: 1 },
      $set: { updatedAt: new Date().toISOString() } }, { returnDocument: "after" });
  if (!result) {
    const latest = await getSessionMission(session);
    if (latest?.modelStepIds?.includes(id) && latest.currentSessionId === session.id && ["queued", "running"].includes(latest.status)) return;
    if (latest && reached(latest)) await pauseForModelBudget(latest, session);
    throw new TomokError("The mission changed or exhausted its model budget before this step.", 409);
  }
}

const tokens = (value: number | undefined) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

export async function completeMissionModelStep(session: MissionSession, event: ModelEvent & { data: ModelEvent["data"] & { usage?: Usage } }) {
  const mission = await getSessionMission(session);
  if (!mission) return;
  const id = `usage:${event.meta.id}`;
  const updated = await missions(await projectDb()).findOneAndUpdate({ _id: mission.id, modelStepIds: { $ne: id } },
    { $addToSet: { modelStepIds: id }, $inc: { "budget.inputTokens": tokens(event.data.usage?.inputTokens),
      "budget.outputTokens": tokens(event.data.usage?.outputTokens), revision: 1 }, $set: { updatedAt: new Date().toISOString() } },
    { returnDocument: "after" });
  // Exact provider usage arrives after the call. Stop further work once its reported usage crosses a cap.
  if (updated && ((updated.budget.inputTokens ?? 0) >= (updated.budget.maxInputTokens ?? MISSION_MODEL_LIMITS.inputTokens)
    || (updated.budget.outputTokens ?? 0) >= (updated.budget.maxOutputTokens ?? MISSION_MODEL_LIMITS.outputTokens))) await pauseForModelBudget(updated, session);
}
