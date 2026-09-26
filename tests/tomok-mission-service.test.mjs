import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { buildProjectImport } from "../apps/web/lib/tomok/import-data.ts";
import { persistProjectImport, PROJECT_ID } from "../apps/web/lib/tomok/repository.ts";
import { closeProjectDb } from "../apps/web/lib/tomok/db.ts";
import {
  authorizeMissionDispatch, authorizeMissionSession, claimMissionJob, commitMissionJob,
  completeMission, createMission, findMissionSession, getMission, getMissionContext,
  getSessionMission, listMissions, missionAction, readMissionUnit, reconcileMissionReportProvenance,
} from "../apps/web/lib/tomok/missions/service.ts";
import { missionHash, requireMission, updateMission } from "../apps/web/lib/tomok/missions/repository.ts";
import { readUnit, validateProposedFacts } from "../apps/web/lib/tomok/missions/source-units.ts";
import { bindMissionSession, descriptorFor, reconcileMission } from "../apps/web/lib/tomok/missions/worker.ts";
import { completeMissionModelStep, startMissionModelStep } from "../apps/web/lib/tomok/missions/model-budget.ts";

let server, client, db, release;
const owner = { principalId: "mission-owner", principalType: "user", authenticator: "better-auth", issuer: "better-auth", attributes: { name: "Isolated Mission Owner" } };
const other = { ...owner, principalId: "mission-other", attributes: { name: "Isolated Mission Other" } };
const envBefore = { ...process.env };
const status = expected => error => error?.status === expected;
const clientError = error => error?.status >= 400 && error?.status < 500;
const freshSessionId = () => `wrun_${randomUUID().replaceAll("-", "")}`;
const runtime = (id, current = owner, initiator = current) => ({ id, auth: { current, initiator } });
const marked = (principal, id) => ({ ...principal, attributes: { ...principal.attributes, tomokMissionId: id } });
const startInput = () => ({ requestId: randomUUID(), goal: "Reconstruct South Portal progress using the bounded three-source case.", cutoff: "2026-07-16", preset: "south-portal-three-source" });
const reportInput = () => ({ summary: "An isolated test account supported by committed source records.", connections: [], questions: [], lessons: [] });

before(async () => {
  const [memoryServer, data] = await Promise.all([MongoMemoryServer.create(), buildProjectImport(fileURLToPath(new URL("../", import.meta.url)))]);
  server = memoryServer;
  client = await new MongoClient(server.getUri()).connect();
  db = client.db("mission_service_test");
  Object.assign(process.env, {
    NODE_ENV: "development", DATABASE_URL: "test", BETTER_AUTH_SECRET: "test",
    NEXT_PUBLIC_VERCEL_APP_CLIENT_ID: "test", VERCEL_APP_CLIENT_SECRET: "test",
    UPSTASH_REDIS_REST_URL: "test", UPSTASH_REDIS_REST_TOKEN: "test",
    TOMOK_PROJECT_VIEWER_IDS: `${owner.principalId},${other.principalId}`,
    MONGODB_URI: server.getUri(), MONGODB_DATABASE: "mission_service_test",
  });
  release = await persistProjectImport(db, data);
});

beforeEach(async () => {
  await Promise.all(["missions", "mission_outputs", "mission_sessions"].map(name => db.collection(name).deleteMany({})));
});

after(async () => {
  await closeProjectDb();
  await client?.close();
  await server?.stop();
  for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
  Object.assign(process.env, envBefore);
});

async function startBound(input = startInput()) {
  const { mission } = await createMission(input, owner);
  const sessionId = freshSessionId();
  await bindMissionSession(db, await requireMission(db, mission.id, owner.principalId), sessionId);
  return { mission, session: runtime(sessionId) };
}

async function claimRead(mission, session, selected) {
  const job = selected ?? mission.jobs.find(job => job.unit.name === "Daily-Construction-Report-july12-july17.xlsx");
  assert.ok(job);
  const claim = await claimMissionJob({ jobId: job.id, reason: "Read this exact source range to establish cited evidence." }, session);
  const read = await readMissionUnit({ jobId: job.id, leaseToken: claim.leaseToken }, session);
  return { job, claim, read };
}

function textFact(read) {
  const record = read.records.find(record => record.role === "data" && record.display.trim() && record.display.length <= 4_000);
  assert.ok(record, "real source unit contains a bounded non-empty data value");
  return { kind: "text", label: "Exact source value in isolated integration test", value: record.display,
    citation: { unitId: read.unit.id, locator: record.locator, quote: record.display } };
}

async function commitRead(readJob, session) {
  return commitMissionJob({ jobId: readJob.job.id, leaseToken: readJob.claim.leaseToken,
    facts: readJob.read.status === "outside-cutoff" ? [] : [textFact(readJob.read)] }, session);
}

