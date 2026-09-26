import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { routeAuth } from "eve/channels/auth";
import { buildProjectImport } from "../apps/web/lib/tomok/import-data.ts";
import { persistProjectImport } from "../apps/web/lib/tomok/repository.ts";
import { closeProjectDb } from "../apps/web/lib/tomok/db.ts";
import { claimMissionJob, commitMissionJob, createMission, getMissionContext, getSessionMission, readMissionUnit } from "../apps/web/lib/tomok/missions/service.ts";
import { updateMission } from "../apps/web/lib/tomok/missions/repository.ts";
import { startMissionModelStep, completeMissionModelStep } from "../apps/web/lib/tomok/missions/model-budget.ts";
import { MISSION_DISPATCH_HEADER, signMissionDispatch } from "../apps/web/lib/tomok/missions/dispatch-auth.ts";
import { missionDispatchAuth } from "../agent/lib/mission-auth.ts";
import { withReplayAuthorization } from "../agent/lib/replay-auth.ts";
import { reconcileMission } from "../apps/web/lib/tomok/missions/worker.ts";

const envBefore = { ...process.env };
const owner = { principalId: "mission-runtime-owner", principalType: "user", authenticator: "better-auth", issuer: "better-auth" };
const other = { ...owner, principalId: "mission-runtime-other" };
const status = expected => error => error?.status === expected;
const runtime = (id, current = owner, initiator = current) => ({ id, auth: { current, initiator } });
const event = (id, usage) => ({ meta: { id }, data: { turnId: "isolated-turn", stepIndex: 0, sequence: 1, ...(usage ? { usage } : {}) } });
let server, client, db;

before(async () => {
  const [mongo, data] = await Promise.all([MongoMemoryServer.create(), buildProjectImport(fileURLToPath(new URL("../", import.meta.url)))]);
  server = mongo; client = await new MongoClient(server.getUri()).connect(); db = client.db("mission_runtime_test");
  Object.assign(process.env, { NODE_ENV: "development", DATABASE_URL: "test", BETTER_AUTH_SECRET: "isolated-runtime-authentication-secret",
    NEXT_PUBLIC_VERCEL_APP_CLIENT_ID: "test", VERCEL_APP_CLIENT_SECRET: "test", UPSTASH_REDIS_REST_URL: "test", UPSTASH_REDIS_REST_TOKEN: "test",
    TOMOK_MISSION_DISPATCH_SECRET: "isolated-runtime-dispatch-secret", TOMOK_PROJECT_VIEWER_IDS: `${owner.principalId},${other.principalId}`,
    MONGODB_URI: server.getUri(), MONGODB_DATABASE: "mission_runtime_test" });
  await persistProjectImport(db, data);
});
beforeEach(async () => { await Promise.all(["missions", "mission_sessions", "mission_outputs", "replay_chats"].map(name => db.collection(name).deleteMany({}))); });
after(async () => {
  await closeProjectDb(); await client?.close(); await server?.stop();
  for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
  Object.assign(process.env, envBefore);
});

async function boundMission() {
  const { mission } = await createMission({ requestId: randomUUID(), goal: "Isolated test: reconstruct source records without accepting project knowledge." }, owner);
  const sessionId = `wrun_${randomUUID().replaceAll("-", "")}`;
  await db.collection("mission_sessions").insertOne({ _id: sessionId, sessionId, missionId: mission.id, owner: owner.principalId,
    releaseId: mission.releaseId, generation: mission.generation, createdAt: new Date().toISOString() });
  await db.collection("missions").updateOne({ _id: mission.id }, { $set: { currentSessionId: sessionId, status: "running" } });
  const stored = await db.collection("missions").findOne({ _id: mission.id });
  return { mission: stored, session: runtime(sessionId), descriptor: { missionId: stored.id, owner: stored.owner, releaseId: stored.releaseId,
    principal: stored.principal, generation: stored.generation, dispatchId: stored.dispatch.id, sessionId } };
}

