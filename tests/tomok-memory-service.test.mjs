import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { buildProjectImport } from "../apps/web/lib/tomok/import-data.ts";
import { persistProjectImport, readEvidence } from "../apps/web/lib/tomok/repository.ts";
import { closeProjectDb } from "../apps/web/lib/tomok/db.ts";
import { investigateJetGrouting, getInvestigation } from "../apps/web/lib/tomok/service.ts";
import { getProjectMemory, getMemoryContext, getProjectMemoryDetail, proposeProjectMemory, reviseProjectMemory, listProjectMemory } from "../apps/web/lib/tomok/memory-service.ts";
let server, client, db, release, data;
const owner = { principalId: "owner", principalType: "user", authenticator: "better-auth", issuer: "better-auth", attributes: { name: "Actual Owner" } };
const reviewer = { ...owner, principalId: "reviewer", attributes: { name: "Actual Reviewer" } };
const status = n => error => error?.status === n;
const question = { cutoff: "2026-07-16", question: "Review jet grouting progress" };
const envBefore = { ...process.env };
before(async () => {
  [server, data] = await Promise.all([MongoMemoryServer.create(), buildProjectImport(fileURLToPath(new URL("../", import.meta.url)))]);
  client = await new MongoClient(server.getUri()).connect();
  db = client.db("memory_service_test");
  release = await persistProjectImport(db, data);
  Object.assign(process.env, { NODE_ENV: "development", DATABASE_URL: "test", BETTER_AUTH_SECRET: "test", NEXT_PUBLIC_VERCEL_APP_CLIENT_ID: "test", VERCEL_APP_CLIENT_SECRET: "test", UPSTASH_REDIS_REST_URL: "test", UPSTASH_REDIS_REST_TOKEN: "test", TOMOK_PROJECT_VIEWER_IDS: "owner,reviewer", MONGODB_URI: server.getUri(), MONGODB_DATABASE: "memory_service_test" });
});
after(async () => {
  await closeProjectDb(); await client?.close(); await server?.stop();
  for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
  Object.assign(process.env, envBefore);
});
async function draft(cutoff = question.cutoff, title = "Test interpretation") {
  const { investigation } = await investigateJetGrouting({ ...question, cutoff }, owner);
  const context = await getMemoryContext(investigation.id, owner);
  const chosen = context.evidence.find(row => row.observedDate === cutoff);
  assert.ok(chosen);
  const content = { kind: "interpretation", title, statement: "Integration test interpretation, not production project knowledge.", validFrom: "2026-07-13", validThrough: "2026-07-16", evidenceIds: [chosen.id] };
  return { investigation, context, content, input: { ...content, investigationId: investigation.id } };
}

test("proposal authorization, source bounds, and identity cannot be supplied by a caller", async () => {
  const { input, context } = await draft("2026-07-13");
  await assert.rejects(() => proposeProjectMemory(input, null), status(401));
  await assert.rejects(() => proposeProjectMemory(input, { ...owner, principalId: "outsider" }), status(403));
  await assert.rejects(() => proposeProjectMemory(input, reviewer), status(404));
  for (const injection of [{ actor: { id: "Jae", name: "Jae" } }, { projectId: "foreign" }, { status: "reviewed" }, { href: "https://example.com" }]) {
    await assert.rejects(() => proposeProjectMemory({ ...input, ...injection }, owner), status(422));
  }
  const later = (await readEvidence(db, release, "2026-07-16")).find(row => row.observedDate === "2026-07-16");
  await assert.rejects(() => proposeProjectMemory({ ...input, evidenceIds: [later._id] }, owner), status(422));
  await assert.rejects(() => proposeProjectMemory({ ...input, validFrom: "2026-07-17" }, owner), status(422));
  await assert.rejects(() => proposeProjectMemory({ ...input, evidenceIds: ["foreign"] }, owner), status(422));
  const plans = context.evidence.filter(row => row.kind === "field-plan");
  assert.ok(plans.length);
  assert.doesNotMatch(JSON.stringify(plans), /49\/392|7\/14\/2026|rawCells/);
});