test("mission starts enforce project membership, strict inputs, ownership, and idempotent request identity", async () => {
  const input = startInput();
  await assert.rejects(() => createMission(input, null), status(401));
  await assert.rejects(() => createMission(input, { ...owner, principalId: "outside-project" }), status(403));
  for (const extra of [{ owner: other.principalId }, { projectId: "foreign" }, { sourceIds: ["foreign"] }, { sessionId: freshSessionId() }]) {
    await assert.rejects(() => createMission({ ...input, ...extra }, owner), status(422));
  }
  const [first, concurrent] = await Promise.all([createMission(input, owner), createMission(input, owner)]);
  assert.equal(first.mission.id, concurrent.mission.id);
  assert.equal(await db.collection("missions").countDocuments({}), 1);
  assert.equal(first.mission.manifest.sources.length, 8);
  assert.equal(first.mission.manifest.sources.filter(source => source.extraction === "in-scope").length, 3);
  assert.equal(first.mission.jobs.length, 9);
  assert.equal(first.mission.completedJobs, 0);
  assert.deepEqual(first.mission.outputs, []);
  await assert.rejects(() => createMission({ ...input, goal: "Different question using the same request identity." }, owner), status(409));
  await assert.rejects(() => getMission(first.mission.id, other), status(404));
  await assert.rejects(() => getMission(first.mission.id, null), status(401));
  const foreignOwner = await createMission(input, other);
  assert.notEqual(foreignOwner.mission.id, first.mission.id);
  assert.deepEqual((await listMissions(owner)).missions.map(mission => mission.id), [first.mission.id]);
  assert.doesNotMatch(JSON.stringify(first), /"principal"|"owner"|"currentSessionId"|"activeLease"|"leaseToken"/);
  await closeProjectDb();
  assert.deepEqual(await createMission(input, owner), first);
  await db.collection("missions").updateOne({ _id: first.mission.id }, { $set: { projectId: "foreign-project" } });
  await assert.rejects(() => getMission(first.mission.id, owner), status(404));
  assert.deepEqual((await listMissions(owner)).missions, []);
});

test("mission inventory must match the active registered source hashes", async () => {
  const source = await db.collection("project_sources").findOne({ projectId: PROJECT_ID, releaseId: release.releaseId });
  assert.ok(source);
  await db.collection("project_sources").updateOne({ _id: source._id }, { $set: { sha256: "0".repeat(64) } });
  try {
    await assert.rejects(() => createMission(startInput(), owner), status(409));
    assert.equal(await db.collection("missions").countDocuments({}), 0);
  } finally {
    await db.collection("project_sources").updateOne({ _id: source._id }, { $set: { sha256: source.sha256 } });
  }
});

test("saved history is bounded and does not reveal another owner's missions or worker credentials", async () => {
  for (let index = 0; index < 22; index++) await createMission(startInput(), owner);
  const foreign = await createMission(startInput(), other);
  const history = await listMissions(owner);
  assert.equal(history.missions.length, 20);
  assert.equal(history.hasMore, true);
  assert.ok(!history.missions.some(mission => mission.id === foreign.mission.id));
  assert.doesNotMatch(JSON.stringify(history), /"principal"|"owner"|"currentSessionId"|"dispatch"|"manifest"/);
});

test("mission sessions and dispatch operations require their bound owner, generation, and source release", async () => {
  const { mission, session } = await startBound();
  const binding = await findMissionSession(session.id);
  assert.equal(binding.missionId, mission.id);
  assert.equal((await authorizeMissionSession(session.id, owner)).attributes.tomokMissionId, mission.id);
  await assert.rejects(() => authorizeMissionSession(session.id, other), status(403));
  await assert.rejects(() => getSessionMission(runtime(session.id, other, owner)), status(403));
  await assert.rejects(() => getSessionMission(runtime(session.id, owner, other)), status(403));
  await assert.rejects(() => getSessionMission(runtime(session.id, marked(owner, "f".repeat(32)))), status(403));
  await assert.rejects(() => getSessionMission(runtime(freshSessionId(), marked(owner, mission.id))), status(403));
  await assert.rejects(() => getMissionContext({}, runtime(freshSessionId())), status(403));
  const current = await requireMission(db, mission.id);
  const descriptor = descriptorFor(current);
  assert.equal((await authorizeMissionDispatch({ ...descriptor, operation: "send" })).principalId, owner.principalId);
  for (const patch of [{ generation: 99 }, { releaseId: "foreign" }, { sessionId: freshSessionId() }, { dispatchId: randomUUID() }]) {
    await assert.rejects(() => authorizeMissionDispatch({ ...descriptor, ...patch, operation: "send" }), clientError);
  }
  const second = await createMission(startInput(), owner);
  const secondDocument = await requireMission(db, second.mission.id);
  await assert.rejects(() => bindMissionSession(db, secondDocument, session.id), status(409));
  await missionAction(mission.id, { action: "pause", requestId: randomUUID() }, owner);
  await assert.rejects(() => authorizeMissionDispatch({ ...descriptor, operation: "send" }), status(403));
  assert.equal((await authorizeMissionDispatch({ ...descriptor, operation: "cancel" })).principalId, owner.principalId);
});