test("mission binding removes live tools, external connections and profile memory and fences direct tool calls", async () => {
  const { session, mission } = await boundMission();
  assert.equal((await getSessionMission(session)).id, mission.id);
  await assert.rejects(() => getSessionMission(runtime(session.id, other)), status(403));
  await assert.rejects(() => getSessionMission(runtime(session.id, owner, other)), status(403));
  const missing = runtime("wrun_lost_binding", { ...owner, attributes: { tomokMissionId: mission.id } });
  await assert.rejects(() => getSessionMission(missing), status(403));
  for (const name of ["get_project_evidence", "get_project_memory", "get_schedule_context", "investigate_jet_grouting", "propose_project_memory", "get_weather"]) {
    const { default: resolver, liveTool } = await import(`../agent/tools/${name}.ts`);
    assert.equal(await resolver.events["turn.started"]({}, { session }), null, name);
    await assert.rejects(() => liveTool.execute({}, { session }), status(403), name);
    await assert.rejects(() => resolver.events["turn.started"]({}, { session: missing }), status(403), name);
  }
  for (const name of ["linear", "notion", "sentry"]) {
    const { default: resolver } = await import(`../agent/connections/${name}.ts`);
    assert.equal(await resolver.events["turn.started"]({}, { session }), null, name);
  }
  const { default: memory } = await import("../agent/memory/profile.ts");
  assert.equal(await memory.scope({ session }), null);
});

test("mission mutation tools disappear at the next model step after pause and reject direct calls", async () => {
  const { session, mission } = await boundMission();
  const ordinary = runtime("wrun_ordinary_runtime");
  const inputs = {
    get_archive_mission: {},
    claim_archive_job: { jobId: mission.jobs[0].id, reason: "Read the relevant source identifiers." },
    read_archive_unit: { jobId: mission.jobs[0].id, leaseToken: randomUUID() },
    commit_archive_job: { jobId: mission.jobs[0].id, leaseToken: randomUUID(), facts: [] },
    complete_archive_mission: { summary: "Isolated proposed test report.", connections: [], questions: [], lessons: [] },
    propose_archive_policy: { reason: "The source reader returned empty context cells.", omitEmptyCells: true },
    evaluate_archive_policy: { candidateId: mission.activePolicyId },
  };
  for (const [name, input] of Object.entries(inputs)) {
    const { default: resolver, missionTool } = await import(`../agent/tools/${name}.ts`);
    assert.equal(await resolver.events["step.started"]({}, { session }), missionTool);
    assert.equal(await resolver.events["step.started"]({}, { session: ordinary }), null);
    await assert.rejects(() => missionTool.execute(input, { session: ordinary }), status(403), name);
  }
  await db.collection("missions").updateOne({ _id: mission.id }, { $set: { status: "paused" } });
  for (const [name, input] of Object.entries(inputs)) {
    const { default: resolver, missionTool } = await import(`../agent/tools/${name}.ts`);
    assert.equal(await resolver.events["step.started"]({}, { session }), null, name);
    await assert.rejects(() => missionTool.execute(input, { session }), status(409), name);
  }
  const { missionTool: contextTool } = await import("../agent/tools/get_archive_mission.ts");
  await assert.rejects(() => contextTool.execute({}, { session: ordinary }), status(403));
  await assert.rejects(() => contextTool.execute({}, { session }), status(409));
});

test("completed missions have no tools and can settle their final plain-text response", async () => {
  const { session, mission } = await boundMission();
  await db.collection("missions").updateOne({ _id: mission.id }, { $set: { status: "completed_with_gaps" } });
  for (const name of ["get_archive_mission", "claim_archive_job", "read_archive_unit", "commit_archive_job", "complete_archive_mission", "propose_archive_policy", "evaluate_archive_policy"]) {
    const { default: resolver } = await import(`../agent/tools/${name}.ts`);
    assert.equal(await resolver.events["step.started"]({}, { session }), null, name);
  }
  const { default: replayResolver } = await import("../agent/tools/get_replay_context.ts");
  assert.equal(await replayResolver.events["turn.started"]({}, { session }), null);
  await startMissionModelStep(session, event("final-summary"));
  assert.equal((await db.collection("missions").findOne({ _id: mission.id })).status, "completed_with_gaps");
});

