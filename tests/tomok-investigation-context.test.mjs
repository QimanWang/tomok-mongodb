import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { buildProjectImport } from "../apps/web/lib/tomok/import-data.ts";
import { persistProjectImport, readEvidence } from "../apps/web/lib/tomok/repository.ts";
import { closeProjectDb } from "../apps/web/lib/tomok/db.ts";
import { getInvestigation, getScheduleContext, investigateJetGrouting } from "../apps/web/lib/tomok/service.ts";

let server, client, db, data, release, activity, xer, daily, pdf, latest;
const code = "2A-SP01-GRND-710C-XP";
const owner = { principalId: "context-owner", principalType: "user", authenticator: "better-auth", issuer: "better-auth" };
const otherOwner = { ...owner, principalId: "context-other" };
const status = expected => error => error?.status === expected;
const base = { cutoff: "2026-07-16", question: "Compare South Portal jet grouting with the selected project context." };
const envBefore = { ...process.env };
const sourceInput = (source, locator = {}) => ({ sourceId: source.sourceId, sha256: source.sha256, ...locator });

before(async () => {
  [server, data] = await Promise.all([
    MongoMemoryServer.create(),
    buildProjectImport(fileURLToPath(new URL("../", import.meta.url))),
  ]);
  client = await new MongoClient(server.getUri()).connect();
  db = client.db("investigation_context_test");
  release = await persistProjectImport(db, data);
  activity = data.activities.find(row => row.code === code);
  xer = data.sources.find(row => row.sourceId === activity.sourceId);
  latest = data.evidence.find(row => row.observedDate === base.cutoff && row.kind === "field-observation");
  daily = data.sources.find(row => row.sourceId === latest.sourceId);
  pdf = data.sources.find(row => row.kind === "pdf");
  assert.ok(activity && xer && latest && daily && pdf);
  Object.assign(process.env, {
    NODE_ENV: "development", DATABASE_URL: "test", BETTER_AUTH_SECRET: "test",
    NEXT_PUBLIC_VERCEL_APP_CLIENT_ID: "test", VERCEL_APP_CLIENT_SECRET: "test",
    UPSTASH_REDIS_REST_URL: "test", UPSTASH_REDIS_REST_TOKEN: "test",
    TOMOK_PROJECT_VIEWER_IDS: "context-owner,context-other",
    MONGODB_URI: server.getUri(), MONGODB_DATABASE: "investigation_context_test",
  });
});

after(async () => {
  await closeProjectDb();
  await client?.close();
  await server?.stop();
  for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
  Object.assign(process.env, envBefore);
});

test("optional context preserves the original investigation scope and requires explicit milestone selection", async () => {
  const plain = await investigateJetGrouting(base, owner);
  assert.equal(Object.hasOwn(plain.investigation, "selectedSource"), false);
  assert.equal(Object.hasOwn(plain.investigation, "milestoneContext"), false);
  assert.match(plain.investigation.title, /South Portal jet grouting/);
  assert.equal(plain.investigation.cutoff, base.cutoff);
  const context = await getScheduleContext({ activityCode: code }, owner);
  assert.equal(Object.hasOwn(context, "milestoneContext"), false);
  assert.equal(context.activity.code, code);
  assert.deepEqual(await investigateJetGrouting(base, owner), plain);
});

test("selected milestones persist deterministic context and keep previous saved cases unchanged", async () => {
  const original = await investigateJetGrouting(base, owner);
  const firstInput = { ...base, targetMilestoneCode: "MS-260", selectedSource: sourceInput(xer, { activity: activity.id }) };
  const first = await investigateJetGrouting(firstInput, owner);
  assert.equal(first.investigation.milestoneContext.target.code, "MS-260");
  assert.equal(first.investigation.milestoneContext.relationships.length, 14);
  assert.equal(first.investigation.selectedSource.coverage, "schedule-activity");
  assert.equal(first.investigation.selectedSource.activity, activity.id);
  assert.equal(first.investigation.selectedSource.sha256, xer.sha256);
  assert.equal(first.investigation.milestoneContext.coverage.truncated, false);
  assert.notEqual(first.investigation.id, original.investigation.id);
  assert.deepEqual(await investigateJetGrouting(firstInput, owner), first);
  await closeProjectDb();
  assert.deepEqual((await getInvestigation(first.investigation.id, owner)).investigation, first.investigation);

  const second = await investigateJetGrouting({ ...firstInput, targetMilestoneCode: "MS-280" }, owner);
  assert.notEqual(second.investigation.id, first.investigation.id);
  assert.equal(second.investigation.milestoneContext.relationships.length, 17);
  assert.deepEqual((await getInvestigation(first.investigation.id, owner)).investigation, first.investigation);
  assert.deepEqual((await getInvestigation(original.investigation.id, owner)).investigation, original.investigation);

  const anotherSelection = await investigateJetGrouting({ ...firstInput, selectedSource: sourceInput(pdf, { page: 2 }) }, owner);
  assert.notEqual(anotherSelection.investigation.id, first.investigation.id);
  assert.deepEqual(anotherSelection.investigation.milestoneContext, first.investigation.milestoneContext);
  const anotherViewer = await investigateJetGrouting(firstInput, otherOwner);
  assert.notEqual(anotherViewer.investigation.id, first.investigation.id);
  await assert.rejects(() => getInvestigation(first.investigation.id, otherOwner), status(404));
});

