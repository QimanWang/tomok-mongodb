import { createHash } from "node:crypto";
import type { Db, Document } from "mongodb";
import type { Activity, Schedule } from "../project-files/types";
import type { ActivityRecord, EvidenceRecord, ProjectImport, SnapshotRecord, RelationshipRecord, WbsRecord, CalendarRecord } from "./import-types";
import { TomokError } from "./errors";

export const PROJECT_ID = "bp-tunnel";
export const JET_GROUT_CODE = "2A-SP01-GRND-710C-XP";
export type Counts = { sources: number; activities: number; relationships: number; wbs: number; calendars: number; evidence: number };
export type Release = { _id: string; projectId: string; releaseId: string; importVersion: string; counts: Counts; activatedAt: string };
type Stored<T> = T & { releaseId: string };
type Row = Document & { _id: string };

const groups = [
  ["sources", "project_sources"], ["activities", "schedule_activities"],
  ["relationships", "schedule_relationships"], ["wbs", "schedule_wbs"],
  ["calendars", "schedule_calendars"], ["evidence", "evidence_chunks"],
] as const;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function importFingerprint(data: ProjectImport) {
  return createHash("sha256").update(stable(data)).digest("hex");
}

function validateImport(data: ProjectImport) {
  if (data.projectId !== PROJECT_ID || !data.activities.length || !data.evidence.length || !data.sources.length) throw new TomokError("Import is incomplete or belongs to another project.", 400);
  const sources = new Set(data.sources.map((row) => row.sourceId));
  const activities = new Set(data.activities.map((row) => row.id));
  const wbs = new Set(data.wbs.map((row) => row.id));
  const calendars = new Set(data.calendars.map((row) => row.id));
  for (const [key] of groups) {
    const ids = new Set<string>();
    for (const row of data[key]) {
      if (!row._id || ids.has(row._id) || row.projectId !== PROJECT_ID || row.importVersion !== data.importVersion || !sources.has(row.sourceId)) throw new TomokError(`Invalid ${key} import references.`, 400);
      ids.add(row._id);
    }
  }
  if (!sources.has(data.snapshot.sourceId) || data.snapshot.projectId !== PROJECT_ID || data.snapshot.importVersion !== data.importVersion) throw new TomokError("Invalid snapshot import references.", 400);
  for (const [key] of groups.slice(1, 5)) {
    if (data.snapshot.counts[key as keyof typeof data.snapshot.counts] !== data[key].length) throw new TomokError("Snapshot counts do not match the imported records.", 400);
  }
  for (const activity of data.activities) {
    if ((activity.wbsId && !wbs.has(activity.wbsId)) || (activity.calendarId && !calendars.has(activity.calendarId)) || activity.snapshotId !== data.snapshot.snapshotId) throw new TomokError("Activity references are incomplete.", 400);
  }
  for (const edge of data.relationships) {
    if (!activities.has(edge.predecessor) || !activities.has(edge.successor) || edge.snapshotId !== data.snapshot.snapshotId) throw new TomokError("Schedule relationship references are incomplete.", 400);
  }
}

async function ensureCollections(db: Db) {
  for (const name of [...groups.map(([, name]) => name), "schedule_snapshots", "investigations"]) {
    try {
      await db.createCollection(name, {
        validator: { $jsonSchema: { bsonType: "object", required: ["_id", "projectId", "releaseId"], properties: { _id: { bsonType: "string" }, projectId: { enum: [PROJECT_ID] }, releaseId: { bsonType: "string" } } } },
      });
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === 48)) throw error;
    }
    await db.collection(name).createIndex({ projectId: 1, releaseId: 1 });
  }
  await db.collection("schedule_activities").createIndex({ projectId: 1, releaseId: 1, code: 1 });
  await db.collection("schedule_relationships").createIndex({ projectId: 1, releaseId: 1, predecessor: 1 });
  await db.collection("schedule_relationships").createIndex({ projectId: 1, releaseId: 1, successor: 1 });
  await db.collection("evidence_chunks").createIndex({ projectId: 1, releaseId: 1, observedDate: 1 });
}

// Immutable batches are published by one atomic pointer update. Readers never see half an import.
export async function persistProjectImport(db: Db, data: ProjectImport): Promise<Release> {
  validateImport(data);
  const releaseId = importFingerprint(data);
  await ensureCollections(db);
  const counts = {} as Counts;
  const batches: [string, readonly { _id: string }[]][] = groups.map(([key, name]) => [name, data[key]]);
  batches.push(["schedule_snapshots", [data.snapshot]]);
  for (const [name, rows] of batches) {
    for (let offset = 0; offset < rows.length; offset += 500) {
      await db.collection<Row>(name).bulkWrite(rows.slice(offset, offset + 500).map((row) => {
        const _id = `${releaseId}:${row._id}`;
        return { updateOne: { filter: { _id }, update: { $setOnInsert: { ...row, _id, releaseId } }, upsert: true } };
      }), { ordered: true });
    }
    const actual = await db.collection(name).countDocuments({ projectId: PROJECT_ID, releaseId });
    if (actual !== rows.length) throw new TomokError("Imported record counts did not match. The previous project import remains active.");
  }
  for (const [key] of groups) counts[key] = data[key].length;
  const existing = await db.collection<Release>("project_imports").findOne({ _id: PROJECT_ID, releaseId });
  if (existing) return existing;
  const release = { _id: PROJECT_ID, projectId: PROJECT_ID, releaseId, importVersion: data.importVersion, counts, activatedAt: new Date().toISOString() };
  await db.collection<Release>("project_imports").replaceOne({ _id: PROJECT_ID }, release, { upsert: true });
  return release;
}