test("mission authentication never falls through after denial and preserves immutable session history", async () => {
  const { session, descriptor } = await boundMission();
  let fallback = 0;
  const signed = withReplayAuthorization([missionDispatchAuth, async () => { fallback++; return owner; }]);
  const headers = { [MISSION_DISPATCH_HEADER]: signMissionDispatch(descriptor, "send") };
  const accepted = await routeAuth(new Request(`http://localhost/eve/v1/session/${session.id}`, { method: "POST", headers }), signed);
  assert.equal(accepted.attributes.tomokMissionId, descriptor.missionId);
  const rejected = await routeAuth(new Request("http://localhost/eve/v1/session/wrun_another", { method: "POST", headers }), signed);
  assert.equal(rejected.status, 403);
  assert.equal(fallback, 0);
  for (const suffix of ["/clear", "/reset"]) {
    const denied = await routeAuth(new Request(`http://localhost/eve/v1/session/${session.id}${suffix}`, { method: "POST" }), withReplayAuthorization([async () => owner]));
    assert.equal(denied.status, 403);
  }
  await db.collection("missions").updateOne({ _id: descriptor.missionId }, { $inc: { generation: 1 }, $set: { status: "paused", currentSessionId: null } });
  const oldSend = await routeAuth(new Request(`http://localhost/eve/v1/session/${session.id}`, { method: "POST", headers }), signed);
  assert.equal(oldSend.status, 403);
  const inspection = await routeAuth(new Request(`http://localhost/eve/v1/session/${session.id}/stream`, { headers: {
    [MISSION_DISPATCH_HEADER]: signMissionDispatch(descriptor, "inspect") } }), signed);
  assert.equal(inspection.attributes.tomokMissionId, descriptor.missionId);
});

test("runtime counters deduplicate persisted events, count actual attempts, and reject stale application writes", async () => {
  const { session, mission } = await boundMission();
  await Promise.all([startMissionModelStep(session, event("start-a")), startMissionModelStep(session, event("start-a"))]);
  await startMissionModelStep(session, event("start-retry"));
  await Promise.all([completeMissionModelStep(session, event("usage-a", { inputTokens: 30, outputTokens: 5 })),
    completeMissionModelStep(session, event("usage-a", { inputTokens: 30, outputTokens: 5 }))]);
  const saved = await db.collection("missions").findOne({ _id: mission.id });
  assert.equal(saved.budget.modelSteps, 2);
  assert.equal(saved.budget.inputTokens, 30);
  assert.equal(saved.budget.outputTokens, 5);
  await assert.rejects(() => updateMission(db, mission, { budget: mission.budget }), status(409));
  await startMissionModelStep(runtime("wrun_ordinary_budget"), event("normal-start"));
  assert.equal((await db.collection("missions").findOne({ _id: mission.id })).budget.modelSteps, 2);
});

test("model-call and provider-token caps pause without completing or discarding committed progress", async () => {
  const first = await boundMission();
  await db.collection("missions").updateOne({ _id: first.mission.id }, { $set: { "budget.maxModelSteps": 1, lastCheckpoint: "Saved source fact" } });
  await startMissionModelStep(first.session, event("only-step"));
  await assert.rejects(() => startMissionModelStep(first.session, event("over-step")), status(409));
  let saved = await db.collection("missions").findOne({ _id: first.mission.id });
  assert.equal(saved.status, "paused");
  assert.equal(saved.report, null);
  assert.equal(saved.jobs.length, first.mission.jobs.length);
  const second = await boundMission();
  await db.collection("missions").updateOne({ _id: second.mission.id }, { $set: { "budget.maxInputTokens": 100 } });
  await completeMissionModelStep(second.session, event("large-usage", { inputTokens: 101, outputTokens: 2 }));
  saved = await db.collection("missions").findOne({ _id: second.mission.id });
  assert.equal(saved.status, "paused");
  assert.equal(saved.budget.inputTokens, 101);
  assert.match(saved.pauseReason, /budget/);
});

const snapshot = state => ({ state, dispatchIds: [], lastEventId: null, lastEventAt: null, latestTurnFailed: false });

