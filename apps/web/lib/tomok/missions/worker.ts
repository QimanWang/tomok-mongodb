import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { projectDb } from "../db";
import { TomokError } from "../errors";
import { PROJECT_ID } from "../repository";
import { bindings, isTerminal, missions, requireMission, updateMission } from "./repository";
import { createIdleMissionSession, inspectMissionSession, sendMissionWork, type MissionRuntimeSnapshot } from "./transport";
import type { MissionDispatchDescriptor, MissionDocument } from "./types";

export const descriptorFor = (mission: MissionDocument): MissionDispatchDescriptor => ({ missionId: mission.id, owner: mission.owner,
  releaseId: mission.releaseId, generation: mission.generation, dispatchId: mission.dispatch.id,
  principal: mission.principal, ...(mission.currentSessionId ? { sessionId: mission.currentSessionId } : {}) });

export async function bindMissionSession(db: Db, mission: MissionDocument, sessionId: string) {
  if (!/^[A-Za-z0-9_-]{1,180}$/.test(sessionId)) throw new TomokError("The worker returned an invalid runtime session.");
  await bindings(db).updateOne({ _id: sessionId }, { $setOnInsert: { _id: sessionId, sessionId, missionId: mission.id,
    owner: mission.owner, releaseId: mission.releaseId, generation: mission.generation, createdAt: new Date().toISOString() } }, { upsert: true });
  const binding = await bindings(db).findOne({ _id: sessionId });
  if (binding?.missionId !== mission.id || binding.generation !== mission.generation) throw new TomokError("Runtime session was already bound to different work.", 409);
  return updateMission(db, mission, { currentSessionId: sessionId });
}

type Transport = { create: typeof createIdleMissionSession; inspect: typeof inspectMissionSession; send: typeof sendMissionWork };
const transport: Transport = { create: createIdleMissionSession, inspect: inspectMissionSession, send: sendMissionWork };
const completedCount = (mission: MissionDocument) => mission.jobs.filter((job) => ["completed", "failed"].includes(job.status)).length;
const interruptedJobs = (mission: MissionDocument) => mission.jobs.map((job) => job.status === "running"
  ? { ...job, status: job.attempt >= 3 ? "failed" as const : "pending" as const,
    lastError: "The runtime stopped before publishing this source unit." } : job);
export const STALE_RUNTIME_LIMITS = { expiredLeaseMs: 4 * 60_000, idleMs: 10 * 60_000 } as const;
export const MAX_RUNTIME_INSPECTION_FAILURES = 4;

/** A stream that still says running is not a heartbeat after a process disappears. */
export function missionRuntimeIsStale(mission: MissionDocument, snapshot: MissionRuntimeSnapshot, now = Date.now()) {
  const lastEvent = snapshot.lastEventAt ? Date.parse(snapshot.lastEventAt) : Number.NaN;
  const leaseExpires = mission.activeLease ? Date.parse(mission.activeLease.expiresAt) : null;
  // Never replace an explicitly unexpired lease, including malformed leases that need inspection.
  if (leaseExpires !== null && (!Number.isFinite(leaseExpires) || leaseExpires > now)) return false;
  if (snapshot.state === "running") {
    return Number.isFinite(lastEvent) && now - lastEvent >= (leaseExpires === null ? STALE_RUNTIME_LIMITS.idleMs : STALE_RUNTIME_LIMITS.expiredLeaseMs);
  }
  if (snapshot.state === "unknown" && mission.dispatch.status === "accepted") {
    const accepted = mission.dispatch.acceptedAt ? Date.parse(mission.dispatch.acceptedAt) : Number.NaN;
    if (!Number.isFinite(accepted)) return false;
    const latest = Number.isFinite(lastEvent) ? Math.max(accepted, lastEvent) : accepted;
    return now - latest >= STALE_RUNTIME_LIMITS.idleMs;
  }
  return false;
}