test("schedule context returns the chosen imported paths with source links and qualified impact", async () => {
  for (const [targetMilestoneCode, length] of [["MS-260", 14], ["MS-280", 17]]) {
    const { milestoneContext } = await getScheduleContext({ activityCode: code, targetMilestoneCode }, owner);
    assert.equal(milestoneContext.status, "found");
    assert.equal(milestoneContext.source.code, code);
    assert.equal(milestoneContext.target.code, targetMilestoneCode);
    assert.equal(milestoneContext.relationships.length, length);
    assert.equal(milestoneContext.basis.dataDate, "2026-04-27 07:00");
    assert.equal(milestoneContext.basis.exportDate, "2026-07-06");
    assert.match(milestoneContext.limitations.join(" "), /not a driving or critical path/);
    assert.match(milestoneContext.limitations.join(" "), /does not calculate milestone delay/);
    assert.ok(milestoneContext.relationships.every(edge => new URL(edge.citation.href, "https://tomok.invalid").searchParams.get("activity") === edge.successor));
    assert.doesNotMatch(JSON.stringify(milestoneContext), /"raw"|"rawCells"|"rawHeader"/);
  }
});

test("authorization and strict input validation apply before adding investigation context", async () => {
  const input = { ...base, targetMilestoneCode: "MS-260", selectedSource: sourceInput(xer, { activity: activity.id }) };
  await assert.rejects(() => investigateJetGrouting(input, null), status(401));
  await assert.rejects(() => investigateJetGrouting(input, { ...owner, principalId: "outsider" }), status(403));
  await assert.rejects(() => getScheduleContext({ activityCode: code, targetMilestoneCode: "MS-260" }, null), status(401));
  for (const targetMilestoneCode of ["MS-999", "", null, { $ne: "" }]) {
    await assert.rejects(() => investigateJetGrouting({ ...base, targetMilestoneCode }, owner), status(400));
    await assert.rejects(() => getScheduleContext({ activityCode: code, targetMilestoneCode }, owner), status(400));
  }
  for (const extra of [{ projectId: "other" }, { owner: "other" }, { replayId: "forged" }, { releaseId: "other" }]) {
    await assert.rejects(() => investigateJetGrouting({ ...input, ...extra }, owner), status(400));
  }
  await assert.rejects(() => investigateJetGrouting({ ...input, selectedSource: { ...input.selectedSource, href: "https://untrusted.invalid" } }, owner), status(400));
});

test("source selection requires the exact registered full hash and rejects incompatible or missing locators", async () => {
  const selectedSource = sourceInput(daily, latest.locator);
  for (const sha256 of [daily.sha256.slice(0, 16), "wrong-hash", ""]) {
    await assert.rejects(() => investigateJetGrouting({ ...base, selectedSource: { ...selectedSource, sha256 } }, owner), status(400));
  }
  await assert.rejects(() => investigateJetGrouting({ ...base, selectedSource: { ...selectedSource, sha256: "0".repeat(64) } }, owner), status(409));
  await assert.rejects(() => investigateJetGrouting({ ...base, selectedSource: { ...selectedSource, sourceId: "0".repeat(16) } }, owner), status(409));
  const invalid = [
    [sourceInput(xer, { activity: "does-not-exist" }), 404],
    [sourceInput(xer, { activity: code }), 404],
    [sourceInput(daily, { sheet: "Missing sheet", cell: "A1" }), 404],
    [sourceInput(daily, { cell: "A1" }), 400],
    [sourceInput(daily, { sheet: latest.locator.sheet, cell: "A9999999" }), 400],
    [sourceInput(daily, { sheet: latest.locator.sheet, cell: "ZZZ1" }), 400],
    [sourceInput(daily, { sheet: latest.locator.sheet, cell: "A0" }), 400],
    [sourceInput(pdf, { page: pdf.pages + 1 }), 400],
    [sourceInput(pdf, { page: 0 }), 400],
    [sourceInput(pdf, { page: "2" }), 400],
    [sourceInput(daily, { page: 2 }), 400],
    [sourceInput(pdf, { sheet: latest.locator.sheet, cell: "A1" }), 400],
    [sourceInput(daily, { activity: activity.id }), 400],
    [sourceInput(xer, { activity: activity.id, page: 2 }), 400],
  ];
  for (const [selection, expected] of invalid) {
    await assert.rejects(() => investigateJetGrouting({ ...base, selectedSource: selection }, owner), status(expected));
  }
});