test("reconciliation sends a persisted pending delivery after restart between idle-session binding and first send", async () => {
  const { session, mission } = await boundMission();
  let creates = 0, sends = 0;
  const io = {
    create: async () => { creates++; throw new Error("The existing idle session must be reused"); },
    inspect: async () => snapshot("unknown"),
    send: async descriptor => { sends++; assert.equal(descriptor.sessionId, session.id); return { accepted: true, sessionId: session.id }; },
  };
  await closeProjectDb();
  assert.equal((await reconcileMission(mission.id, io)).state, "accepted");
  assert.equal(creates, 0); assert.equal(sends, 1);
  const saved = await db.collection("missions").findOne({ _id: mission.id });
  assert.equal(saved.dispatch.status, "accepted");
  assert.equal(saved.generation, mission.generation);
});

test("terminated eve sessions recover with a new generation while committed output and old scope remain intact", async () => {
  for (const terminal of ["failed", "completed"]) {
    const { session, mission } = await boundMission();
    const unit = mission.manifest.units.find(row => row.name === "Daily-Construction-Report-july12-july17.xlsx");
    const job = mission.jobs.find(row => row.unitId === unit.id);
    const lease = await claimMissionJob({ jobId: job.id, reason: "Establish one committed source output before a terminal runtime failure." }, session);
    const read = await readMissionUnit({ jobId: job.id, leaseToken: lease.leaseToken }, session);
    const record = read.records.find(row => row.role === "data" && row.display.trim());
    const committed = await commitMissionJob({ jobId: job.id, leaseToken: lease.leaseToken, facts: [{ kind: "text", label: "Exact source record",
      value: record.display, citation: { unitId: unit.id, locator: record.locator, quote: record.display } }] }, session);
    const interrupted = mission.jobs.find(row => row.id !== job.id);
    await claimMissionJob({ jobId: interrupted.id, reason: "This second job will be interrupted before publishing." }, session);
    const successor = `wrun_${randomUUID().replaceAll("-", "")}`;
    let creates = 0;
    const io = {
      inspect: async () => snapshot(terminal),
      create: async descriptor => { creates++; assert.equal(descriptor.generation, mission.generation + 1); assert.equal(descriptor.sessionId, undefined); return successor; },
      send: async descriptor => {
        assert.equal(descriptor.sessionId, successor);
        assert.ok(await db.collection("mission_sessions").findOne({ sessionId: successor }));
        return { accepted: true, sessionId: successor };
      },
    };
    assert.equal((await reconcileMission(mission.id, io)).state, "accepted");
    assert.equal(creates, 1);
    const saved = await db.collection("missions").findOne({ _id: mission.id });
    assert.equal(saved.generation, mission.generation + 1);
    assert.equal(saved.currentSessionId, successor);
    assert.equal(saved.jobs.find(row => row.id === job.id).outputId, committed.outputId);
    assert.equal(saved.jobs.find(row => row.id === interrupted.id).status, "pending");
    assert.equal(await db.collection("mission_outputs").countDocuments({ missionId: mission.id }), 1);
    assert.equal(await db.collection("mission_sessions").countDocuments({ missionId: mission.id }), 2);
    await assert.rejects(() => getMissionContext({}, session), status(409));
    assert.equal((await getSessionMission(session)).id, mission.id);
  }
});

test("repeated terminated sessions with no committed progress park after bounded recovery attempts", async () => {
  const { mission } = await boundMission();
  let creates = 0, sends = 0;
  const io = {
    inspect: async () => snapshot("failed"),
    create: async () => { creates++; return `wrun_${randomUUID().replaceAll("-", "")}`; },
    send: async descriptor => { sends++; return { accepted: true, sessionId: descriptor.sessionId }; },
  };
  assert.equal((await reconcileMission(mission.id, io)).state, "accepted");
  assert.equal((await reconcileMission(mission.id, io)).state, "accepted");
  assert.equal((await reconcileMission(mission.id, io)).state, "paused");
  assert.equal((await reconcileMission(mission.id, io)).state, "paused");
  assert.equal(creates, 2); assert.equal(sends, 2);
  const saved = await db.collection("missions").findOne({ _id: mission.id });
  assert.equal(saved.status, "paused");
  assert.match(saved.pauseReason, /no new committed progress/);
  assert.equal(saved.report, null);
  assert.equal(saved.jobs.length, mission.jobs.length);
});
