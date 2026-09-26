import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { loadWorkbook } from "../apps/web/lib/project-files/load-workbook.ts";
import { parseSchedule } from "../apps/web/lib/project-files/schedule.ts";
import {
  activityDates,
  dateNumber,
} from "../apps/web/lib/project-files/presentation.ts";
import { parseByteRange } from "../apps/web/lib/project-files/range.ts";
import { projectSourceDirectory } from "../apps/web/lib/project-files/source-directory.ts";
import { fileURLToPath } from "node:url";
import {
  cellDisplay,
  cellFormula,
  cellPosition,
  columnName,
  populatedBounds,
} from "../apps/web/lib/project-files/workbook.ts";
const root = new URL("../data/kiewit/bp-tunnel/", import.meta.url);
const manifest = JSON.parse(
  await readFile(
    new URL(
      "../apps/web/lib/project-files/source-manifest.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const bytes = await readFile(new URL("FDT-A-MS-R23.xer", root));

test("source files resolve from repository and web service working directories", () => {
  const repository = fileURLToPath(new URL("../", import.meta.url));
  const web = fileURLToPath(new URL("../apps/web", import.meta.url));
  assert.equal(projectSourceDirectory(repository), fileURLToPath(root).replace(/\/$/, ""));
  assert.equal(projectSourceDirectory(web), projectSourceDirectory(repository));
});
const schedule = parseSchedule(bytes);

test("all eight sources still match reviewed versions", async () => {
  assert.equal(manifest.files.length, 8);
  for (const source of manifest.files) {
    const bytes = await readFile(new URL(source.name, root));
    assert.equal(bytes.length, source.bytes, source.name);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      source.sha256,
      source.name,
    );
  }
});
test("P6 source counts, data date, export date, encoding, and stable identities", () => {
  assert.equal(schedule.activities.length, 1793);
  assert.equal(schedule.relationships.length, 3103);
  assert.equal(schedule.wbs.length, 673);
  assert.equal(schedule.calendarCount, 12);
  assert.equal(schedule.projects[0].dataDate, "2026-04-27 07:00");
  assert.equal(schedule.exportDate, "2026-07-06");
  assert.equal(schedule.projects.length, 1);
  assert.equal(new Set(schedule.activities.map((a) => a.id)).size, 1793);
  assert.ok(schedule.activities.every((a) => !a.name.includes("\uFFFD")));
  const ids = new Set(schedule.activities.map((a) => a.id));
  assert.ok(
    schedule.relationships.every(
      (r) => ids.has(r.predecessor) && ids.has(r.successor),
    ),
  );
});
test("jet grout case preserves raw dates, source locator, typed dependencies, and float", () => {
  const production = schedule.activities.find(
    (a) => a.code === "2A-SP01-GRND-710C-XP",
  );
  const drilling = schedule.activities.find(
    (a) => a.code === "2A-SP01-GRND-710B-XP",
  );
  assert.equal(production.id, "38856:54680385");
  assert.equal(production.status, "TK_NotStart");
  assert.equal(production.sourceLine, 2437);
  assert.equal(production.floatHours, 0);
  assert.equal(drilling.floatHours, 440);
  assert.deepEqual(
    activityDates(production, "planned").map((d) => d.slice(0, 10)),
    ["2026-07-06", "2026-11-19"],
  );
  assert.deepEqual(activityDates(production, "actual"), ["", ""]);
  const link = schedule.relationships.find(
    (r) => r.predecessor === drilling.id && r.successor === production.id,
  );
  assert.equal(link.type, "FF");
  assert.equal(link.lagHours, 0);
  assert.equal(
    new TextDecoder("windows-1252")
      .decode(bytes)
      .split(/\r?\n/)
      [production.sourceLine - 1].includes(production.code),
    true,
  );
});
test("chart date arithmetic is timezone-independent and does not invent absent dates", () => {
  assert.equal(dateNumber("2026-07-06 07:00"), Date.UTC(2026, 6, 6));
  assert.equal(dateNumber(""), null);
  assert.equal(dateNumber("2026-02-30"), null);
  const activity = {
    dates: {
      act_start_date: "2026-06-24 07:00",
      act_end_date: "",
      reend_date: "2026-10-21 17:00",
      target_start_date: "2026-07-06 07:00",
      target_end_date: "2026-11-19 17:00",
    },
  };
  assert.deepEqual(activityDates(activity, "actual"), ["2026-06-24 07:00", ""]);
  assert.deepEqual(activityDates(activity, "schedule"), [
    "2026-06-24 07:00",
    "2026-10-21 17:00",
  ]);
});
test("PDF byte ranges include suffix and open-ended requests, rejecting invalid ranges", () => {
  assert.deepEqual(parseByteRange("bytes=0-99", 200), { start: 0, end: 99 });
  assert.deepEqual(parseByteRange("bytes=100-", 200), { start: 100, end: 199 });
  assert.deepEqual(parseByteRange("bytes=-50", 200), { start: 150, end: 199 });
  assert.deepEqual(parseByteRange("bytes=0-999", 200), { start: 0, end: 199 });
  assert.equal(parseByteRange(null, 200), null);
  for (const range of [
    "bytes=200-",
    "bytes=100-50",
    "bytes=-0",
    "bytes=-",
    "bytes=0-1,3-4",
    "bytes=NaN-5",
  ])
    assert.throws(() => parseByteRange(range, 200));
});
test("SOE uses a visible sheet and distinguishes a cached forecast formula from an actual finish", async () => {
  const workbook = await loadWorkbook(
    Uint8Array.from(await readFile(new URL("SOE-Master-Schedule.xlsx", root)))
      .buffer,
  );
  assert.equal(workbook.worksheets[0].state, "hidden");
  const sheet = workbook.worksheets.find((sheet) => sheet.state === "visible");
  assert.equal(sheet.name, "2026 Master Schedule");
  assert.equal(cellDisplay(sheet.getCell("E98")), "2A-SP01-GRND-710C-XP");
  assert.equal(cellDisplay(sheet.getCell("N98")), "2026-06-24");
  assert.ok(cellFormula(sheet.getCell("O98")));
  assert.equal(cellDisplay(sheet.getCell("O98")), "21-Oct-26T");
  assert.equal(cellDisplay(sheet.getCell("Q98")), "-29");
  assert.ok(populatedBounds(sheet).columns < 1000);
});
test("daily report cell references and cumulative quantities remain exact", async () => {
  const workbook = await loadWorkbook(
    Uint8Array.from(
      await readFile(
        new URL("Daily-Construction-Report-july12-july17.xlsx", root),
      ),
    ).buffer,
  );
  const sheet = workbook.worksheets[0];
  assert.deepEqual(
    ["AD3", "AD4", "AD5", "AD6"].map(
      (address) =>
        /Jet Grouted (\d+)\/392/.exec(cellDisplay(sheet.getCell(address)))?.[1],
    ),
    ["44", "49", "55", "56"],
  );
  assert.deepEqual(cellPosition("AD6"), { row: 6, column: 30 });
  assert.equal(columnName(30), "AD");
  assert.equal(cellPosition("XFE1"), null);
  assert.equal(cellPosition("A0"), null);
});