/** One bounded reconciliation pass; durable mission/dispatch state, never a browser, decides what to resume. */
export async function reconcileMission(id: string, io: Transport = transport) {
  const db = await projectDb(); let mission = await requireMission(db, id);
  if (!["queued", "running"].includes(mission.status)) return { id, state: mission.status };
  if (mission.dispatch.status === "sending" && mission.dispatch.leaseUntil && mission.dispatch.leaseUntil > new Date().toISOString()) return { id, state: "dispatching" };
  let dispatchId = mission.dispatch.id, generation = mission.generation;
  let inspecting = false;
  try {
    if (mission.currentSessionId) {
      inspecting = true;
      const snapshot = await io.inspect(descriptorFor(mission));
      inspecting = false;
      if (mission.dispatch.inspectionFailures || mission.dispatch.error) {
        const cleared = { ...mission.dispatch, inspectionFailures: 0 };
        delete cleared.error;
        mission = await updateMission(db, mission, { dispatch: cleared });
      }
      // The durable inbox may have accepted a send whose HTTP response was lost.
      if (snapshot.dispatchIds.includes(dispatchId) && mission.dispatch.status !== "accepted") {
        mission = await updateMission(db, mission, { status: "running", dispatch: { ...mission.dispatch, status: "accepted", acceptedAt: new Date().toISOString() } });
      }
      const staleRuntime = missionRuntimeIsStale(mission, snapshot);
      if (snapshot.state === "running" && !staleRuntime) return { id, state: "running" };
      if (snapshot.state === "waiting_for_input") {
        await updateMission(db, mission, { status: "paused", activeLease: null, pauseReason: "The runtime requires input or reached its provider limit. Resume explicitly after resolving it." });
        return { id, state: "paused" };
      }
      // An idle session can have an empty stream after a crash between binding and send.
      // The persistent pending delivery still needs dispatch; the client retries startup races.
      if (snapshot.state === "unknown" && mission.dispatch.status === "accepted" && !staleRuntime) return { id, state: "runtime-recovering" };
      const terminalRuntime = snapshot.state === "failed" || snapshot.state === "completed";
      const replaceRuntime = terminalRuntime || staleRuntime;
      if (replaceRuntime || mission.dispatch.status === "accepted") {
        if (!replaceRuntime && Date.now() - Date.parse(mission.dispatch.acceptedAt ?? mission.updatedAt) < 5_000) return { id, state: "starting" };
        const count = completedCount(mission), noProgress = count > (mission.dispatch.checkpointCount ?? 0) ? 0 : (mission.dispatch.noProgress ?? 0) + 1;
        if (noProgress >= 3) {
          await updateMission(db, mission, { status: "paused", activeLease: null, jobs: interruptedJobs(mission), pauseReason: "Three dispatches made no new committed progress. Inspect the source gaps before resuming." });
          return { id, state: "paused" };
        }
        // A failed/settled turn cannot finish an abandoned lease. Fence it before another delivery.
        mission = await updateMission(db, mission, { activeLease: null, jobs: interruptedJobs(mission),
          ...(replaceRuntime ? { generation: mission.generation + 1, currentSessionId: null,
            lastCheckpoint: staleRuntime
              ? "Runtime stopped reporting progress and has no valid work lease. Continuing in a new bound session from committed source outputs."
              : "Runtime session ended. Continuing in a new bound session from committed source outputs." } : {}),
          dispatch: { id: randomUUID(), status: "pending", attempts: 0, checkpointCount: count, noProgress } });
        // Old bindings remain permanently scoped; generation and currentSessionId fence every old tool.
        dispatchId = mission.dispatch.id; generation = mission.generation;
      }
    }
    if (mission.dispatch.attempts >= 4) {
      await updateMission(db, mission, { status: "failed", activeLease: null, dispatch: { ...mission.dispatch, status: "failed", error: "The worker could not deliver work after four attempts. Check the linked services, then retry." } });
      return { id, state: "failed" };
    }
    mission = await updateMission(db, mission, { dispatch: { ...mission.dispatch, status: "sending", attempts: mission.dispatch.attempts + 1,
      leaseUntil: new Date(Date.now() + 60_000).toISOString(), checkpointCount: mission.dispatch.checkpointCount ?? completedCount(mission) } });
    if (!mission.currentSessionId) mission = await bindMissionSession(db, mission, await io.create(descriptorFor(mission)));
    const sending = descriptorFor(mission);
    await io.send(sending, sending.dispatchId);
    const latest = await requireMission(db, id);
    if (latest.generation === sending.generation && latest.dispatch.id === sending.dispatchId && !isTerminal(latest) && latest.status !== "paused") {
      await updateMission(db, latest, { status: "running", dispatch: { ...latest.dispatch, status: "accepted", acceptedAt: new Date().toISOString(), error: undefined } });
    }
    return { id, state: "accepted" };
  } catch (error) {
    if (error instanceof TomokError && error.status === 409) return { id, state: "checkpoint-changed" };
    const latest = await requireMission(db, id);
    if (latest.generation === generation && latest.dispatch.id === dispatchId && ["queued", "running"].includes(latest.status)) {
      if (inspecting) {
        const failures = (latest.dispatch.inspectionFailures ?? 0) + 1;
        const paused = failures >= MAX_RUNTIME_INSPECTION_FAILURES;
        const message = paused
          ? "Runtime inspection failed four consecutive times. The checkpoint is saved; check the linked services before resuming."
          : `Runtime inspection failed (${failures} of ${MAX_RUNTIME_INSPECTION_FAILURES}). The checkpoint is saved; reconciliation will retry.`;
        try {
          await updateMission(db, latest, { dispatch: { ...latest.dispatch, inspectionFailures: failures, error: message },
            ...(paused ? { status: "paused", activeLease: null, jobs: interruptedJobs(latest), pauseReason: message } : {}) });
        } catch (updateError) {
          if (updateError instanceof TomokError && updateError.status === 409) return { id, state: "checkpoint-changed" };
          throw updateError;
        }
        return { id, state: paused ? "paused" : "retry-pending" };
      }
      await updateMission(db, latest, { dispatch: { ...latest.dispatch, error: "Worker delivery or runtime inspection failed. The checkpoint is saved; reconciliation will retry." } }).catch(() => {});
    }
    return { id, state: "retry-pending" };
  }
}

export async function reconcilePendingMissions() {
  const db = await projectDb();
  const rows = await missions(db).find({ projectId: PROJECT_ID, status: { $in: ["queued", "running"] } }).sort({ updatedAt: 1 }).limit(3).toArray();
  const results = [];
  for (const row of rows) results.push(await reconcileMission(row.id));
  return results;
}