test("real source jobs validate exact quotes, publish once, and survive reconnect without repeating work", async () => {
  const { mission, session } = await startBound();
  const source = await claimRead(mission, session);
  assert.equal(source.read.unit.id, source.job.unitId);
  assert.equal(source.read.unit.releaseId, release.releaseId);
  const firstLease = source.claim.leaseToken;
  assert.equal((await claimMissionJob({ jobId: source.job.id, reason: "Retry the same claim after a response loss." }, session)).leaseToken, firstLease);
  const otherJob = mission.jobs.find(job => job.id !== source.job.id);
  await assert.rejects(() => claimMissionJob({ jobId: otherJob.id, reason: "Attempt concurrent work before finishing the current unit." }, session), status(409));
  const fact = textFact(source.read);
  await assert.rejects(() => commitMissionJob({ jobId: source.job.id, leaseToken: firstLease, facts: [{ ...fact, citation: { ...fact.citation, quote: "An invented value absent from the pinned source" } }] }, session));
  await assert.rejects(() => commitMissionJob({ jobId: source.job.id, leaseToken: firstLease, facts: [{ ...fact, citation: { ...fact.citation, unitId: "f".repeat(32) } }] }, session));
  assert.equal((await getMission(mission.id, owner)).mission.outputs.length, 0);
  assert.equal(await db.collection("mission_outputs").countDocuments({}), 0);
  const result = await commitRead(source, session);
  assert.equal(result.committed, true);
  assert.equal(result.facts[0].reviewStatus, "unreviewed");
  assert.equal(result.facts[0].validation, "citation-and-value");
  assert.equal(result.facts[0].href, source.read.records.find(record => record.locator === fact.citation.locator).href);
  const retry = await commitRead(source, session);
  assert.equal(retry.alreadyCompleted, true);
  assert.equal(retry.outputId, result.outputId);
  await closeProjectDb();
  const detail = (await getMission(mission.id, owner)).mission;
  assert.equal(detail.completedJobs, 1);
  assert.equal(detail.outputs.length, 1);
  assert.equal(await db.collection("mission_outputs").countDocuments({}), 1);
  assert.equal((await claimMissionJob({ jobId: source.job.id, reason: "Restart should skip the committed source range." }, session)).alreadyCompleted, true);
});

test("unpublished attempt output remains invisible and stale checkpoint writes cannot restore ownership", async () => {
  const { mission, session } = await startBound();
  const source = await claimRead(mission, session);
  const result = await commitRead(source, session);
  const output = await db.collection("mission_outputs").findOne({ _id: result.outputId });
  const orphanId = "e".repeat(32);
  await db.collection("mission_outputs").insertOne({ ...output, _id: orphanId, facts: [{ ...output.facts[0], id: "orphan-fact", label: "Unpublished attempt must remain invisible" }] });
  const stale = await requireMission(db, mission.id);
  await missionAction(mission.id, { action: "pause", requestId: randomUUID() }, owner);
  await assert.rejects(() => updateMission(db, stale, { status: "running", currentSessionId: session.id }), status(409));
  await closeProjectDb();
  const detail = (await getMission(mission.id, owner)).mission;
  assert.equal(detail.status, "paused");
  assert.equal(detail.outputs.length, 1);
  assert.doesNotMatch(JSON.stringify(detail), /orphan-fact|Unpublished attempt must remain invisible/);
  assert.equal(await db.collection("mission_outputs").countDocuments({}), 2);
});