test("explicit reviewed memory is shared, reused after reconnect, and frozen in saved investigations", async () => {
  const { input, content, investigation } = await draft();
  const { memory } = await proposeProjectMemory(input, owner);
  assert.equal(memory.latest.status, "proposed"); assert.equal(memory.visibility, "private");
  assert.deepEqual(await proposeProjectMemory(input, owner), { memory, href: `/memory/${memory.id}` });
  assert.deepEqual((await getProjectMemory({ cutoff: question.cutoff }, owner)).memories, []);
  assert.deepEqual((await listProjectMemory(reviewer)).memories, []);
  await assert.rejects(() => getProjectMemoryDetail(memory.id, reviewer), status(404));
  await assert.rejects(() => reviseProjectMemory(memory.id, { expectedRevision: 1, action: "review", reason: null, content }, reviewer), status(404));
  const review = { expectedRevision: 1, action: "review", reason: null, content };
  const accepted = await reviseProjectMemory(memory.id, review, owner);
  assert.equal(accepted.memory.latest.actor.name, "Actual Owner");
  assert.equal(accepted.memory.latest.status, "reviewed");
  assert.equal(accepted.memory.visibility, "project");
  assert.equal((await reviseProjectMemory(memory.id, review, owner)).memory.revisions.length, 2);
  await closeProjectDb();
  const retrieved = await getProjectMemory({ cutoff: question.cutoff }, reviewer);
  assert.equal(retrieved.memories[0].revision, 2);
  assert.equal(retrieved.memories[0].reviewedBy.name, "Actual Owner");
  assert.ok(!("revisions" in retrieved.memories[0]));
  assert.equal((await getProjectMemoryDetail(memory.id, reviewer)).viewer.name, "Actual Reviewer");
  const current = (await investigateJetGrouting(question, owner)).investigation;
  assert.notEqual(current.id, investigation.id);
  assert.equal(current.reviewedMemory[0].revision, 2);
  assert.equal((await getProjectMemory({ cutoff: "2026-07-13" }, owner)).excluded.futureEvidence, 1);
  assert.deepEqual((await getProjectMemory({ cutoff: "2026-07-13" }, owner)).memories, []);
  assert.deepEqual((await getProjectMemory({ cutoff: "2026-07-17" }, owner)).memories, []);
  const correction = { expectedRevision: 2, action: "review", reason: "Corrected during isolated integration test", content: { ...content, statement: "Corrected test interpretation" } };
  await assert.rejects(() => reviseProjectMemory(memory.id, { ...correction, reason: null }, reviewer), status(422));
  await assert.rejects(() => reviseProjectMemory(memory.id, { ...correction, actor: { id: "Jae" } }, reviewer), status(422));
  const corrected = await reviseProjectMemory(memory.id, correction, reviewer);
  assert.equal(corrected.memory.latest.actor.name, "Actual Reviewer");
  assert.equal(corrected.memory.revisions[1].statement, content.statement);
  await assert.rejects(() => reviseProjectMemory(memory.id, { ...correction, reason: "Conflicting write" }, owner), status(409));
  assert.equal((await getInvestigation(current.id, owner)).investigation.reviewedMemory[0].statement, content.statement);
  assert.equal((await getInvestigation(investigation.id, owner)).investigation.reviewedMemory.length, 0);
  const next = (await investigateJetGrouting(question, owner)).investigation;
  assert.notEqual(next.id, current.id); assert.equal(next.reviewedMemory[0].revision, 3);
  await reviseProjectMemory(memory.id, { expectedRevision: 3, action: "flag", reason: "Needs more context" }, owner);
  assert.deepEqual((await getProjectMemory({ cutoff: question.cutoff }, owner)).memories, []);
  assert.equal((await getInvestigation(next.id, owner)).investigation.reviewedMemory[0].revision, 3);
  await reviseProjectMemory(memory.id, { expectedRevision: 4, action: "withdraw", reason: "Test withdrawn" }, reviewer);
  assert.deepEqual((await getProjectMemory({ cutoff: question.cutoff }, owner)).memories, []);
  assert.equal((await getProjectMemoryDetail(memory.id, owner)).memory.revisions.length, 5);
});

test("changed import excludes old reviewed knowledge and requires new investigation for review", async () => {
  const { input, content } = await draft("2026-07-13", "Old import note");
  const { memory } = await proposeProjectMemory(input, owner);
  await reviseProjectMemory(memory.id, { expectedRevision: 1, action: "review", reason: null, content }, owner);
  const changed = structuredClone(data); changed.evidence[0].text += " Isolated new import.";
  const next = await persistProjectImport(db, changed);
  assert.notEqual(next.releaseId, release.releaseId);
  assert.deepEqual((await getProjectMemory({ cutoff: question.cutoff }, owner)).memories, []);
  assert.equal((await getProjectMemory({ cutoff: question.cutoff }, owner)).excluded.otherImport, 1);
  await assert.rejects(() => proposeProjectMemory(input, owner), status(409));
  await assert.rejects(() => reviseProjectMemory(memory.id, { expectedRevision: 2, action: "review", reason: "Update", content }, owner), status(409));
  const detail = await getProjectMemoryDetail(memory.id, reviewer);
  assert.equal(detail.memory.releaseId, release.releaseId); assert.equal(detail.activeReleaseId, next.releaseId);
  assert.ok(detail.evidence.every(row => row.id.startsWith(release.releaseId)));
  assert.equal((await reviseProjectMemory(memory.id, { expectedRevision: 2, action: "flag", reason: "Import changed" }, reviewer)).memory.latest.status, "needs_review");
});
