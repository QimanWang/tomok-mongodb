import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { buildProjectImport } from "../apps/web/lib/tomok/import-data.ts";
import { parseSchedule } from "../apps/web/lib/project-files/schedule.ts";
import {
  activeRelease, importFingerprint, persistProjectImport, readContext,
  readEvidence, readInvestigation, readPersistedSchedule, saveInvestigation,
} from "../apps/web/lib/tomok/repository.ts";
import { closeProjectDb } from "../apps/web/lib/tomok/db.ts";
import { projectAuthMode, requirePrincipal } from "../apps/web/lib/tomok/auth.ts";
import {
  getInvestigation, getProjectEvidence, getProjectStatus,
  getScheduleContext, investigateJetGrouting,
} from "../apps/web/lib/tomok/service.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const code = "2A-SP01-GRND-710C-XP";
let server, client, db, data, release;
const groups = {
  sources: "project_sources", activities: "schedule_activities",
  relationships: "schedule_relationships", wbs: "schedule_wbs",
  calendars: "schedule_calendars", evidence: "evidence_chunks",
};
const user = (id) => ({ principalId: id, principalType: "user", authenticator: "better-auth", issuer: "better-auth" });
const local = { principalId: "eve-chat-user", principalType: "local-dev", authenticator: "local-dev" };
const statusIs = (status) => (error) => error?.status === status;

async function withEnvironment(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return await run(); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await closeProjectDb();
  }
}
function authenticatedEnvironment() {
  return {
    NODE_ENV: "development", VERCEL: undefined,
    DATABASE_URL: "postgresql://test.invalid/tomok_test",
    BETTER_AUTH_SECRET: "test-only-unused-secret",
    NEXT_PUBLIC_VERCEL_APP_CLIENT_ID: "test-only-client",
    VERCEL_APP_CLIENT_SECRET: "test-only-unused-secret",
    UPSTASH_REDIS_REST_URL: "https://test.invalid",
    UPSTASH_REDIS_REST_TOKEN: "test-only-unused-token",
    TOMOK_PROJECT_VIEWER_IDS: "owner-a,owner-b",
    MONGODB_URI: server.getUri(), MONGODB_DATABASE: "tomok_test",
  };
}

before(async () => {
  [server, data] = await Promise.all([
    MongoMemoryServer.create({ instance: { dbName: "tomok_test" } }),
    buildProjectImport(root),
  ]);
  client = new MongoClient(server.getUri());
  await client.connect();
  db = client.db("tomok_test");
  release = await persistProjectImport(db, data);
});
after(async () => {
  await closeProjectDb();
  await client?.close();
  await server?.stop();
});

test("real MongoDB import is idempotent and matches every source count", async () => {
  const repeated = await persistProjectImport(db, data);
  assert.deepEqual(repeated, release);
  assert.equal(repeated.releaseId, importFingerprint(data));
  assert.deepEqual(repeated.counts, { sources: 8, activities: 1793, relationships: 3103, wbs: 673, calendars: 12, evidence: 14 });
  for (const [key, collection] of Object.entries(groups)) {
    assert.equal(await db.collection(collection).countDocuments({}), data[key].length, collection);
    assert.equal(await db.collection(collection).countDocuments({ releaseId: release.releaseId }), data[key].length, collection);
  }
  assert.equal(await db.collection("schedule_snapshots").countDocuments({}), 1);
  assert.deepEqual(await activeRelease(db), release);
});

test("persisted schedule exactly reproduces original viewer data and typed dependencies", async () => {
  const original = parseSchedule(await readFile(new URL("../data/kiewit/bp-tunnel/FDT-A-MS-R23.xer", import.meta.url)));
  assert.deepEqual(await readPersistedSchedule(db, release, data.snapshot.sourceId), original);
  const context = await readContext(db, release, code);
  assert.equal(context.activity.sourceLine, 2437);
  assert.equal(context.activity.p6ProjectId, "38856");
  assert.equal(context.snapshot.approvalStatus, "unconfirmed");
  assert.equal(context.snapshot.projects[0].dataDate, "2026-04-27 07:00");
  assert.equal(context.calendar.id, context.activity.calendarId);
  const drill = context.neighbors.find((activity) => activity.code === "2A-SP01-GRND-710B-XP");
  const relationship = context.relationships.find((edge) => edge.predecessor === drill.id && edge.successor === context.activity.id);
  assert.equal(relationship.type, "FF");
  assert.equal(relationship.lagHours, 0);
  assert.equal(relationship.raw.pred_type, "PR_FF");
  await assert.rejects(() => readContext(db, release, "DOES-NOT-EXIST"), statusIs(404));
});