export async function activeRelease(db: Db) {
  return db.collection<Release>("project_imports").findOne({ _id: PROJECT_ID, projectId: PROJECT_ID });
}

export async function requireRelease(db: Db) {
  const release = await activeRelease(db);
  if (!release) throw new TomokError("Project evidence has not been imported. Ask your administrator to import the source files.");
  return release;
}

const scope = (release: Release) => ({ projectId: PROJECT_ID, releaseId: release.releaseId } as const);

export async function readContext(db: Db, release: Release, activityCode: string) {
  const filter = scope(release);
  const activity = await db.collection<Stored<ActivityRecord>>("schedule_activities").findOne({ ...filter, code: activityCode });
  if (!activity) throw new TomokError("That activity code is not in the imported schedule.", 404);
  const [snapshot, relationships, calendar] = await Promise.all([
    db.collection<Stored<SnapshotRecord>>("schedule_snapshots").findOne({ ...filter, snapshotId: activity.snapshotId }),
    db.collection<Stored<RelationshipRecord>>("schedule_relationships").find({ ...filter, $or: [{ predecessor: activity.id }, { successor: activity.id }] }).limit(200).toArray(),
    db.collection<Stored<CalendarRecord>>("schedule_calendars").findOne({ ...filter, id: activity.calendarId }),
  ]);
  if (!snapshot) throw new TomokError("The imported schedule snapshot is missing.");
  const ids = [...new Set(relationships.flatMap((row) => [row.predecessor, row.successor]))];
  const neighbors = await db.collection<Stored<ActivityRecord>>("schedule_activities").find({ ...filter, id: { $in: ids.filter((id) => id !== activity.id) } }).limit(200).toArray();
  return { activity, snapshot, relationships, neighbors, calendar };
}

export async function readEvidence(db: Db, release: Release, cutoff: string, query?: string) {
  const rows = await db.collection<Stored<EvidenceRecord>>("evidence_chunks").find({
    ...scope(release), $or: [{ observedDate: { $lte: cutoff, $type: "string" } }, { observedDate: null }],
  }).sort({ observedDate: 1, _id: 1 }).limit(100).toArray();
  if (!query?.trim()) return rows;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((row) => terms.every((term) => `${row.text} ${row.activityCode ?? ""} ${row.facts.candidateActivityCode ?? ""}`.toLowerCase().includes(term)));
}

export async function readPersistedSchedule(db: Db, release: Release, sourceId: string): Promise<Schedule> {
  const filter = { ...scope(release), sourceId };
  const [snapshot, activities, relationships, wbs] = await Promise.all([
    db.collection<Stored<SnapshotRecord>>("schedule_snapshots").findOne(filter),
    db.collection<Stored<ActivityRecord>>("schedule_activities").find(filter).sort({ sourceLine: 1 }).toArray(),
    db.collection<Stored<RelationshipRecord>>("schedule_relationships").find(filter).sort({ sourceLine: 1 }).toArray(),
    db.collection<Stored<WbsRecord>>("schedule_wbs").find(filter).sort({ sourceLine: 1 }).toArray(),
  ]);
  if (!snapshot) throw new TomokError("That schedule is not in the imported project.", 404);
  const cleanActivities: Activity[] = activities.map((row) => ({
    id: row.id, projectId: row.p6ProjectId, code: row.code, name: row.name, wbsId: row.wbsId, status: row.status, type: row.type, calendar: row.calendar,
    floatHours: row.floatHours, originalHours: row.originalHours, remainingHours: row.remainingHours, percent: row.percent, percentType: row.percentType,
    longestPath: row.longestPath, dates: row.dates, constraints: row.constraints, sourceLine: row.sourceLine,
  }));
  return {
    projects: snapshot.projects, exportDate: snapshot.exportDate, calendarCount: snapshot.calendarCount, warnings: snapshot.warnings,
    activities: cleanActivities,
    relationships: relationships.map(({ id, predecessor, successor, type, lagHours }) => ({ id, predecessor, successor, type, lagHours })),
    wbs: wbs.map(({ id, parentId, code, name, order }) => ({ id, parentId, code, name, order })),
  };
}

export async function saveInvestigation<T extends { id: string; projectId: string; createdAt: string }>(db: Db, release: Release, owner: string, investigation: T): Promise<T> {
  await db.collection<Row>("investigations").updateOne({ _id: investigation.id }, { $setOnInsert: { _id: investigation.id, ...scope(release), owner, investigation } }, { upsert: true });
  const saved = await readInvestigation<T>(db, investigation.id, owner);
  if (!saved) throw new TomokError("The investigation could not be saved.");
  return saved;
}

export async function readInvestigation<T>(db: Db, id: string, owner: string): Promise<T | null> {
  const result = await db.collection<Row>("investigations").findOne({ _id: id, projectId: PROJECT_ID, owner });
  return (result?.investigation as T | undefined) ?? null;
}
