import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { buildProjectImport } from "../apps/web/lib/tomok/import-data.ts";
import { persistProjectImport, readEvidence } from "../apps/web/lib/tomok/repository.ts";
import { closeProjectDb } from "../apps/web/lib/tomok/db.ts";
import { investigateJetGrouting, getInvestigation } from "../apps/web/lib/tomok/service.ts";
import { getMemoryContext, getProjectMemoryDetail, proposeProjectMemory, reviseProjectMemory } from "../apps/web/lib/tomok/memory-service.ts";
import { startCaseReplay, getCaseReplay, advanceCaseReplay, listCaseReplays } from "../apps/web/lib/tomok/replay-service.ts";

let server, client, db, release, data;
const owner = { principalId: "replay-owner", principalType: "user", authenticator: "better-auth", issuer: "better-auth", attributes: { name: "Isolated Replay Owner" } };
const other = { ...owner, principalId: "replay-other", attributes: { name: "Isolated Replay Other" } };
const status = expected => error => error?.status === expected;
const clientError = error => error?.status >= 400 && error?.status < 500;
const envBefore = { ...process.env };

before(async () => {
  [server, data] = await Promise.all([
    MongoMemoryServer.create(),
    buildProjectImport(fileURLToPath(new URL("../", import.meta.url))),
  ]);
  client = await new MongoClient(server.getUri()).connect();
  db = client.db("replay_service_test");
  Object.assign(process.env, {
    NODE_ENV: "development", DATABASE_URL: "test", BETTER_AUTH_SECRET: "test",
    NEXT_PUBLIC_VERCEL_APP_CLIENT_ID: "test", VERCEL_APP_CLIENT_SECRET: "test",
    UPSTASH_REDIS_REST_URL: "test", UPSTASH_REDIS_REST_TOKEN: "test",
    TOMOK_PROJECT_VIEWER_IDS: `${owner.principalId},${other.principalId}`,
    MONGODB_URI: server.getUri(), MONGODB_DATABASE: "replay_service_test",
  });
});

beforeEach(async () => {
  await Promise.all([
    db.collection("investigations").deleteMany({}),
    db.collection("project_memory").deleteMany({}),
  ]);
  release = await persistProjectImport(db, data);
});

after(async () => {
  await closeProjectDb();
  await client?.close();
  await server?.stop();
  for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
  Object.assign(process.env, envBefore);
});

async function reviewedNote({ title, kind = "interpretation", cutoff = "2026-07-14", source }) {
  const { investigation } = await investigateJetGrouting({ cutoff, question: "Isolated replay test evidence review" }, owner);
  const context = await getMemoryContext(investigation.id, owner);
  const selected = context.evidence.find(source);
  assert.ok(selected, `Missing source for ${title}`);
  const content = {
    kind, title, statement: `${title}: synthetic test knowledge, not project-team acceptance.`,
    validFrom: "2026-07-13", validThrough: null, evidenceIds: [selected.id],
  };
  const { memory } = await proposeProjectMemory({ ...content, investigationId: investigation.id }, owner);
  const reviewed = await reviseProjectMemory(memory.id, { action: "review", expectedRevision: 1, reason: null, content }, owner);
  return { ...reviewed, content };
}

