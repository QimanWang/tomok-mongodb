import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import { TomokError } from "../errors";
import { PROJECT_ID } from "../repository";
import type { MissionDetail, MissionDocument, MissionOutput, MissionSessionBinding, MissionSummary } from "./types";

export const missionHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
export const missions = (db: Db) => db.collection<MissionDocument>("missions");
export const outputs = (db: Db) => db.collection<MissionOutput>("mission_outputs");
export const bindings = (db: Db) => db.collection<MissionSessionBinding>("mission_sessions");
export const isTerminal = (mission: Pick<MissionDocument, "status">) => ["completed", "completed_with_gaps"].includes(mission.status);

export async function ensureMissionCollections(db: Db) {
  await missions(db).createIndex({ projectId: 1, owner: 1, createdAt: -1 });
  await missions(db).createIndex({ status: 1, "dispatch.status": 1, updatedAt: 1 });
  await bindings(db).createIndex({ sessionId: 1 }, { unique: true });
  await outputs(db).createIndex({ missionId: 1, jobId: 1 });
}

export async function requireMission(db: Db, id: string, owner?: string) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new TomokError("Archive mission not found.", 404);
  const mission = await missions(db).findOne({ _id: id, projectId: PROJECT_ID, ...(owner ? { owner } : {}) });
  if (!mission) throw new TomokError("Archive mission not found.", 404);
  return mission;
}

/** One bounded mission document owns leases, job outcomes and publication pointers.
 * Atomic revision comparison fences concurrent agents, pauses and late workers.
 * Output bodies are immutable and invisible until this document publishes their IDs.
 */
export async function updateMission(db: Db, current: MissionDocument, patch: Partial<MissionDocument>) {
  const result = await missions(db).findOneAndUpdate({ _id: current._id, projectId: PROJECT_ID, revision: current.revision },
    { $set: { ...patch, updatedAt: new Date().toISOString() }, $inc: { revision: 1 } }, { returnDocument: "after" });
  if (!result) throw new TomokError("The mission changed while this step was running. Reload its checkpoint and retry.", 409);
  return result;
}

export async function committedOutputs(db: Db, mission: MissionDocument) {
  const published = mission.jobs.filter((job) => job.status === "completed" && job.outputId).map((job) => job.outputId!);
  if (!published.length) return [];
  const rows = await outputs(db).find({ _id: { $in: published }, missionId: mission.id, releaseId: mission.releaseId }).toArray();
  const byId = new Map(rows.map((row) => [row._id, row]));
  if (rows.length !== published.length) throw new TomokError("A committed mission result is unavailable. Retry after storage recovers.");
  return published.map((id) => byId.get(id)!);
}

export function missionSummary(mission: MissionDocument): MissionSummary {
  const { id, goal, cutoff, status, createdAt, updatedAt, pauseReason, lastCheckpoint } = mission;
  return { id, goal, cutoff, status, createdAt, updatedAt, pauseReason, lastCheckpoint, href: `/missions/${id}`,
    completedJobs: mission.jobs.filter((job) => job.status === "completed").length,
    totalJobs: mission.jobs.length, failedJobs: mission.jobs.filter((job) => job.status === "failed").length };
}

export async function missionDetail(db: Db, mission: MissionDocument): Promise<MissionDetail> {
  return { ...missionSummary(mission), releaseId: mission.releaseId, generation: mission.generation, manifest: mission.manifest,
    jobs: mission.jobs.map((job) => ({ ...job, unit: mission.manifest.units.find((unit) => unit.id === job.unitId)! })),
    outputs: await committedOutputs(db, mission), report: mission.report, budget: mission.budget,
    dispatch: { status: mission.dispatch.status, attempts: mission.dispatch.attempts, ...(mission.dispatch.error ? { error: mission.dispatch.error } : {}) },
    policies: mission.policies, activePolicyId: mission.activePolicyId, policyEvaluations: mission.policyEvaluations,
    capabilities: { canPause: ["queued", "running"].includes(mission.status), canResume: mission.status === "paused",
      canRetry: mission.status === "failed" || mission.jobs.some((job) => job.status === "failed") },
  };
}