test("expired leases and pause/resume replace worker authority while preserving committed output", async () => {
  const { mission, session } = await startBound();
  const committed = await claimRead(mission, session);
  await commitRead(committed, session);
  const nextJob = mission.jobs.find(job => job.id !== committed.job.id && job.unit.kind === "workbook-range");
  const source = await claimRead(mission, session, nextJob);
  await db.collection("missions").updateOne({ _id: mission.id }, { $set: { "activeLease.expiresAt": new Date(Date.now() - 1_000).toISOString() } });
  await assert.rejects(() => readMissionUnit({ jobId: source.job.id, leaseToken: source.claim.leaseToken }, session), status(409));
  const replacement = await claimMissionJob({ jobId: source.job.id, reason: "Recover a source range after the previous lease expired." }, session);
  assert.notEqual(replacement.leaseToken, source.claim.leaseToken);
  await assert.rejects(() => commitRead(source, session), status(409));
  const pauseInput = { action: "pause", requestId: randomUUID() };
  const paused = await missionAction(mission.id, pauseInput, owner);
  const pausedAgain = await missionAction(mission.id, pauseInput, owner);
  assert.equal(pausedAgain.mission.generation, paused.mission.generation);
  assert.equal(paused.mission.outputs.length, 1);
  await assert.rejects(() => commitMissionJob({ jobId: source.job.id, leaseToken: replacement.leaseToken, facts: [textFact(source.read)] }, session), status(409));
  const resumeInput = { action: "resume", requestId: randomUUID() };
  const resumed = await missionAction(mission.id, resumeInput, owner);
  assert.equal((await missionAction(mission.id, resumeInput, owner)).mission.generation, resumed.mission.generation);
  assert.equal(resumed.mission.status, "queued");
  await assert.rejects(() => getMissionContext({}, session), status(409));
  const newSession = runtime(freshSessionId());
  await bindMissionSession(db, await requireMission(db, mission.id), newSession.id);
  const recovered = await claimRead(resumed.mission, newSession, resumed.mission.jobs.find(job => job.id === source.job.id));
  await commitRead(recovered, newSession);
  assert.equal((await getMission(mission.id, owner)).mission.outputs.length, 2);
  await assert.rejects(() => missionAction(mission.id, { action: "pause", requestId: randomUUID() }, other), status(404));
});

test("an expired third attempt persists its failed outcome and clears the lease before rejecting a reclaim", async () => {
  const { mission, session } = await startBound();
  const job = mission.jobs[0];
  const claim = await claimMissionJob({ jobId: job.id, reason: "Read a source range that will exhaust its bounded attempts." }, session);
  await db.collection("missions").updateOne({ _id: mission.id }, {
    $set: { "jobs.0.attempt": 3, "budget.attempts": 3, "activeLease.expiresAt": new Date(Date.now() - 1_000).toISOString() },
  });
  const stale = await requireMission(db, mission.id);
  await assert.rejects(() => claimMissionJob({ jobId: job.id, reason: "Retry this source after its final lease expired." }, session), status(409));
  const settled = await requireMission(db, mission.id);
  assert.equal(settled.jobs[0].status, "failed");
  assert.equal(settled.jobs[0].attempt, 3);
  assert.match(settled.jobs[0].lastError, /lease expired/);
  assert.equal(settled.activeLease, null);
  assert.equal(settled.budget.attempts, 3);
  assert.equal((await getMission(mission.id, owner)).mission.failedJobs, 1);
  await assert.rejects(() => updateMission(db, stale, { jobs: stale.jobs, activeLease: stale.activeLease }), status(409));
  await assert.rejects(() => readMissionUnit({ jobId: job.id, leaseToken: claim.leaseToken }, session), status(409));
  const next = await claimMissionJob({ jobId: mission.jobs[1].id, reason: "Continue independent eligible work after recording the failed range." }, session);
  assert.equal(next.jobId, mission.jobs[1].id);
  assert.equal((await requireMission(db, mission.id)).jobs[0].status, "failed");
});

test("completion requires settled ranges and committed report references; gaps and lessons remain unreviewed", async () => {
  const { mission, session } = await startBound();
  await assert.rejects(() => completeMission(reportInput(), session), status(409));
  const committed = [];
  for (const job of mission.jobs) committed.push(await commitRead(await claimRead(mission, session, job), session));
  const facts = committed.flatMap(result => result.facts ?? []);
  assert.ok(facts.length >= 2);
  await assert.rejects(() => completeMission({ ...reportInput(), lessons: [{ text: "This cites a foreign output.", factIds: ["foreign-fact"] }] }, session), status(422));
  await assert.rejects(() => completeMission({ ...reportInput(), connections: [{ leftFactId: facts[0].id, rightFactId: facts[1].id, relation: "same-identifier", reason: "Text facts cannot establish identical source identifiers." }] }, session), status(422));
  // Simulate an immutable output saved before the formula-label guard existed.
  const dayJob = mission.jobs.find(job => job.unit.name === "Daily-Construction-Report-july12-july17.xlsx");
  const day = await readUnit(dayJob.unit), dateCell = day.records.find(record => record.locator.endsWith("!C3"));
  const legacyDate = validateProposedFacts(day, [{ kind: "date", label: "Observed report date", value: dateCell.observedDate,
    dateSemantics: "observed", citation: { unitId: day.unit.id, locator: dateCell.locator, quote: dateCell.display } }])[0];
  legacyDate.label = "Formula-derived report date";
  legacyDate.id = missionHash([legacyDate.id, legacyDate.label]);
  const legacyId = committed.find(result => result.jobId === dayJob.id).outputId;
  await db.collection("mission_outputs").updateOne({ _id: legacyId }, { $push: { facts: legacyDate } });
  const preservedLegacy = await db.collection("mission_outputs").findOne({ _id: legacyId });
  const report = await completeMission({ ...reportInput(),
    connections: [{ leftFactId: facts[0].id, rightFactId: facts[1].id, relation: "candidate-mapping", reason: "A test candidate to inspect; no human approval is asserted." }],
    lessons: [{ text: "A draft lesson grounded in the cited source fact.", factIds: [facts[0].id] }],
    questions: ["Does the proposed source relationship hold under project review?"],
  }, session);
  assert.equal(report.mission.status, "completed_with_gaps");
  assert.equal(report.report.reviewStatus, "unreviewed");
  assert.equal(report.report.connections[0].status, "proposed");
  assert.ok(report.report.scopeNotes.some(note => /5 other registered files were inventoried only/.test(note)));
  assert.ok(report.report.scopeNotes.some(note => /unreviewed model interpretations/.test(note)));
  assert.ok(report.report.scopeNotes.some(note => /Zero completed counts.*First observed completion.*Same-day predrilling.*controlling P6 completion basis/.test(note)));
  assert.ok(report.report.questions.some(question => question.includes("!C3") && /literal|formula/i.test(question)));
  assert.deepEqual(await db.collection("mission_outputs").findOne({ _id: legacyId }), preservedLegacy);
  assert.equal((await getMission(mission.id, owner)).mission.outputs.length, 9);
  assert.equal(await db.collection("project_memory").countDocuments({}), 0);
});

