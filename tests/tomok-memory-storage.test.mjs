import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  appendMemoryRevision, createProposal, getMemory, listMemory,
} from "../apps/web/lib/tomok/memory-repository.ts";

let server, client, db;
const actor = (id = "owner-a") => ({ id, name: `Reviewer ${id}` });
const timestamp = (revision) => new Date(Date.UTC(2026, 8, 23, 0, 0, revision)).toISOString();
const statusIs = (status) => (error) => error?.status === status;
function proposal(id) {
  const latest = {
    kind: "mapping", title: "Line M maps to jet-grout production",
    statement: "Line M field production rolls up to the jet-grout P6 activity.",
    validFrom: "2026-07-13", validThrough: null,
    evidenceIds: ["evidence:soe:102"],
    revision: 1, status: "proposed", actor: actor(), recordedAt: timestamp(1), reason: null,
    citations: [{
      evidenceId: "evidence:soe:102", sourceId: "0213ada757e63e77",
      label: "2026 Master Schedule!F102", href: "/files?file=0213ada757e63e77&cell=F102", observedDate: null,
    }],
    operationId: `create:${id}`,
  };
  return {
    _id: id, id, projectId: "bp-tunnel", releaseId: "release-v1",
    snapshotId: "34dc842bf8c24545", activityCode: "2A-SP01-GRND-710C-XP",
    originInvestigationId: "investigation-owner-a", createdBy: actor(), createdAt: timestamp(1),
    visibility: "private", latest, revisions: [structuredClone(latest)],
  };
}
function revision(current, overrides = {}) {
  const nextNumber = current.latest.revision + 1;
  return {
    ...structuredClone(current.latest), revision: nextNumber, status: "reviewed",
    recordedAt: timestamp(nextNumber), operationId: `review:${current.id}:${nextNumber}`,
    reason: "Verified the field row and scope against the source record.", ...overrides,
  };
}
const append = (current, next = revision(current), actorId = next.actor.id) =>
  appendMemoryRevision(db, { id: current.id, actorId, expectedRevision: current.latest.revision, revision: next });

before(async () => {
  server = await MongoMemoryServer.create({ instance: { dbName: "tomok_memory_test" } });
  client = new MongoClient(server.getUri());
  await client.connect();
  db = client.db("tomok_memory_test");
});
after(async () => {
  await client?.close();
  await server?.stop();
});

test("lazy collection creation and concurrent proposal retries create one private revision", async () => {
  const doc = proposal("memory:create");
  const [first, retry] = await Promise.all([createProposal(db, doc), createProposal(db, doc)]);
  assert.deepEqual(first, doc);
  assert.deepEqual(retry, first);
  assert.equal(await db.collection("project_memory").countDocuments({ _id: doc.id }), 1);
  assert.deepEqual((await db.listCollections().toArray()).map((collection) => collection.name), ["project_memory"]);
  assert.ok((await db.collection("project_memory").listIndexes().toArray()).some((index) => index.key.projectId === 1 && index.key.visibility === 1));
  const changedRetry = structuredClone(doc);
  changedRetry.latest.statement = "This must not rewrite the original proposal.";
  changedRetry.revisions[0] = structuredClone(changedRetry.latest);
  assert.deepEqual(await createProposal(db, changedRetry), first);
});

test("private proposals are visible and editable only to their creator", async () => {
  const doc = await createProposal(db, proposal("memory:private"));
  assert.deepEqual(await getMemory(db, doc.id, "owner-a"), doc);
  assert.equal(await getMemory(db, doc.id, "owner-b"), null);
  assert.ok(!(await listMemory(db, "owner-b")).some((item) => item.id === doc.id));
  await assert.rejects(() => append(doc, revision(doc, { actor: actor("owner-b") })), statusIs(404));
  await assert.rejects(() => getMemory(db, doc.id, ""), statusIs(401));
  const collision = proposal(doc.id);
  collision.createdBy = actor("owner-b");
  collision.latest.actor = actor("owner-b");
  collision.revisions[0].actor = actor("owner-b");
  await assert.rejects(() => createProposal(db, collision), statusIs(409));
  assert.equal((await getMemory(db, doc.id, "owner-a")).latest.revision, 1);
});

test("review publishes the note and later revisions preserve sharing and immutable history", async () => {
  const original = await createProposal(db, proposal("memory:history"));
  const reviewed = await append(original);
  assert.equal(reviewed.visibility, "project");
  assert.deepEqual(await getMemory(db, reviewed.id, "owner-b"), reviewed);
  const corrected = await append(reviewed, revision(reviewed, {
    status: "needs_review", actor: actor("owner-b"),
    statement: "The row-to-activity mapping needs confirmation after a scope change.",
    reason: "The field plan has changed.",
  }));
  assert.equal(corrected.visibility, "project");
  assert.equal(corrected.latest.status, "needs_review");
  assert.equal(corrected.latest.actor.id, "owner-b");
  assert.deepEqual(corrected.revisions.slice(0, 2), reviewed.revisions);
  assert.deepEqual(corrected.latest, corrected.revisions.at(-1));
  const withdrawn = await append(corrected, revision(corrected, { status: "withdrawn", actor: actor("owner-a") }));
  assert.equal(withdrawn.visibility, "project");
  assert.equal(withdrawn.latest.status, "withdrawn");
  assert.deepEqual(withdrawn.revisions.slice(0, 3), corrected.revisions);
  assert.deepEqual(JSON.parse(JSON.stringify(withdrawn)), withdrawn);
});

