import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { closeProjectDb } from "../apps/web/lib/tomok/db.ts";
import { getMissionContext } from "../apps/web/lib/tomok/missions/service.ts";
import { missionRuntimeIsStale, reconcileMission } from "../apps/web/lib/tomok/missions/worker.ts";

const originalEnv = { ...process.env };
const principal = { principalId: "eve-chat-user", principalType: "user", authenticator: "password", issuer: "eve-chat-template" };
const ago = minutes => new Date(Date.now() - minutes * 60_000).toISOString();
const id = () => randomUUID().replaceAll("-", "");
const snapshot = (state, age = 5) => ({ state, lastEventAt: ago(age), lastEventId: "isolated-runtime-event", dispatchIds: [], latestTurnFailed: false });
let server, client, db;

before(async () => {
  server = await MongoMemoryServer.create(); client = await new MongoClient(server.getUri()).connect(); db = client.db("mission_worker_recovery");
  for (const key of ["DATABASE_URL", "BETTER_AUTH_SECRET", "NEXT_PUBLIC_VERCEL_APP_CLIENT_ID", "VERCEL_APP_CLIENT_SECRET", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN"]) delete process.env[key];
  Object.assign(process.env, { EVE_CHAT_PASSWORD: "isolated-worker-recovery-password", MONGODB_URI: server.getUri(), MONGODB_DATABASE: "mission_worker_recovery" });
});
beforeEach(async () => { await Promise.all(["missions", "mission_sessions", "mission_outputs"].map(name => db.collection(name).deleteMany({}))); });
after(async () => {
  await closeProjectDb(); await client?.close(); await server?.stop();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

async function missionFixture(patch = {}) {
  const missionId = id(), sessionId = `wrun_${id()}`, pendingJob = id(), outputId = id();
  const document = {
    _id: missionId, id: missionId, projectId: "bp-tunnel", owner: principal.principalId, principal,
    releaseId: "b".repeat(64), importVersion: "isolated-test", goal: "Isolated stale-runtime recovery test", cutoff: "2026-07-16", requestHash: id(),
    createdAt: ago(20), updatedAt: ago(5), status: "running", generation: 1, revision: 1,
    manifest: { version: "isolated-test", sources: [], units: [], releaseId: "b".repeat(64), cutoff: "2026-07-16", id: id() },
    jobs: [{ id: id(), unitId: id(), status: "completed", attempt: 1, policyVersion: "v1", outputId },
      { id: pendingJob, unitId: id(), status: "running", attempt: 1, policyVersion: "v1" }],
    activeLease: { jobId: pendingJob, token: randomUUID(), generation: 1, expiresAt: ago(1) },
    currentSessionId: sessionId, dispatch: { id: randomUUID(), status: "accepted", attempts: 1, acceptedAt: ago(15), checkpointCount: 1, noProgress: 0 },
    budget: { maxJobs: 64, maxAttempts: 48, maxToolCalls: 120, toolCalls: 12, attempts: 2, modelSteps: 4, inputTokens: 100, outputTokens: 25 },
    pauseReason: null, lastCheckpoint: "Source output committed before service interruption", report: null, policies: [], activePolicyId: "v1", policyEvaluations: [], actionIds: [],
    ...patch,
  };
  await db.collection("missions").insertOne(document);
  await db.collection("mission_sessions").insertOne({ _id: sessionId, sessionId, missionId, owner: principal.principalId,
    releaseId: document.releaseId, generation: 1, createdAt: document.createdAt });
  await db.collection("mission_outputs").insertOne({ _id: outputId, missionId, facts: [{ id: "committed-canary", value: "Preserved immutable output" }] });
  return document;
}

function recoveringTransport(state, age = 5) {
  const calls = { creates: 0, sends: 0 };
  return { calls, io: {
    inspect: async () => snapshot(state, age),
    create: async () => { calls.creates++; return `wrun_${id()}`; },
    send: async descriptor => { calls.sends++; return { accepted: true, sessionId: descriptor.sessionId }; },
  } };
}

test("stale running runtime with expired lease recovers while preserving output, budgets and old binding", async () => {
  const mission = await missionFixture(), { calls, io } = recoveringTransport("running", 5);
  const outputBefore = await db.collection("mission_outputs").findOne({ missionId: mission.id });
  assert.equal((await reconcileMission(mission.id, io)).state, "accepted");
  const saved = await db.collection("missions").findOne({ _id: mission.id });
  assert.equal(saved.generation, 2);
  assert.notEqual(saved.currentSessionId, mission.currentSessionId);
  assert.equal(saved.activeLease, null);
  assert.deepEqual(saved.budget, mission.budget);
  assert.deepEqual(saved.jobs[0], mission.jobs[0]);
  assert.equal(saved.jobs[1].status, "pending");
  assert.deepEqual(await db.collection("mission_outputs").findOne({ missionId: mission.id }), outputBefore);
  assert.equal(await db.collection("mission_sessions").countDocuments({ missionId: mission.id }), 2);
  assert.deepEqual(calls, { creates: 1, sends: 1 });
  await assert.rejects(() => getMissionContext({}, { id: mission.currentSessionId, auth: { current: principal, initiator: principal } }), error => error?.status === 409);
});

test("recent events, unexpired leases and missing/invalid running timestamps cannot trigger replacement", async () => {
  for (const variant of ["recent", "unexpired", "missing", "invalid"]) {
    const mission = await missionFixture();
    let report = snapshot("running", variant === "recent" ? 2 : 15);
    if (variant === "unexpired") {
      mission.activeLease.expiresAt = new Date(Date.now() + 60_000).toISOString();
      await db.collection("missions").updateOne({ _id: mission.id }, { $set: { activeLease: mission.activeLease } });
    }
    if (variant === "missing") report.lastEventAt = null;
    if (variant === "invalid") report.lastEventAt = "invalid-date";
    const { calls, io } = recoveringTransport("running"); io.inspect = async () => report;
    assert.equal((await reconcileMission(mission.id, io)).state, "running", variant);
    assert.deepEqual(calls, { creates: 0, sends: 0 });
    assert.equal((await db.collection("missions").findOne({ _id: mission.id })).generation, 1);
  }
});

test("running work without a lease waits ten minutes and accepted unknown work has a bounded recovery window", async () => {
  const withoutLease = await missionFixture({ activeLease: null });
  const { calls, io } = recoveringTransport("running", 5);
  assert.equal((await reconcileMission(withoutLease.id, io)).state, "running");
  io.inspect = async () => snapshot("running", 11);
  assert.equal((await reconcileMission(withoutLease.id, io)).state, "accepted");
  assert.deepEqual(calls, { creates: 1, sends: 1 });
  const unknown = await missionFixture({ activeLease: null });
  const recovering = recoveringTransport("unknown", 5);
  assert.equal((await reconcileMission(unknown.id, recovering.io)).state, "runtime-recovering");
  recovering.io.inspect = async () => ({ ...snapshot("unknown"), lastEventAt: null });
  assert.equal((await reconcileMission(unknown.id, recovering.io)).state, "accepted");
  assert.equal(recovering.calls.creates, 1);
  const recent = await missionFixture({ activeLease: null });
  recent.dispatch.acceptedAt = ago(2);
  assert.equal(missionRuntimeIsStale(recent, { ...snapshot("unknown"), lastEventAt: null }), false);
});

test("stale recovery cannot bypass the existing no-progress pause", async () => {
  const mission = await missionFixture();
  await db.collection("missions").updateOne({ _id: mission.id }, { $set: { "dispatch.noProgress": 2 } });
  const { calls, io } = recoveringTransport("running", 5);
  assert.equal((await reconcileMission(mission.id, io)).state, "paused");
  assert.deepEqual(calls, { creates: 0, sends: 0 });
  const saved = await db.collection("missions").findOne({ _id: mission.id });
  assert.equal(saved.status, "paused");
  assert.equal(saved.report, null);
  assert.equal(saved.jobs[0].outputId, mission.jobs[0].outputId);
  assert.deepEqual(saved.budget, mission.budget);
});

test("a concurrent lease renewal wins over an old stale snapshot", async () => {
  const mission = await missionFixture(), { calls, io } = recoveringTransport("running", 5);
  io.inspect = async () => {
    await db.collection("missions").updateOne({ _id: mission.id }, { $inc: { revision: 1 },
      $set: { "activeLease.expiresAt": new Date(Date.now() + 180_000).toISOString() } });
    return snapshot("running", 5);
  };
  assert.equal((await reconcileMission(mission.id, io)).state, "checkpoint-changed");
  assert.deepEqual(calls, { creates: 0, sends: 0 });
  assert.equal((await db.collection("missions").findOne({ _id: mission.id })).currentSessionId, mission.currentSessionId);
});

test("four consecutive runtime-inspection failures park with saved progress instead of retrying forever", async () => {
  const mission = await missionFixture(), { calls, io } = recoveringTransport("running");
  let inspections = 0;
  io.inspect = async () => { inspections++; throw new Error("Isolated missing runtime session"); };
  for (let attempt = 1; attempt <= 4; attempt++) {
    assert.equal((await reconcileMission(mission.id, io)).state, attempt === 4 ? "paused" : "retry-pending");
    assert.equal((await db.collection("missions").findOne({ _id: mission.id })).dispatch.inspectionFailures, attempt);
  }
  assert.equal((await reconcileMission(mission.id, io)).state, "paused");
  assert.equal(inspections, 4);
  assert.deepEqual(calls, { creates: 0, sends: 0 });
  const saved = await db.collection("missions").findOne({ _id: mission.id });
  assert.equal(saved.activeLease, null);
  assert.deepEqual(saved.budget, mission.budget);
  assert.equal(saved.jobs[0].outputId, mission.jobs[0].outputId);
  assert.equal(saved.jobs[1].status, "pending");
  assert.match(saved.dispatch.error, /inspection failed four consecutive times/);
  assert.match(saved.pauseReason, /checkpoint is saved/);
  assert.equal(saved.report, null);
});

test("a subsequent good inspection clears the error and resets the consecutive-failure counter", async () => {
  const mission = await missionFixture(), { calls, io } = recoveringTransport("running", 1);
  const inspect = io.inspect;
  io.inspect = async () => { throw new Error("Isolated transient inspection outage"); };
  await reconcileMission(mission.id, io); await reconcileMission(mission.id, io);
  io.inspect = inspect;
  assert.equal((await reconcileMission(mission.id, io)).state, "running");
  let saved = await db.collection("missions").findOne({ _id: mission.id });
  assert.equal(saved.dispatch.inspectionFailures, 0);
  assert.equal(saved.dispatch.error, undefined);
  assert.equal(saved.generation, mission.generation);
  io.inspect = async () => { throw new Error("Another isolated transient inspection outage"); };
  assert.equal((await reconcileMission(mission.id, io)).state, "retry-pending");
  saved = await db.collection("missions").findOne({ _id: mission.id });
  assert.equal(saved.dispatch.inspectionFailures, 1);
  assert.deepEqual(calls, { creates: 0, sends: 0 });
});