async function legacyCompletedReport({ unsupported = true } = {}) {
  const { mission } = await startBound();
  const current = await requireMission(db, mission.id);
  const unit = current.manifest.units.find(unit => unit.label.endsWith("!D102:R102"));
  assert.ok(unit);
  const source = await readUnit(unit), cell = source.records.find(record => record.locator.endsWith("!K102"));
  const [fact] = validateProposedFacts(source, [{ kind: "date", label: "Current start", value: "2026-07-06",
    dateSemantics: "planned", citation: { unitId: unit.id, locator: cell.locator, quote: cell.display } }]);
  // The isolated fixture models an old immutable output, before the formula-label guard.
  if (unsupported) fact.label = "Current start (formula-derived)";
  const job = current.jobs.find(job => job.unitId === unit.id), outputId = missionHash([current.id, job.id, "legacy"]);
  const output = { _id: outputId, missionId: current.id, jobId: job.id, unitId: unit.id,
    releaseId: current.releaseId, policyVersion: job.policyVersion, generation: current.generation,
    attempt: 1, createdAt: current.createdAt, status: "processed", facts: [fact],
    metrics: { inputBytes: 1, records: source.records.length, facts: 1 }, warnings: source.warnings };
  await db.collection("mission_outputs").insertOne(output);
  // An unpublished attempt must not add duplicate questions or change the audit scope.
  await db.collection("mission_outputs").insertOne({ ...output, _id: missionHash([outputId, "orphan"]) });
  const report = { ...reportInput(), questions: ["Which planning version applies to these dates?"],
    createdAt: current.createdAt, reviewStatus: "unreviewed", scopeNotes: ["This is an isolated legacy report fixture."] };
  const priorRevision = { id: missionHash([current.id, "prior-report"]), recordedAt: current.createdAt,
    reason: "Earlier isolated report revision", report: { ...report, summary: "A previous isolated report preserved before this audit." } };
  const saved = await updateMission(db, current, { status: "completed_with_gaps", report,
    reportRevisions: [priorRevision], activeLease: null, jobs: current.jobs.map(item => item.id === job.id
      ? { ...item, status: "completed", outputId, attempt: 1 }
      : { ...item, status: "failed", attempt: 3, lastError: "Outside this isolated reconciliation fixture" }) });
  return { saved, report, priorRevision };
}