test("concurrent distinct reviews allow one winner and return conflict for the stale writer", async () => {
  const shared = await append(await createProposal(db, proposal("memory:race")));
  const candidates = [
    revision(shared, { operationId: "race:a", actor: actor("owner-a"), statement: "First review." }),
    revision(shared, { operationId: "race:b", actor: actor("owner-b"), statement: "Second review." }),
  ];
  const results = await Promise.allSettled(candidates.map((next) => append(shared, next)));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.status, 409);
  const saved = await getMemory(db, shared.id, "owner-a");
  assert.equal(saved.revisions.length, 3);
  assert.deepEqual(saved.latest, saved.revisions.at(-1));
  assert.equal(new Set(saved.revisions.map((item) => item.operationId)).size, saved.revisions.length);
});

test("concurrent duplicate review operations and later retries never append twice", async () => {
  const initial = await createProposal(db, proposal("memory:retry"));
  const next = revision(initial, { operationId: "review-operation-stable" });
  const [first, duplicate] = await Promise.all([append(initial, next), append(initial, next)]);
  assert.equal(first.revisions.length, 2);
  assert.deepEqual(duplicate, first);
  const corrected = await append(first, revision(first, { statement: "Reviewed correction." }));
  assert.deepEqual(await append(initial, next), corrected, "retry returns current document including subsequent revisions");
  const foreignActorRetry = { ...next, actor: actor("owner-b") };
  await assert.rejects(() => append(initial, foreignActorRetry), statusIs(409));
  assert.equal((await getMemory(db, initial.id, "owner-a")).revisions.length, 3);
});

test("repository and MongoDB validation reject invalid records without mutating history", async () => {
  const doc = proposal("memory:invalid");
  for (const mutate of [
    (value) => { value.projectId = "another-project"; },
    (value) => { value._id = "mismatched-id"; },
    (value) => { value.latest.status = "reviewed"; value.revisions[0].status = "reviewed"; },
    (value) => { value.latest.validThrough = "2026-07-12"; },
    (value) => { value.latest.evidenceIds = ["different-evidence"]; },
    (value) => { value.createdAt = new Date(); },
  ]) {
    const invalid = structuredClone(doc);
    mutate(invalid);
    await assert.rejects(() => createProposal(db, invalid), statusIs(400));
  }
  assert.equal(await db.collection("project_memory").countDocuments({ _id: doc.id }), 0);
  const saved = await createProposal(db, doc);
  await assert.rejects(() => append(saved, revision(saved, { actor: actor("owner-b") }), "owner-a"), statusIs(400));
  await assert.rejects(() => append(saved, revision(saved, { revision: 7 })), statusIs(400));
  const foreign = { ...proposal("memory:foreign"), projectId: "another-project" };
  await assert.rejects(() => db.collection("project_memory").insertOne(foreign), (error) => error.code === 121);
  await db.collection("project_memory").insertOne({ ...foreign, visibility: "project" }, { bypassDocumentValidation: true });
  assert.equal(await getMemory(db, foreign.id, "owner-a"), null);
  assert.ok((await listMemory(db, "owner-a")).every((item) => item.projectId === "bp-tunnel"));
  assert.deepEqual(await getMemory(db, doc.id, "owner-a"), saved);
});

test("revision cap rejects new operations while retaining retry safety at the cap", async () => {
  const doc = await createProposal(db, proposal("memory:cap"));
  const revisions = [doc.latest];
  for (let index = 2; index <= 100; index++) {
    revisions.push({ ...revision(doc), revision: index, recordedAt: timestamp(index), operationId: `cap:${index}` });
  }
  const latest = revisions.at(-1);
  await db.collection("project_memory").updateOne({ _id: doc.id }, { $set: { revisions, latest, visibility: "project" } });
  const capped = await getMemory(db, doc.id, "owner-a");
  await assert.rejects(() => append(capped), statusIs(409));
  assert.deepEqual(await appendMemoryRevision(db, { id: doc.id, actorId: "owner-a", expectedRevision: 99, revision: latest }), capped);
  assert.equal((await getMemory(db, doc.id, "owner-a")).revisions.length, 100);
});

test("memory listing is bounded and ordered by newest revision", async () => {
  const extra = Array.from({ length: 105 }, (_, index) => {
    const doc = proposal(`memory:list:${String(index).padStart(3, "0")}`);
    doc.latest.recordedAt = timestamp(200 + index);
    doc.revisions[0].recordedAt = doc.latest.recordedAt;
    return doc;
  });
  await db.collection("project_memory").insertMany(extra);
  const listed = await listMemory(db, "owner-a");
  assert.equal(listed.length, 100);
  assert.equal(listed[0].id, "memory:list:104");
  assert.equal(listed.at(-1).id, "memory:list:005");
  assert.ok(listed.every((item) => item.createdBy.id === "owner-a" || item.visibility === "project"));
});