function assertFrozenExcerpts(result) {
  const { investigation } = result;
  const prefix = `/replays/${investigation.id}`;
  assert.equal(result.href, prefix);
  for (const finding of [
    ...investigation.findings,
    ...(investigation.replay.reassessment?.findings ?? []),
    ...(investigation.replay.reassessment?.memoryChecks ?? []),
  ]) {
    for (const citation of finding.citations) assert.ok(citation.href.startsWith(`${prefix}#exhibit-`), citation.href);
  }
  for (const memory of investigation.reviewedMemory ?? []) {
    assert.equal(memory.href, `${prefix}#memory-${memory.id}`);
    assert.ok(!("revisions" in memory));
    for (const citation of memory.citations) assert.ok(citation.href.startsWith(`${prefix}#exhibit-`), citation.href);
  }
  for (const exhibit of investigation.replay.exhibits) {
    assert.equal(exhibit.href, `${prefix}#exhibit-${exhibit.id}`);
    if (exhibit.kind === "field-plan") {
      assert.ok(exhibit.cells.every(cell => /^(E|K|L|O)\d+$/.test(cell.address)));
      if (exhibit.cells.some(cell => /^O\d+$/.test(cell.address))) {
        const source = data.evidence.find(row => exhibit.evidenceIds.some(id => id.endsWith(`:${row._id}`)));
        assert.equal(source?.facts.actualFinishIsForecast, true);
      }
      assert.doesNotMatch(exhibit.text, /49\/392|14%|21%|as of 7\/14\/2026/);
    } else if (exhibit.kind === "mapping") {
      assert.ok(exhibit.cells.every(cell => /^E\d+$/.test(cell.address)));
    } else if (exhibit.kind === "field-observation" && exhibit.label.startsWith("Daily Construction Report")) {
      assert.ok(exhibit.cells.every(cell => /^(B|C|AD)\d+$/.test(cell.address)));
    }
  }
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /"rawCells"|"rawOtherTables"|"worksheets"|"cachedValue"|"relativePath"|\/files\?|\/api\/project-files/);
}

test("replay authentication, ownership, and server-selected cutoffs cannot be overridden", async () => {
  await assert.rejects(() => startCaseReplay({}, null), status(401));
  await assert.rejects(() => startCaseReplay({}, { ...owner, principalId: "outsider" }), status(403));
  for (const input of [null, [], { cutoff: "2026-07-16" }, { stage: "later" }, { owner: other.principalId }, { releaseId: "foreign" }, { requestId: "not-a-uuid" }]) {
    await assert.rejects(() => startCaseReplay(input, owner), clientError);
  }
  const initial = await startCaseReplay({}, owner);
  const id = initial.investigation.id;
  await assert.rejects(() => getCaseReplay(id, null), status(401));
  await assert.rejects(() => getCaseReplay(id, other), status(404));
  await assert.rejects(() => advanceCaseReplay(id, {}, other), status(404));
  await assert.rejects(() => advanceCaseReplay(id, {}, null), status(401));
  await assert.rejects(() => getCaseReplay("not-an-id", owner), status(404));
  for (const input of [{ cutoff: "2026-07-20" }, { previousId: "foreign" }, { reviewedMemory: [] }, null]) {
    await assert.rejects(() => advanceCaseReplay(id, input, owner), clientError);
  }
  const secondOwner = await startCaseReplay({}, other);
  assert.notEqual(secondOwner.investigation.id, id);
});

test("initial replay payload exposes only bounded July 14 evidence and excludes future memory", async () => {
  await reviewedNote({ title: "FUTURE_MEMORY_CANARY", cutoff: "2026-07-16", source: row => row.observedDate === "2026-07-16" });
  await reviewedNote({ title: "HINDSIGHT_MEMORY_CANARY", cutoff: "2026-07-16", source: row => row.observedDate === "2026-07-14" });
  const initial = await startCaseReplay({}, owner);
  const result = initial.investigation;
  assert.equal(result.cutoff, "2026-07-14");
  assert.equal(result.replay.stage, "initial");
  assert.equal(result.replay.reassessment, null);
  assert.match(result.replay.availabilityNote, /undated|historically/i);
  assert.deepEqual(result.replay.progress.map(row => row.observedDate), ["2026-07-13", "2026-07-14"]);
  assert.deepEqual(result.replay.progress.at(-1).jetGrouted, { completed: 49, total: 392 });
  assert.ok(result.replay.exhibits.every(row => row.observedDate === null || row.observedDate <= result.cutoff));
  const serialized = JSON.stringify(initial);
  assert.doesNotMatch(serialized, /55\/392|56\/392|83\/392|90\/392|AD5|AD6|FUTURE_MEMORY_CANARY|HINDSIGHT_MEMORY_CANARY/);
  for (const future of (await readEvidence(db, release, "2026-07-16")).filter(row => row.observedDate > result.cutoff)) {
    assert.ok(!serialized.includes(future._id), `Future evidence identity leaked: ${future.locator.cell}`);
    assert.ok(!serialized.includes(future.text), `Future report leaked: ${future.locator.cell}`);
  }
  assertFrozenExcerpts(initial);
});

