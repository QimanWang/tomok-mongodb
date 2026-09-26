import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Worksheet } from "exceljs";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { parseSchedule } from "../project-files/schedule";
import { loadWorkbook } from "../project-files/load-workbook";
import { cellDisplay, cellFormula, columnName } from "../project-files/workbook";
import type {
  EvidenceFacts, EvidenceRecord, ImportedCell, ImportRecord, JsonValue,
  ProjectImport, Quantity, RawXerRow, SourceRecord,
} from "./import-types";

export const PROJECT_ID = "bp-tunnel" as const;
// Bump when extraction or interpretation rules change, even if sources do not.
export const IMPORT_VERSION = "bp-tunnel-v1";
const GROUT_CODE = "2A-SP01-GRND-710C-XP";
const DRILL_CODE = "2A-SP01-GRND-710B-XP";
const SOE_SHEET = "2026 Master Schedule";
const DAILY_SHEET = "Daily Construction Report";
const DATA_PATH = "data/kiewit/bp-tunnel";
const titles: Record<string, string> = {
  "FDT-A-MS-R23.xer": "P6 master schedule · R23",
  "SOE-Master-Schedule.xlsx": "SOE master schedule",
  "Daily-Construction-Report-july12-july17.xlsx": "Daily construction report",
  "FDTP - Program 6-Week Lookahead_KSTC_WE 2026.06.27.xlsx": "Six-week lookahead",
  "Schedule-Communication-Plan.docx": "Schedule communication plan",
  "Conformed_Set_of_Specs_Div_01__3.pdf": "Specifications · Division 01",
  "Conformed_Set_of_Specs_2-33.pdf": "Specifications · Divisions 02–33",
};
const base = (identity: string): ImportRecord => ({
  _id: `${PROJECT_ID}:${IMPORT_VERSION}:${identity}`,
  projectId: PROJECT_ID,
  importVersion: IMPORT_VERSION,
});
function viewerHref(sourceId: string, params: Record<string, string> = {}) {
  return `/files?${new URLSearchParams({ file: sourceId, ...params })}`;
}
function jsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error("Invalid source date cache.");
    return value.toISOString();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite source number.");
    return value;
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonValue(entry)]));
  throw new Error("Unsupported source cell value.");
}
function decodeXer(bytes: Uint8Array) {
  if (bytes[0] === 255 && bytes[1] === 254) return new TextDecoder("utf-16le").decode(bytes);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return new TextDecoder("windows-1252").decode(bytes); }
}
function rawXer(text: string) {
  const tables: Record<string, RawXerRow[]> = {};
  let name = "", fields: string[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const [marker, ...values] = line.split("\t");
    if (marker === "%T") { name = values[0]; tables[name] = []; fields = []; }
    if (marker === "%F") fields = values;
    if (marker === "%R") {
      if (!name || !fields.length) throw new Error("XER row has no table definition.");
      tables[name].push({ sourceLine: index + 1, fields: Object.fromEntries(fields.map((field, i) => [field, values[i] ?? ""])) });
    }
  });
  return tables;
}
const list = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const xml = new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, trimValues: false, removeNSPrefix: true });
const xmlText = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === "object") return xmlText((value as Record<string, unknown>)["#text"]);
  return String(value);
};
async function originalCells(bytes: Uint8Array, sheetName: string) {
  const zip = await JSZip.loadAsync(bytes);
  const book = xml.parse(await zip.file("xl/workbook.xml")!.async("string"));
  const rels = xml.parse(await zip.file("xl/_rels/workbook.xml.rels")!.async("string"));
  const sheet = list<Record<string, string>>(book.workbook.sheets.sheet).find((entry) => entry["@_name"] === sheetName);
  const target = list<Record<string, string>>(rels.Relationships.Relationship).find((entry) => entry["@_Id"] === sheet?.["@_id"])?.["@_Target"];
  if (!target) throw new Error(`Missing source sheet: ${sheetName}`);
  const entry = target.startsWith("/") ? target.slice(1) : path.posix.normalize(`xl/${target}`);
  const data = xml.parse(await zip.file(entry)!.async("string"));
  const cells = new Map<string, ImportedCell["original"]>();
  for (const row of list<{ c?: Record<string, unknown>[] }>(data.worksheet.sheetData.row)) {
    for (const cell of list(row.c)) {
      if (typeof cell["@_r"] !== "string") continue;
      cells.set(cell["@_r"], {
        type: xmlText(cell["@_t"]), value: xmlText(cell.v),
        formula: xmlText(cell.f), style: xmlText(cell["@_s"]),
      });
    }
  }
  return cells;
}
function readCells(sheet: Worksheet, addresses: string[], originals: Map<string, ImportedCell["original"]>) {
  return Object.fromEntries(addresses.map((address) => {
    const cell = sheet.getCell(address), value = cell.value;
    const formula = cellFormula(cell);
    return [address, {
      display: cellDisplay(cell), value: jsonValue(value), formula,
      cachedValue: formula && value && typeof value === "object" && "result" in value ? jsonValue(value.result) : null,
      numberFormat: cell.numFmt ?? "", original: originals.get(address) ?? null,
    } satisfies ImportedCell];
  }));
}
function isoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)
    throw new Error(`Unexpected source date: ${value}`);
  return value;
}
function dateCell(sheet: Worksheet, address: string) {
  const value = cellDisplay(sheet.getCell(address));
  return value ? isoDate(value) : null;
}
function quantity(text: string, pattern: RegExp): Quantity {
  const match = pattern.exec(text);
  if (!match) throw new Error("Expected source quantity was not found.");
  const completed = Number(match[1]), total = Number(match[2]);
  if (!Number.isInteger(completed) || !Number.isInteger(total) || completed < 0 || total <= 0 || completed > total)
    throw new Error("Invalid source quantity.");
  return { completed, total };
}
function evidence(sourceId: string, suffix: string, record: Omit<EvidenceRecord, keyof ImportRecord | "sourceId" | "href" | "selection" | "reviewStatus">): EvidenceRecord {
  return {
    ...base(`evidence:${sourceId}:${suffix}`), sourceId, ...record,
    href: viewerHref(sourceId, record.locator),
    selection: "curated-source-extract", reviewStatus: "unreviewed",
  };
}
async function workbookEvidence(soeBytes: Buffer, dailyBytes: Buffer, soeId: string, dailyId: string) {
  const [soeBook, dailyBook, soeRaw, dailyRaw] = await Promise.all([
    loadWorkbook(Uint8Array.from(soeBytes).buffer), loadWorkbook(Uint8Array.from(dailyBytes).buffer),
    originalCells(soeBytes, SOE_SHEET), originalCells(dailyBytes, DAILY_SHEET),
  ]);
  const soe = soeBook.getWorksheet(SOE_SHEET), daily = dailyBook.getWorksheet(DAILY_SHEET);
  if (!soe || !daily) throw new Error("Required workbook sheets are absent.");
  const result: EvidenceRecord[] = [];
  for (const row of [83, 98, 102, 103]) {
    const code = cellDisplay(soe.getCell(`E${row}`));
    const description = cellDisplay(soe.getCell(`F${row}`));
    const explicitCode = code === GROUT_CODE || code === DRILL_CODE ? code : null;
    const actualFinishRaw = cellDisplay(soe.getCell(`O${row}`));
    const forecast = /T$/.test(actualFinishRaw);
    const addresses = Array.from({ length: 15 }, (_, i) => `${columnName(i + 4)}${row}`);
    const rawCells = readCells(soe, [...addresses, ...Array.from({ length: 15 }, (_, i) => `${columnName(i + 4)}5`)], soeRaw);
    const facts: EvidenceFacts = {
      description, activityIdRaw: code,
      originalStart: dateCell(soe, `H${row}`), originalFinish: dateCell(soe, `I${row}`),
      currentStart: dateCell(soe, `K${row}`), currentFinish: dateCell(soe, `L${row}`),
      actualStart: dateCell(soe, `N${row}`), actualFinish: forecast ? null : dateCell(soe, `O${row}`),
      actualFinishRaw, actualFinishIsForecast: forecast,
      finishVarianceRaw: cellDisplay(soe.getCell(`Q${row}`)),
      line: row === 102 ? "M" : row === 103 ? "L" : null,
      candidateActivityCode: explicitCode ?? GROUT_CODE,
      mappingBasis: explicitCode ? "explicit-source-activity-code" : "candidate-roll-up-by-row-location",
      mappingStatus: "unreviewed", workbookAsOfDate: null,
      temporalCaveat: "The workbook has no established issue date. A date in a row description does not date its planning fields.",
    };
    result.push(evidence(soeId, `field-plan:${row}`, {
      kind: "field-plan", observedDate: null, activityCode: explicitCode,
      text: `${description}. Current field-plan dates: ${facts.currentStart} to ${facts.currentFinish}. ${forecast ? `The Actual Finish cell displays ${actualFinishRaw}, a formula-generated forecast marker, not an observed finish.` : ""}`.trim(),
      locator: { sheet: SOE_SHEET, cell: `F${row}` }, facts, rawCells,
    }));
    result.push(evidence(soeId, `mapping:${row}`, {
      kind: "mapping", observedDate: null, activityCode: explicitCode,
      text: explicitCode ? `Source row ${row} explicitly identifies ${explicitCode}. Jae has not reviewed this imported mapping.` : `Source row ${row} uses '${code}'. Association with ${GROUT_CODE} is a candidate based on its position under row 98; it requires Jae's review.`,
      locator: { sheet: SOE_SHEET, cell: `E${row}` },
      facts: { candidateActivityCode: explicitCode ?? GROUT_CODE, mappingStatus: "unreviewed", mappingBasis: facts.mappingBasis, line: facts.line, parentRow: explicitCode ? null : 98 },
      rawCells: readCells(soe, [`E${row}`, `F${row}`, "E98", "F98"], soeRaw),
    }));
    if (explicitCode) {
      const match = /as of (\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(description);
      if (!match) throw new Error("Expected dated SOE observation is absent.");
      const observedDate = isoDate(`${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`);
      const cumulative = quantity(description, /(\d+)\/(\d+)/);
      result.push(evidence(soeId, `field-observation:${row}`, {
        kind: "field-observation", observedDate, activityCode: explicitCode,
        text: description, locator: { sheet: SOE_SHEET, cell: `F${row}` },
        facts: { operation: explicitCode === GROUT_CODE ? "jet-grouting" : "predrilling", cumulative, dateScope: "row-description-only", mappingStatus: "unreviewed" },
        rawCells: readCells(soe, [`E${row}`, `F${row}`], soeRaw),
      }));
    }
  }
  for (const row of [3, 4, 5, 6]) {
    const text = cellDisplay(daily.getCell(`AD${row}`));
    const observedDate = dateCell(daily, `C${row}`);
    if (!observedDate || daily.getCell(`B${row}`).value !== true) throw new Error("Daily observation is undated or unpublished.");
    const reportDate = /^(\d{2})\/(\d{2})\/(\d{4}) [-–] Jet Grout Daily Report/m.exec(text);
    if (!reportDate || `${reportDate[3]}-${reportDate[1]}-${reportDate[2]}` !== observedDate) throw new Error("Daily report date differs from row date.");
    const predrilled = quantity(text, /Predrill:\s*(\d+)\/(\d+)/);
    const jetGrouted = quantity(text, /Jet Grouted\s+(\d+)\/(\d+)/);
    const lines: Record<string, { predrilled: Quantity; jetGrouted: Quantity }> = {};
    for (const match of text.matchAll(/^Line ([A-N]):\s*(\d+)\/(\d+)\s+(\d+)\/(\d+)\s*$/gm)) {
      lines[match[1]] = { predrilled: { completed: Number(match[2]), total: Number(match[3]) }, jetGrouted: { completed: Number(match[4]), total: Number(match[5]) } };
    }
    if (Object.keys(lines).length !== 14) throw new Error("Expected fourteen jet grout line observations.");
    for (const operation of ["predrilled", "jetGrouted"] as const) {
      const sums = Object.values(lines).reduce((sum, entry) => ({ completed: sum.completed + entry[operation].completed, total: sum.total + entry[operation].total }), { completed: 0, total: 0 });
      const cumulative = operation === "predrilled" ? predrilled : jetGrouted;
      if (sums.completed !== cumulative.completed || sums.total !== cumulative.total) throw new Error("Line quantities do not reconcile with reported totals.");
    }
    result.push(evidence(dailyId, `field-observation:${row}`, {
      kind: "field-observation", observedDate, activityCode: null, text,
      locator: { sheet: DAILY_SHEET, cell: `AD${row}` },
      facts: { published: true, predrilled, jetGrouted, lines, candidateActivityCode: GROUT_CODE, candidatePredrillActivityCode: DRILL_CODE, mappingStatus: "unreviewed", quantityBasis: "reported-column-counts", reportingCutoff: null },
      rawCells: readCells(daily, [`B${row}`, `C${row}`, `AC${row}`, `AD${row}`, "B1", "C1", "AC1", "AD1"], dailyRaw),
    }));
  }
  return result;
}

/** Read only registered immutable originals. No network, database, or model calls. */
export async function buildProjectImport(root = process.cwd()): Promise<ProjectImport> {
  const manifest = JSON.parse(await readFile(path.join(root, "apps/web/lib/project-files/source-manifest.json"), "utf8")) as {
    files: { name: string; bytes: number; sha256: string; pages?: number; tables?: Record<string, number> }[];
  };
  if (manifest.files.length !== 8) throw new Error("Expected the eight registered B&P sources.");
  const sources: SourceRecord[] = [];
  const bytesByName = new Map<string, Buffer>();
  for (const entry of manifest.files) {
    if (path.basename(entry.name) !== entry.name || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("Invalid source registration.");
    const bytes = await readFile(path.join(root, DATA_PATH, entry.name));
    if (bytes.length !== entry.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      throw new Error(`Source changed; register a new version before importing: ${entry.name}`);
    const id = entry.sha256.slice(0, 16), kind = path.extname(entry.name).slice(1) as SourceRecord["kind"];
    if (!["xer", "xlsx", "pdf", "docx"].includes(kind)) throw new Error("Unsupported registered source type.");
    sources.push({ ...base(`source:${id}`), id, sourceId: id, name: entry.name, title: titles[entry.name] ?? "Baseline narrative · draft", kind, bytes: entry.bytes, sha256: entry.sha256, ...(entry.pages ? { pages: entry.pages } : {}), relativePath: `${DATA_PATH}/${entry.name}`, href: viewerHref(id), documentDate: null });
    if (["FDT-A-MS-R23.xer", "SOE-Master-Schedule.xlsx", "Daily-Construction-Report-july12-july17.xlsx"].includes(entry.name)) bytesByName.set(entry.name, bytes);
  }
  if (new Set(sources.map((source) => source.id)).size !== sources.length) throw new Error("Duplicate source identity.");
  const required = (name: string) => {
    const source = sources.find((source) => source.name === name), bytes = bytesByName.get(name);
    if (!source || !bytes) throw new Error(`Required source is missing: ${name}`);
    return { source, bytes };
  };
  const { source: xerSource, bytes: xerBytes } = required("FDT-A-MS-R23.xer");
  const { source: soeSource, bytes: soeBytes } = required("SOE-Master-Schedule.xlsx");
  const { source: dailySource, bytes: dailyBytes } = required("Daily-Construction-Report-july12-july17.xlsx");
  const schedule = parseSchedule(xerBytes), text = decodeXer(xerBytes), tables = rawXer(text);
  const expectedCounts = manifest.files.find((file) => file.name === xerSource.name)?.tables;
  for (const [name, count] of Object.entries(expectedCounts ?? {})) if (tables[name]?.length !== count) throw new Error(`XER table count changed: ${name}`);
  const sourceId = xerSource.id, scheduleBase = { sourceId, snapshotId: sourceId };
  const rawTasks = new Map(tables.TASK.map((row) => [`${row.fields.proj_id}:${row.fields.task_id}`, row]));
  const rawWbs = new Map(tables.PROJWBS.map((row) => [`${row.fields.proj_id}:${row.fields.wbs_id}`, row]));
  const rawRelationships = new Map(tables.TASKPRED.map((row) => [row.fields.task_pred_id, row]));
  const activities = schedule.activities.map(({ projectId: p6ProjectId, ...activity }) => {
    const row = rawTasks.get(activity.id);
    if (!row) throw new Error("Activity source row not found.");
    return { ...activity, ...base(`activity:${sourceId}:${activity.id}`), ...scheduleBase, p6ProjectId, calendarId: row.fields.clndr_id, raw: row.fields, href: viewerHref(sourceId, { activity: activity.id }) };
  });
  const relationships = schedule.relationships.map((relationship) => {
    const row = rawRelationships.get(relationship.id);
    if (!row) throw new Error("Relationship source row not found.");
    return { ...relationship, ...base(`relationship:${sourceId}:${relationship.id}`), ...scheduleBase, sourceLine: row.sourceLine, raw: row.fields };
  });
  const wbs = schedule.wbs.map((node) => {
    const row = rawWbs.get(node.id);
    if (!row) throw new Error("WBS source row not found.");
    return { ...node, ...base(`wbs:${sourceId}:${node.id}`), ...scheduleBase, sourceLine: row.sourceLine, raw: row.fields };
  });
  const calendars = tables.CALENDAR.map((row) => ({ ...base(`calendar:${sourceId}:${row.fields.clndr_id}`), ...scheduleBase, id: row.fields.clndr_id, name: row.fields.clndr_name, sourceLine: row.sourceLine, raw: row.fields }));
  const activityIds = new Set(activities.map((activity) => activity.id)), wbsIds = new Set(wbs.map((node) => node.id)), calendarIds = new Set(calendars.map((calendar) => calendar.id));
  if (activities.some((activity) => !wbsIds.has(activity.wbsId) || !calendarIds.has(activity.calendarId)) || relationships.some((relationship) => !activityIds.has(relationship.predecessor) || !activityIds.has(relationship.successor))) throw new Error("Schedule references do not resolve within this import.");
  const importedEvidence = await workbookEvidence(soeBytes, dailyBytes, soeSource.id, dailySource.id);
  for (const record of importedEvidence) if (record.activityCode && !activities.some((activity) => activity.code === record.activityCode)) throw new Error("Explicit field mapping does not resolve to P6.");
  return {
    projectId: PROJECT_ID, importVersion: IMPORT_VERSION, sources,
    snapshot: {
      ...base(`snapshot:${sourceId}`), ...scheduleBase, approvalStatus: "unconfirmed",
      projects: schedule.projects, exportDate: schedule.exportDate, calendarCount: schedule.calendarCount, warnings: schedule.warnings,
      counts: { activities: activities.length, relationships: relationships.length, wbs: wbs.length, calendars: calendars.length },
      rawHeader: text.split(/\r?\n/)[0], rawProjects: tables.PROJECT,
      rawOtherTables: Object.fromEntries(Object.entries(tables).filter(([name]) => !["PROJECT", "TASK", "TASKPRED", "PROJWBS", "CALENDAR"].includes(name))),
      rawTableCounts: Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length])),
    },
    activities, relationships, wbs, calendars, evidence: importedEvidence,
  };
}