test("report provenance reconciliation preserves the original report and immutable facts, and is idempotent", async () => {
  const fixture = await legacyCompletedReport();
  // Existing report text, including duplicate questions, is preserved byte-for-byte.
  const report = { ...fixture.report, questions: [...fixture.report.questions, ...fixture.report.questions] };
  const before = await updateMission(db, fixture.saved, { report });
  const { priorRevision } = fixture;
  const outputs = await db.collection("mission_outputs").find({}).sort({ _id: 1 }).toArray();
  const result = await reconcileMissionReportProvenance(before.id, owner);
  assert.equal(result.changed, true);
  assert.equal(result.addedQuestions.length, 1);
  assert.match(result.addedQuestions[0], /2026 Master Schedule!K102.*literal date value and no formula/);
  const saved = await requireMission(db, before.id);
  assert.equal(saved.revision, before.revision + 1);
  assert.deepEqual(saved.report, { ...report, questions: [...report.questions, ...result.addedQuestions] });
  assert.equal(saved.report.reviewStatus, "unreviewed");
  assert.equal(saved.reportRevisions.length, 2);
  assert.deepEqual(saved.reportRevisions[0], priorRevision);
  assert.deepEqual(saved.reportRevisions[1].report, report);
  assert.equal(saved.reportRevisions[1].id, result.reportRevisionId);
  assert.match(saved.reportRevisions[1].reason, /formula provenance/);
  assert.ok(Number.isFinite(Date.parse(saved.reportRevisions[1].recordedAt)));
  assert.deepEqual(await db.collection("mission_outputs").find({}).sort({ _id: 1 }).toArray(), outputs);
  const repeat = await reconcileMissionReportProvenance(before.id, owner);
  assert.equal(repeat.changed, false);
  assert.deepEqual(repeat.addedQuestions, []);
  assert.equal(repeat.reportRevisionId, null);
  assert.deepEqual(await requireMission(db, before.id), saved);
  await assert.rejects(() => updateMission(db, before, { report }), status(409));
});

test("report provenance reconciliation requires the owner and rejects active or unfinished missions without writes", async () => {
  const { saved: completed } = await legacyCompletedReport();
  await assert.rejects(() => reconcileMissionReportProvenance(completed.id, null), status(401));
  await assert.rejects(() => reconcileMissionReportProvenance(completed.id, other), status(404));
  for (const patch of [
    { status: "running" }, { report: null },
    { activeLease: { jobId: completed.jobs[0].id, token: randomUUID(), generation: completed.generation, expiresAt: new Date(Date.now() + 60_000).toISOString() } },
    { jobs: completed.jobs.map((job, index) => index === 0 ? { ...job, status: "pending" } : job) },
  ]) {
    const current = await requireMission(db, completed.id);
    const before = await updateMission(db, current, { status: completed.status, report: completed.report,
      activeLease: completed.activeLease, jobs: completed.jobs, ...patch });
    await assert.rejects(() => reconcileMissionReportProvenance(completed.id, owner), status(409));
    assert.deepEqual(await requireMission(db, completed.id), before);
  }
});