test("replay starts are idempotent and remain readable after a connection restart", async () => {
  const [first, retry] = await Promise.all([startCaseReplay({}, owner), startCaseReplay({}, owner)]);
  assert.deepEqual(retry, first);
  assert.equal(await db.collection("investigations").countDocuments({ owner: owner.principalId }), 1);
  await closeProjectDb();
  assert.deepEqual(await getCaseReplay(first.investigation.id, owner), first);
  assert.deepEqual((await getInvestigation(first.investigation.id, owner)).investigation, first.investigation);
});

test("saved case history groups only the caller's replay stages and exposes bounded summaries", async () => {
  await assert.rejects(() => listCaseReplays(null), status(401));
  await assert.rejects(() => listCaseReplays({ ...owner, principalId: "outsider" }), status(403));
  await investigateJetGrouting({ cutoff: "2026-07-14", question: "Ordinary history exclusion" }, owner);
  const initial = await startCaseReplay({}, owner);
  const later = await advanceCaseReplay(initial.investigation.id, {}, owner);
  const foreign = await startCaseReplay({}, other);
  await advanceCaseReplay(foreign.investigation.id, {}, other);
  const history = await listCaseReplays(owner);
  assert.equal(history.hasMore, false);
  assert.equal(history.cases.length, 1);
  assert.equal(history.cases[0].initial.href, initial.href);
  assert.equal(history.cases[0].later.href, later.href);
  assert.equal(history.cases[0].initial.reviewedMemoryCount, 0);
  assert.doesNotMatch(JSON.stringify(history), /exhibits|findings|evidenceIds|49\/392|owner|sourceId/);
  assert.ok(!JSON.stringify(history).includes(foreign.investigation.id));
  for (let i = 0; i < 21; i++) await startCaseReplay({ requestId: randomUUID() }, owner);
  const bounded = await listCaseReplays(owner);
  assert.equal(bounded.cases.length, 20);
  assert.equal(bounded.hasMore, true);
  assert.equal(new Set(bounded.cases.map(item => item.initial.id)).size, 20);
  assert.deepEqual(bounded.cases.map(item => item.initial.createdAt), bounded.cases.map(item => item.initial.createdAt).toSorted().toReversed());
  await closeProjectDb();
  assert.deepEqual(await listCaseReplays(owner), bounded);
  assert.deepEqual(await getCaseReplay(initial.investigation.id, owner), initial);
});

test("memory origin navigation preserves replay routes without sharing the private origin", async () => {
  const initial = await startCaseReplay({}, owner);
  const ordinary = await investigateJetGrouting({ cutoff: "2026-07-14", question: "Ordinary memory origin" }, owner);
  const ordinaryContext = await getMemoryContext(ordinary.investigation.id, owner);
  assert.equal(ordinaryContext.investigation.kind, "investigation");
  assert.equal(ordinaryContext.investigation.href, ordinary.href);
  const context = await getMemoryContext(initial.investigation.id, owner);
  assert.equal(context.investigation.kind, "replay");
  assert.equal(context.investigation.href, initial.href);
  const content = { kind: "mapping", title: "Isolated replay-origin test", statement: "Synthetic mapping used only for navigation testing.",
    validFrom: "2026-07-14", validThrough: null, evidenceIds: [context.evidence.find(row => row.kind === "mapping").id] };
  const { memory } = await proposeProjectMemory({ ...content, investigationId: initial.investigation.id }, owner);
  const detail = await getProjectMemoryDetail(memory.id, owner);
  assert.deepEqual(detail.origin, context.investigation);
  await assert.rejects(() => getMemoryContext(initial.investigation.id, other), status(404));
  await reviseProjectMemory(memory.id, { action: "review", expectedRevision: 1, reason: null, content }, owner);
  assert.equal((await getProjectMemoryDetail(memory.id, other)).origin, null);
  const fresh = await startCaseReplay({ requestId: randomUUID() }, owner);
  assert.deepEqual(fresh.investigation.reviewedMemory.map(note => [note.id, note.revision]), [[memory.id, 2]]);
  assert.deepEqual((await getCaseReplay(initial.investigation.id, owner)).investigation.reviewedMemory, []);
});