test("MongoDB cutoff retrieval excludes later reports and keeps undated plans qualified", async () => {
  const initial = await readEvidence(db, release, "2026-07-14");
  assert.equal(initial.length, 12);
  assert.ok(initial.every((row) => row.observedDate === null || row.observedDate <= "2026-07-14"));
  assert.equal(initial.filter((row) => row.kind === "field-plan" && row.observedDate === null).length, 4);
  assert.deepEqual(initial.filter((row) => row.facts.published === true).map((row) => row.facts.jetGrouted.completed), [44, 49]);
  const updated = await readEvidence(db, release, "2026-07-16");
  assert.equal(updated.length, 14);
  assert.deepEqual(updated.filter((row) => row.facts.published === true).map((row) => row.facts.jetGrouted.completed), [44, 49, 55, 56]);
  assert.deepEqual(await readEvidence(db, release, "2026-07-14", "no-such-work-package"), []);
});

test("project and release scoping exclude foreign records even if inserted outside validation", async () => {
  const context = await readContext(db, release, code);
  const sampleEvidence = (await readEvidence(db, release, "2026-07-16"))[0];
  const foreign = [
    ["schedule_activities", { ...context.activity, _id: "foreign:activity", projectId: "another-project" }],
    ["schedule_snapshots", { ...context.snapshot, _id: "foreign:snapshot", projectId: "another-project" }],
    ["evidence_chunks", { ...sampleEvidence, _id: "foreign:evidence", projectId: "another-project" }],
    ["evidence_chunks", { ...sampleEvidence, _id: "inactive:evidence", releaseId: "unpublished-import" }],
  ];
  try {
    await assert.rejects(() => db.collection("evidence_chunks").insertOne(foreign[2][1]), (error) => error.code === 121);
    for (const [collection, record] of foreign) await db.collection(collection).insertOne(record, { bypassDocumentValidation: true });
    assert.equal((await readContext(db, release, code)).activity.projectId, "bp-tunnel");
    assert.equal((await readPersistedSchedule(db, release, data.snapshot.sourceId)).activities.length, 1793);
    const evidence = await readEvidence(db, release, "2026-07-16");
    assert.equal(evidence.length, 14);
    assert.ok(evidence.every((row) => row.projectId === "bp-tunnel" && row.releaseId === release.releaseId));
  } finally {
    for (const [collection, record] of foreign) await db.collection(collection).deleteOne({ _id: record._id });
  }
});