test("concurrent report provenance reconciliation records exactly one audit revision", async () => {
  const { saved: before } = await legacyCompletedReport();
  const results = await Promise.allSettled([
    reconcileMissionReportProvenance(before.id, owner), reconcileMissionReportProvenance(before.id, owner),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled" && result.value.changed).length, 1);
  for (const result of results) if (result.status === "rejected") assert.equal(result.reason.status, 409);
  const saved = await requireMission(db, before.id);
  assert.equal(saved.revision, before.revision + 1);
  assert.equal(saved.reportRevisions.length, before.reportRevisions.length + 1);
  assert.equal(saved.report.questions.length, before.report.questions.length + 1);
  assert.equal((await reconcileMissionReportProvenance(before.id, owner)).changed, false);
});

test("report provenance reconciliation does not revise a report with supported labels", async () => {
  const { saved: before } = await legacyCompletedReport({ unsupported: false });
  const result = await reconcileMissionReportProvenance(before.id, owner);
  assert.equal(result.changed, false);
  assert.deepEqual(result.addedQuestions, []);
  assert.deepEqual(await requireMission(db, before.id), before);
});

test("failed source outcomes remain disclosed and explicit retry creates a new bounded generation", async () => {
  const { mission, session } = await startBound();
  const current = await requireMission(db, mission.id);
  await updateMission(db, current, { jobs: current.jobs.map(job => ({ ...job, status: "failed", attempt: 3, lastError: "Isolated source reader failure" })) });
  const completed = await completeMission(reportInput(), session);
  assert.equal(completed.mission.status, "completed_with_gaps");
  assert.equal(completed.report.questions.length, mission.jobs.length);
  assert.ok(completed.report.questions.every(question => question.includes("Unprocessed range:")));
  const retryInput = { action: "retry", requestId: randomUUID() };
  const retried = await missionAction(mission.id, retryInput, owner);
  assert.equal(retried.mission.report, null);
  assert.ok(retried.mission.jobs.every(job => job.status === "pending"));
  assert.equal((await missionAction(mission.id, retryInput, owner)).mission.generation, retried.mission.generation);
  await assert.rejects(() => getMissionContext({}, session), status(409));
});

test("ambiguous dispatch acceptance reconciles the durable inbox without sending work twice", async () => {
  const { mission } = await createMission(startInput(), owner);
  const sessionId = freshSessionId();
  const accepted = [];
  let creates = 0, sends = 0;
  const io = {
    create: async () => { creates++; return sessionId; },
    send: async (descriptor, id) => { sends++; assert.equal(descriptor.sessionId, sessionId); accepted.push(id); throw new Error("Response lost after durable acceptance"); },
    inspect: async () => ({ state: "running", dispatchIds: accepted, lastEventId: null, lastEventAt: null, latestTurnFailed: false }),
  };
  assert.equal((await reconcileMission(mission.id, io)).state, "retry-pending");
  assert.equal((await reconcileMission(mission.id, io)).state, "dispatching");
  await db.collection("missions").updateOne({ _id: mission.id }, { $set: { "dispatch.leaseUntil": new Date(Date.now() - 1_000).toISOString() } });
  await closeProjectDb();
  assert.equal((await reconcileMission(mission.id, io)).state, "running");
  assert.equal(creates, 1);
  assert.equal(sends, 1);
  assert.equal((await getMission(mission.id, owner)).mission.dispatch.status, "accepted");
  assert.equal(await db.collection("mission_sessions").countDocuments({}), 1);
});

test("a late delivery response cannot restart a mission paused during send", async () => {
  const { mission } = await createMission(startInput(), owner);
  const io = {
    create: async () => freshSessionId(),
    inspect: async () => { throw new Error("No inspection is needed on first dispatch"); },
    send: async () => { await missionAction(mission.id, { action: "pause", requestId: randomUUID() }, owner); return { accepted: true }; },
  };
  await reconcileMission(mission.id, io);
  const saved = await requireMission(db, mission.id);
  assert.equal(saved.status, "paused");
  assert.equal(saved.currentSessionId, null);
  assert.equal(saved.dispatch.status, "pending");
  assert.equal((await reconcileMission(mission.id, io)).state, "paused");
});

test("retrying an unpublished immutable attempt with different facts cannot publish or overwrite it", async () => {
  const { mission, session } = await startBound();
  const source = await claimRead(mission, session);
  const proposed = textFact(source.read);
  const originalFacts = validateProposedFacts(source.read, [proposed]);
  const outputId = missionHash([mission.id, source.job.id, source.claim.leaseToken]);
  await db.collection("mission_outputs").insertOne({
    _id: outputId, missionId: mission.id, jobId: source.job.id, unitId: source.job.unitId,
    releaseId: mission.releaseId, policyVersion: source.job.policyVersion, generation: mission.generation,
    attempt: 1, createdAt: new Date().toISOString(), status: "processed", facts: originalFacts,
    metrics: { inputBytes: 1, records: source.read.records.length, facts: 1 }, warnings: source.read.warnings,
  });
  assert.equal((await getMission(mission.id, owner)).mission.outputs.length, 0);
  await assert.rejects(() => commitMissionJob({ jobId: source.job.id, leaseToken: source.claim.leaseToken,
    facts: [{ ...proposed, label: "Different interpretation from the same exact quoted value" }] }, session), status(409));
  assert.equal((await getMission(mission.id, owner)).mission.outputs.length, 0);
  assert.deepEqual((await db.collection("mission_outputs").findOne({ _id: outputId })).facts, originalFacts);
  const result = await commitRead(source, session);
  assert.equal(result.outputId, outputId);
  assert.deepEqual(result.facts, originalFacts);
  assert.equal((await getMission(mission.id, owner)).mission.outputs.length, 1);
  assert.equal(await db.collection("mission_outputs").countDocuments({}), 1);
});

test("matching identifiers from two committed attempts of one source cannot become a cross-source connection", async () => {
  const { mission, session } = await startBound();
  const source = await claimRead(mission, session, mission.jobs.find(job => job.unit.kind === "xer-neighborhood"));
  const activityIdentifier = source.read.records.find(record => record.role === "data" && record.locator.endsWith(":task_code"));
  assert.ok(activityIdentifier);
  const fact = { kind: "identifier", label: "First extraction of the P6 activity code", value: activityIdentifier.display,
    citation: { unitId: source.read.unit.id, locator: activityIdentifier.locator, quote: activityIdentifier.display } };
  const result = await commitMissionJob({ jobId: source.job.id, leaseToken: source.claim.leaseToken,
    facts: [fact],
  }, session);
  // Seed an independently validated earlier/later attempt, as retained output history may contain both.
  const repeatedFacts = validateProposedFacts(source.read, [{ ...fact, label: "Reprocessed P6 activity code" }]);
  const priorOutput = await db.collection("mission_outputs").findOne({ _id: result.outputId });
  const nextJobId = missionHash([mission.id, "same-source-second-attempt"]);
  const nextOutputId = missionHash([mission.id, "same-source-second-output"]);
  await db.collection("mission_outputs").insertOne({ ...priorOutput, _id: nextOutputId, jobId: nextJobId, facts: repeatedFacts });
  assert.notEqual(result.facts[0].id, repeatedFacts[0].id);
  assert.equal(result.facts[0].value, repeatedFacts[0].value);
  const current = await requireMission(db, mission.id);
  const committedJob = current.jobs.find(job => job.id === source.job.id);
  await updateMission(db, current, { jobs: [
    ...current.jobs.map(job => job.status === "completed" ? job : { ...job, status: "failed", lastError: "Isolated test leaves other ranges unresolved" }),
    { ...committedJob, id: nextJobId, outputId: nextOutputId },
  ] });
  await assert.rejects(() => completeMission({ ...reportInput(), connections: [{
    leftFactId: result.facts[0].id, rightFactId: repeatedFacts[0].id,
    relation: "same-identifier", reason: "Both identifiers occur in one file and cannot prove a cross-source connection.",
  }] }, session), error => error?.status === 422 && /two different source files/.test(error.message));
  assert.equal((await getMission(mission.id, owner)).mission.report, null);
});

test("model step events count once, reaching a cap pauses work, and explicit resume grants a fresh bounded period", async () => {
  const { mission, session } = await startBound();
  await db.collection("missions").updateOne({ _id: mission.id }, { $set: { "budget.maxModelSteps": 2, "budget.maxInputTokens": 100, "budget.maxOutputTokens": 50 } });
  const event = (id, index) => ({ meta: { id }, data: { turnId: "isolated-model-turn", stepIndex: index, sequence: index } });
  const first = event("first-step", 0);
  await startMissionModelStep(session, first);
  await startMissionModelStep(session, first);
  assert.equal((await requireMission(db, mission.id)).budget.modelSteps, 1);
  const usage = { ...event("first-usage", 0), data: { ...first.data, usage: { inputTokens: 8.9, outputTokens: 3.9 } } };
  await completeMissionModelStep(session, usage);
  await completeMissionModelStep(session, usage);
  let saved = await requireMission(db, mission.id);
  assert.equal(saved.budget.inputTokens, 8);
  assert.equal(saved.budget.outputTokens, 3);
  await startMissionModelStep(session, event("second-step", 1));
  await assert.rejects(() => startMissionModelStep(session, event("over-cap-step", 2)), status(409));
  saved = await requireMission(db, mission.id);
  assert.equal(saved.status, "paused");
  assert.equal(saved.budget.modelSteps, 2);
  assert.match(saved.pauseReason, /model-call or provider-token budget/);
  assert.equal(saved.report, null);
  const resume = { action: "resume", requestId: randomUUID() };
  const resumed = await missionAction(mission.id, resume, owner);
  const replayedResume = await missionAction(mission.id, resume, owner);
  assert.deepEqual(replayedResume.mission.budget, resumed.mission.budget);
  assert.equal(resumed.mission.budget.maxModelSteps, 62);
  assert.equal(resumed.mission.budget.maxInputTokens, 500_008);
  assert.equal(resumed.mission.budget.maxOutputTokens, 30_003);
  const replacement = runtime(freshSessionId());
  await bindMissionSession(db, await requireMission(db, mission.id), replacement.id);
  await assert.rejects(() => startMissionModelStep(session, event("stale-worker-step", 3)), status(409));
  await startMissionModelStep(replacement, event("resumed-worker-step", 3));
  saved = await requireMission(db, mission.id);
  assert.equal(saved.budget.modelSteps, 3);
  assert.notEqual(saved.status, "paused");
});

test("provider token usage is durable and deduplicated and crossing a cap pauses without publishing a report", async () => {
  const { mission, session } = await startBound();
  await db.collection("missions").updateOne({ _id: mission.id }, { $set: { "budget.maxInputTokens": 10, "budget.maxOutputTokens": 20 } });
  const event = { meta: { id: "provider-usage" }, data: { turnId: "isolated-provider-turn", stepIndex: 0, sequence: 0, usage: { inputTokens: 12, outputTokens: 4 } } };
  await completeMissionModelStep(session, event);
  await closeProjectDb();
  await completeMissionModelStep(session, event);
  const saved = await requireMission(db, mission.id);
  assert.equal(saved.status, "paused");
  assert.equal(saved.budget.inputTokens, 12);
  assert.equal(saved.budget.outputTokens, 4);
  assert.equal(saved.report, null);
  assert.equal((await getMission(mission.id, owner)).mission.outputs.length, 0);
  await assert.rejects(() => startMissionModelStep(session, { meta: { id: "after-token-limit" }, data: { turnId: "isolated-provider-turn", stepIndex: 1, sequence: 1 } }), status(409));
  const resumed = await missionAction(mission.id, { action: "resume", requestId: randomUUID() }, owner);
  assert.equal(resumed.mission.budget.maxInputTokens, 500_012);
  assert.equal(resumed.mission.budget.maxOutputTokens, 30_004);
});
