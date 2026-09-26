import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProjectImport, IMPORT_VERSION } from "../apps/web/lib/tomok/import-data.ts";
import { parseSchedule } from "../apps/web/lib/project-files/schedule.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const imported = await buildProjectImport(root);
const records = [
  ...imported.sources, imported.snapshot, ...imported.activities,
  ...imported.relationships, ...imported.wbs, ...imported.calendars, ...imported.evidence,
];

test("imports immutable originals and all P6 source tables without conflating project IDs", async () => {
  assert.equal(imported.sources.length, 8);
  assert.deepEqual(imported.snapshot.counts, { activities: 1793, relationships: 3103, wbs: 673, calendars: 12 });
  for (const source of imported.sources) {
    const bytes = await readFile(path.join(root, source.relativePath));
    assert.equal(source.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(source.id, source.sha256.slice(0, 16));
  }
  assert.ok(records.every((record) => record.projectId === "bp-tunnel" && record.importVersion === IMPORT_VERSION));
  assert.ok(imported.activities.every((record) => record.p6ProjectId === "38856"));
  const xerBytes = await readFile(path.join(root, "data/kiewit/bp-tunnel/FDT-A-MS-R23.xer"));
  const parsed = parseSchedule(xerBytes);
  assert.deepEqual(imported.activities.map(({ _id, projectId, importVersion, sourceId, snapshotId, p6ProjectId, calendarId, raw, href, ...activity }) => ({ ...activity, projectId: p6ProjectId })), parsed.activities);
  assert.equal(imported.snapshot.approvalStatus, "unconfirmed");
  assert.equal(imported.snapshot.projects[0].dataDate, "2026-04-27 07:00");
  assert.equal(imported.snapshot.exportDate, "2026-07-06");
  assert.equal(imported.snapshot.rawProjects[0].fields.last_schedule_date, "2026-07-06 21:02");
  assert.equal(imported.snapshot.rawProjects[0].fields.sum_base_proj_id, "38864");
  const coreCounts = { PROJECT: imported.snapshot.rawProjects.length, TASK: imported.activities.length, TASKPRED: imported.relationships.length, PROJWBS: imported.wbs.length, CALENDAR: imported.calendars.length };
  assert.deepEqual({ ...Object.fromEntries(Object.entries(imported.snapshot.rawOtherTables).map(([table, rows]) => [table, rows.length])), ...coreCounts }, imported.snapshot.rawTableCounts);
  assert.ok(imported.calendars.every((calendar) => calendar.raw.clndr_data));
});

test("IDs and JSON payloads are repeatable, serializable, and source-versioned", async () => {
  assert.equal(new Set(records.map((record) => record._id)).size, records.length);
  assert.deepEqual(JSON.parse(JSON.stringify(imported)), imported);
  const again = await buildProjectImport(root);
  assert.deepEqual(again, imported);
  for (const record of [...imported.activities, ...imported.relationships, ...imported.wbs, ...imported.calendars]) {
    assert.equal(record.snapshotId, imported.snapshot.sourceId);
    assert.equal(record.sourceId, imported.snapshot.sourceId);
    assert.ok(record._id.includes(record.snapshotId));
  }
});

test("source links and relationships preserve identities, type, lag, and source rows", () => {
  const grout = imported.activities.find((activity) => activity.code === "2A-SP01-GRND-710C-XP");
  const drill = imported.activities.find((activity) => activity.code === "2A-SP01-GRND-710B-XP");
  assert.equal(grout.sourceLine, 2437);
  assert.equal(grout.raw.task_code, grout.code);
  assert.equal(grout.raw.driving_path_flag, "Y");
  assert.equal(grout.raw.total_float_hr_cnt, "0");
  const link = imported.relationships.find((relationship) => relationship.predecessor === drill.id && relationship.successor === grout.id);
  assert.equal(link.type, "FF");
  assert.equal(link.raw.pred_type, "PR_FF");
  assert.equal(link.lagHours, 0);
  const href = new URL(grout.href, "https://example.test");
  assert.equal(href.searchParams.get("file"), grout.sourceId);
  assert.equal(href.searchParams.get("activity"), grout.id);
  const ids = new Set(imported.activities.map((activity) => activity.id));
  assert.ok(imported.relationships.every((relationship) => ids.has(relationship.predecessor) && ids.has(relationship.successor)));
});

test("field plans remain undated and candidate roll-ups are never silently confirmed", () => {
  const plans = imported.evidence.filter((record) => record.kind === "field-plan");
  assert.equal(plans.length, 4);
  assert.ok(plans.every((record) => record.observedDate === null && record.facts.workbookAsOfDate === null));
  const m = plans.find((record) => record.facts.line === "M"), l = plans.find((record) => record.facts.line === "L");
  assert.equal(m.facts.currentFinish, "2026-07-15");
  assert.equal(l.facts.currentStart, "2026-07-16");
  for (const line of [m, l]) {
    assert.equal(line.activityCode, null);
    assert.equal(line.facts.activityIdRaw, "roll-up");
    assert.equal(line.facts.mappingStatus, "unreviewed");
    assert.equal(line.facts.candidateActivityCode, "2A-SP01-GRND-710C-XP");
  }
  assert.ok(imported.evidence.every((record) => record.reviewStatus === "unreviewed"));
  const row98 = plans.find((record) => record.locator.cell === "F98");
  assert.equal(row98.facts.actualFinish, null);
  assert.equal(row98.facts.actualFinishRaw, "21-Oct-26T");
  assert.equal(row98.facts.actualFinishIsForecast, true);
  assert.equal(row98.rawCells.O98.cachedValue, "21-Oct-26T");
  assert.equal(row98.rawCells.O98.original.value, "21-Oct-26T");
  assert.equal(row98.rawCells.O98.original.type, "str");
  assert.match(row98.rawCells.O98.formula, /TEXT\(L98/);
  assert.equal(row98.rawCells.O98.original.formula, row98.rawCells.O98.formula);
  assert.equal(row98.rawCells.Q98.display, "-29");
});

test("dated observations preserve original cells and separate drilling from grout production", () => {
  const observations = imported.evidence.filter((record) => record.kind === "field-observation" && record.locator.sheet === "Daily Construction Report");
  assert.deepEqual(observations.map((record) => record.observedDate), ["2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16"]);
  assert.deepEqual(observations.map((record) => record.facts.predrilled.completed), [72, 76, 83, 90]);
  assert.deepEqual(observations.map((record) => record.facts.jetGrouted.completed), [44, 49, 55, 56]);
  assert.deepEqual(observations.map((record) => record.facts.lines.M.jetGrouted.completed), [16, 21, 27, 28]);
  assert.ok(observations.every((record) => record.facts.lines.L.jetGrouted.completed === 0));
  assert.ok(observations.every((record) => record.activityCode === null && record.facts.mappingStatus === "unreviewed"));
  for (const observation of observations) {
    assert.equal(observation.text, observation.rawCells[observation.locator.cell].display);
    const href = new URL(observation.href, "https://example.test");
    assert.equal(href.searchParams.get("sheet"), observation.locator.sheet);
    assert.equal(href.searchParams.get("cell"), observation.locator.cell);
    assert.equal(href.searchParams.get("file"), observation.sourceId);
  }
  const soeObservations = imported.evidence.filter((record) => record.kind === "field-observation" && record.locator.sheet === "2026 Master Schedule");
  assert.equal(soeObservations.length, 2);
  assert.ok(soeObservations.every((record) => record.observedDate === "2026-07-14" && record.facts.dateScope === "row-description-only"));
});

test("changed originals fail import before publishing any records", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "tomok-import-test-"));
  try {
    const manifestPath = "apps/web/lib/project-files/source-manifest.json";
    const manifestBytes = await readFile(path.join(root, manifestPath));
    const manifest = JSON.parse(manifestBytes);
    await mkdir(path.join(temp, path.dirname(manifestPath)), { recursive: true });
    await mkdir(path.join(temp, "data/kiewit/bp-tunnel"), { recursive: true });
    await writeFile(path.join(temp, manifestPath), manifestBytes);
    await writeFile(path.join(temp, "data/kiewit/bp-tunnel", manifest.files[0].name), "changed original");
    await assert.rejects(() => buildProjectImport(temp), /Source changed; register a new version/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