test("validation failures and interrupted writes leave the previous import active", async () => {
  const partial = structuredClone(data);
  partial.activities.pop();
  await assert.rejects(() => persistProjectImport(db, partial), statusIs(400));
  assert.deepEqual(await activeRelease(db), release);
  const interrupted = structuredClone(data);
  interrupted.evidence[0].text += " Integration test interrupted import.";
  const failedRelease = importFingerprint(interrupted);
  const faultyDb = new Proxy(db, {
    get(target, property) {
      if (property === "collection") return (name) => {
        const collection = target.collection(name);
        if (name !== "schedule_relationships") return collection;
        return new Proxy(collection, {
          get(original, key) {
            if (key === "bulkWrite") return async () => { throw new Error("Simulated interrupted import write"); };
            const value = Reflect.get(original, key, original);
            return typeof value === "function" ? value.bind(original) : value;
          },
        });
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await assert.rejects(() => persistProjectImport(faultyDb, interrupted), /Simulated interrupted import write/);
  assert.ok(await db.collection("schedule_activities").countDocuments({ releaseId: failedRelease }) > 0);
  assert.equal(await db.collection("schedule_relationships").countDocuments({ releaseId: failedRelease }), 0);
  assert.deepEqual(await activeRelease(db), release);
  assert.equal((await readEvidence(db, await activeRelease(db), "2026-07-16")).length, 14);
});

test("full authentication rejects local fallback and nonmembers before any database access", async () => {
  await withEnvironment({ ...authenticatedEnvironment(), MONGODB_URI: undefined }, async () => {
    assert.equal(projectAuthMode(), "vercel");
    assert.throws(() => requirePrincipal(local), statusIs(403));
    assert.throws(() => requirePrincipal(user("outsider")), statusIs(403));
    await assert.rejects(() => getProjectStatus(null), statusIs(401));
    await assert.rejects(() => getScheduleContext({ activityCode: code }, local), statusIs(403));
    await assert.rejects(() => getProjectEvidence({ cutoff: "2026-07-16" }, user("outsider")), statusIs(403));
    assert.equal(requirePrincipal(user("owner-a")), "owner-a");
    assert.deepEqual(await getProjectStatus(user("owner-a")), { configured: false, storage: null, imported: false });
    await assert.rejects(() => getProjectEvidence({ cutoff: "2026-07-16" }, user("owner-a")), statusIs(503));
  });
});

test("saved service investigations are idempotent and isolated by owner", async () => {
  await withEnvironment(authenticatedEnvironment(), async () => {
    const input = { cutoff: "2026-07-16", question: "How is South Portal jet grouting progressing?" };
    const first = await investigateJetGrouting(input, user("owner-a"));
    const repeated = await investigateJetGrouting(input, user("owner-a"));
    assert.deepEqual(repeated, first);
    const second = await investigateJetGrouting(input, user("owner-b"));
    assert.notEqual(first.investigation.id, second.investigation.id);
    assert.equal(first.href, `/investigations/${first.investigation.id}`);
    assert.deepEqual((await getInvestigation(first.investigation.id, user("owner-a"))).investigation, first.investigation);
    await assert.rejects(() => getInvestigation(first.investigation.id, user("owner-b")), statusIs(404));
    assert.equal(await readInvestigation(db, first.investigation.id, "owner-b"), null);
    await assert.rejects(() => investigateJetGrouting({ ...input, cutoff: "2026-02-30" }, user("owner-a")), statusIs(400));
    await assert.rejects(() => investigateJetGrouting({ ...input, cutoff: "2026-07-12" }, user("owner-a")), statusIs(422));
  });
});

test("model evidence before July14 cannot expose later SOE quantities through undated plan cells", async () => {
  await withEnvironment(authenticatedEnvironment(), async () => {
    const response = await getProjectEvidence({ cutoff: "2026-07-13" }, user("owner-a"));
    assert.equal(response.evidence.length, 9);
    assert.ok(response.evidence.every((row) => !Object.hasOwn(row, "rawCells")));
    const plans = response.evidence.filter((row) => row.kind === "field-plan");
    assert.equal(plans.length, 4);
    assert.ok(plans.every((row) => !Object.hasOwn(row.facts, "description") && /Undated field-plan/.test(row.text)));
    const serialized = JSON.stringify(response);
    assert.doesNotMatch(serialized, /49\/392|76\/392|55\/392|56\/392|7\/14\/2026|2026-07-14/);
    assert.match(serialized, /44\/392/);
    assert.deepEqual((await getProjectEvidence({ cutoff: "2026-07-13", query: "49/392" }, user("owner-a"))).evidence, []);
    const stored = await readEvidence(db, release, "2026-07-13");
    assert.ok(stored.some((row) => row.rawCells?.F98?.display?.includes("49/392")), "original source cells remain preserved in storage");
  });
});

test("new import versions publish separately and retain old snapshots and investigations", async () => {
  const saved = { id: "test-old-release-investigation", projectId: "bp-tunnel", createdAt: "2026-09-22T00:00:00.000Z", releaseId: release.releaseId, finding: "Historical source snapshot" };
  await saveInvestigation(db, release, "owner-a", saved);
  const next = structuredClone(data);
  next.importVersion = "bp-tunnel-v2-integration-test";
  for (const record of [next.snapshot, ...Object.keys(groups).flatMap((key) => next[key])]) {
    record._id = record._id.replace(data.importVersion, next.importVersion);
    record.importVersion = next.importVersion;
  }
  const updated = await persistProjectImport(db, next);
  assert.notEqual(updated.releaseId, release.releaseId);
  assert.equal((await activeRelease(db)).releaseId, updated.releaseId);
  for (const [key, collection] of Object.entries(groups)) {
    assert.equal(await db.collection(collection).countDocuments({ releaseId: release.releaseId }), data[key].length);
    assert.equal(await db.collection(collection).countDocuments({ releaseId: updated.releaseId }), next[key].length);
  }
  assert.deepEqual(await readInvestigation(db, saved.id, "owner-a"), saved);
  assert.equal(await readInvestigation(db, saved.id, "owner-b"), null);
  assert.deepEqual(await readPersistedSchedule(db, updated, next.snapshot.sourceId), await readPersistedSchedule(db, release, data.snapshot.sourceId));
});