test("fresh request IDs capture new reviewed knowledge while each case and its advancement stay frozen", async () => {
  const firstInput = { requestId: randomUUID() };
  const secondInput = { requestId: randomUUID() };
  const first = await startCaseReplay(firstInput, owner);
  const firstLater = await advanceCaseReplay(first.investigation.id, {}, owner);
  assert.deepEqual(first.investigation.reviewedMemory, []);
  assert.deepEqual(firstLater.investigation.reviewedMemory, []);

  const note = await reviewedNote({ title: "New review for a fresh replay", kind: "mapping", source: row => row.kind === "mapping" && row.label.endsWith("!E98") });
  assert.deepEqual(await startCaseReplay(firstInput, owner), first);
  const second = await startCaseReplay(secondInput, owner);
  assert.notEqual(second.investigation.id, first.investigation.id);
  assert.deepEqual(second.investigation.reviewedMemory.map(row => [row.id, row.revision]), [[note.memory.id, 2]]);
  const secondLater = await advanceCaseReplay(second.investigation.id, {}, owner);
  assert.notEqual(secondLater.investigation.id, firstLater.investigation.id);
  assert.equal(firstLater.investigation.replay.reassessment.previousId, first.investigation.id);
  assert.equal(secondLater.investigation.replay.reassessment.previousId, second.investigation.id);
  assert.deepEqual(secondLater.investigation.reviewedMemory.map(row => [row.id, row.revision]), [[note.memory.id, 2]]);

  await reviseProjectMemory(note.memory.id, { action: "flag", expectedRevision: 2, reason: "Isolated review after both replay cases were saved" }, owner);
  assert.deepEqual(await startCaseReplay(firstInput, owner), first);
  assert.deepEqual(await startCaseReplay(secondInput, owner), second);
  assert.deepEqual(await advanceCaseReplay(first.investigation.id, {}, owner), firstLater);
  assert.deepEqual(await advanceCaseReplay(second.investigation.id, {}, owner), secondLater);
  assert.equal(await db.collection("investigations").countDocuments({ owner: owner.principalId, "investigation.replay.stage": { $exists: true } }), 4);
});