test("PDF page and workbook cell round trips preserve locations without inventing ingestion", async () => {
  const pageResult = await investigateJetGrouting({ ...base, selectedSource: sourceInput(pdf, { page: 2 }) }, owner);
  const page = pageResult.investigation.selectedSource;
  assert.equal(page.coverage, "reference-only");
  assert.equal(page.page, 2);
  assert.deepEqual(page.evidenceIds, []);
  assert.match(page.coverageNote, /not included.*curated evidence/);
  const pageUrl = new URL(page.href, "https://tomok.invalid");
  assert.equal(pageUrl.searchParams.get("file"), pdf.sourceId);
  assert.equal(pageUrl.searchParams.get("page"), "2");

  const selectedSource = sourceInput(daily, latest.locator);
  const result = await investigateJetGrouting({ ...base, selectedSource }, owner);
  const selected = result.investigation.selectedSource;
  assert.equal(selected.coverage, "curated-record");
  assert.deepEqual(selected.evidenceIds, [`${release.releaseId}:${latest._id}`]);
  assert.equal(selected.sheet, latest.locator.sheet);
  assert.equal(selected.cell, latest.locator.cell);
  const cellUrl = new URL(selected.href, "https://tomok.invalid");
  assert.equal(cellUrl.searchParams.get("sheet"), latest.locator.sheet);
  assert.equal(cellUrl.searchParams.get("cell"), latest.locator.cell);
  assert.doesNotMatch(JSON.stringify(selected), /rawCells|cachedValue|original|"facts"|"text"/);
  assert.equal(Object.hasOwn(selected, "rawCells"), false);
  assert.equal(Object.hasOwn(selected, "text"), false);
  const normalized = await investigateJetGrouting({ ...base, selectedSource: { ...selectedSource, cell: ` ${latest.locator.cell.toLowerCase()} ` } }, owner);
  assert.deepEqual(normalized, result);
});

test("earlier cutoff retains a later cell only as a reference and exposes no later evidence or quantities", async () => {
  const selectedSource = sourceInput(daily, latest.locator);
  const result = await investigateJetGrouting({ ...base, cutoff: "2026-07-14", selectedSource }, owner);
  assert.equal(result.investigation.selectedSource.coverage, "reference-only");
  assert.deepEqual(result.investigation.selectedSource.evidenceIds, []);
  assert.equal(result.investigation.selectedSource.cell, latest.locator.cell);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /56\/392|55\/392|90\/392|83\/392|rawCells/);
  assert.ok(!serialized.includes(latest.text));
  for (const later of (await readEvidence(db, release, "2026-07-16")).filter(row => row.observedDate > "2026-07-14")) {
    assert.ok(!serialized.includes(later._id));
  }
  const eligible = data.evidence.find(row => row.observedDate === "2026-07-14" && row.kind === "field-observation" && row.sourceId === daily.sourceId);
  const earlier = await investigateJetGrouting({ ...base, cutoff: "2026-07-14", selectedSource: sourceInput(daily, eligible.locator) }, owner);
  assert.equal(earlier.investigation.selectedSource.coverage, "curated-record");
});

test("a different XER activity remains a reference and cannot redirect the investigation scope", async () => {
  const target = data.activities.find(row => row.code === "MS-280");
  const result = await investigateJetGrouting({ ...base, selectedSource: sourceInput(xer, { activity: target.id }) }, owner);
  assert.equal(result.investigation.selectedSource.coverage, "reference-only");
  assert.equal(result.investigation.selectedSource.activity, target.id);
  assert.match(result.investigation.selectedSource.label, /MS-280/);
  assert.match(result.investigation.title, /South Portal jet grouting/);
  assert.equal(Object.hasOwn(result.investigation, "milestoneContext"), false);
  const schedule = result.investigation.findings.find(row => row.id === "schedule-basis");
  assert.match(schedule.text, /2A-SP01-GRND-710C-XP/);
});

test("inactive releases and foreign projects cannot supply selected activities", async () => {
  const id = "fixture-inactive-activity";
  const inactive = { ...activity, id, _id: "inactive:selection", releaseId: "inactive-release", name: "Inactive activity canary" };
  const foreign = { ...activity, id, _id: "foreign:selection", releaseId: release.releaseId, projectId: "foreign-project", name: "Foreign activity canary" };
  try {
    await db.collection("schedule_activities").insertMany([inactive, foreign], { bypassDocumentValidation: true });
    await assert.rejects(() => investigateJetGrouting({ ...base, selectedSource: sourceInput(xer, { activity: id }) }, owner), status(404));
  } finally {
    await db.collection("schedule_activities").deleteMany({ _id: { $in: [inactive._id, foreign._id] } });
  }
});