test("later replay compares progress, suggests only affected interpretations, and preserves memory and initial history", async () => {
  const mapping = await reviewedNote({ title: "Test reviewed mapping", kind: "mapping", source: row => row.kind === "mapping" && row.label.endsWith("!E98") });
  const interpretation = await reviewedNote({ title: "Test Line M delivery assumption", source: row => row.kind === "field-plan" && row.label.endsWith("!F102") });
  const forecast = await reviewedNote({ title: "Test forecast marker explanation", source: row => row.kind === "field-plan" && row.label.endsWith("!F98") });
  const initial = await startCaseReplay({}, owner);
  assert.equal(initial.investigation.reviewedMemory.length, 3);
  assertFrozenExcerpts(initial);

  const later = await advanceCaseReplay(initial.investigation.id, {}, owner);
  const result = later.investigation;
  assert.notEqual(result.id, initial.investigation.id);
  assert.equal(result.cutoff, "2026-07-16");
  assert.equal(result.replay.stage, "later");
  assert.equal(result.replay.reassessment.previousId, initial.investigation.id);
  assert.equal(result.replay.reassessment.previousCutoff, "2026-07-14");
  assert.deepEqual(result.replay.progress.at(-1).jetGrouted, { completed: 56, total: 392 });
  assert.deepEqual(result.replay.progress.at(-1).lineM, { completed: 28, total: 28 });
  assert.deepEqual(result.replay.progress.at(-1).lineL, { completed: 0, total: 28 });
  const findings = result.replay.reassessment.findings;
  assert.match(findings.find(row => row.id === "replay-production-change").text, /49\/392 to 56\/392.*21\/28 to 28\/28.*0\/28 to 0\/28/);
  assert.match(findings.find(row => row.id === "replay-line-m-review").text, /2026-07-15.*27\/28.*2026-07-16.*28\/28/);
  assert.match(findings.find(row => row.id === "replay-line-l-review").text, /0\/28.*does not establish a missed/i);
  const checks = new Map(result.replay.reassessment.memoryChecks.map(row => [row.memoryId, row]));
  assert.equal(checks.get(mapping.memory.id).disposition, "mapping-retained");
  assert.equal(checks.get(interpretation.memory.id).disposition, "review-suggested");
  assert.equal(checks.get(forecast.memory.id).disposition, "no-specific-conflict");
  for (const note of [mapping, interpretation, forecast]) {
    assert.deepEqual((await getProjectMemoryDetail(note.memory.id, owner)).memory, note.memory);
  }
  assertFrozenExcerpts(later);
  await closeProjectDb();
  assert.deepEqual(await getCaseReplay(initial.investigation.id, owner), initial);
  assert.deepEqual(await getCaseReplay(result.id, owner), later);
});

test("advancement retries reuse the saved later stage after memory revisions change", async () => {
  const note = await reviewedNote({ title: "Retry test mapping", kind: "mapping", source: row => row.kind === "mapping" && row.label.endsWith("!E98") });
  const initial = await startCaseReplay({}, owner);
  const [later, retry] = await Promise.all([
    advanceCaseReplay(initial.investigation.id, {}, owner),
    advanceCaseReplay(initial.investigation.id, {}, owner),
  ]);
  assert.deepEqual(retry, later);
  await reviseProjectMemory(note.memory.id, { action: "flag", expectedRevision: 2, reason: "Isolated explicit human flag after replay" }, owner);
  assert.deepEqual(await advanceCaseReplay(initial.investigation.id, {}, owner), later);
  assert.deepEqual(await getCaseReplay(initial.investigation.id, owner), initial);
  assert.equal(later.investigation.reviewedMemory.find(row => row.id === note.memory.id).revision, 2);
  await assert.rejects(() => advanceCaseReplay(later.investigation.id, {}, owner), clientError);
});

test("ordinary investigations are rejected and an import change blocks only unsaved advancement", async () => {
  const ordinary = await investigateJetGrouting({ cutoff: "2026-07-14", question: "Ordinary investigation" }, owner);
  await assert.rejects(() => getCaseReplay(ordinary.investigation.id, owner), status(404));
  await assert.rejects(() => advanceCaseReplay(ordinary.investigation.id, {}, owner), clientError);
  const initial = await startCaseReplay({}, owner);
  const completedInitial = await startCaseReplay({ requestId: randomUUID() }, owner);
  const savedLater = await advanceCaseReplay(completedInitial.investigation.id, {}, owner);
  const changed = structuredClone(data);
  changed.evidence[0].text += " Isolated changed-import test.";
  const next = await persistProjectImport(db, changed);
  assert.notEqual(next.releaseId, release.releaseId);
  await assert.rejects(() => advanceCaseReplay(initial.investigation.id, {}, owner), status(409));
  assert.deepEqual(await getCaseReplay(initial.investigation.id, owner), initial);
  await closeProjectDb();
  assert.deepEqual(await advanceCaseReplay(completedInitial.investigation.id, {}, owner), savedLater);
  assert.deepEqual(await getCaseReplay(completedInitial.investigation.id, owner), completedInitial);
  assert.equal(savedLater.investigation.releaseId, release.releaseId);
});
