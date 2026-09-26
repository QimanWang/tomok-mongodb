import type { Activity, ProjectFile, Relationship, Schedule, Wbs } from "../project-files/types";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type ImportRecord = {
  _id: string;
  projectId: "bp-tunnel";
  importVersion: string;
};
export type RawXerRow = { sourceLine: number; fields: Record<string, string> };
export type SourceRecord = ImportRecord & ProjectFile & {
  sourceId: string;
  relativePath: string;
  href: string;
  documentDate: null;
};
export type ScheduleRecord = ImportRecord & {
  sourceId: string;
  snapshotId: string;
};
export type ActivityRecord = ScheduleRecord & Omit<Activity, "projectId"> & {
  p6ProjectId: string;
  calendarId: string;
  raw: Record<string, string>;
  href: string;
};
export type RelationshipRecord = ScheduleRecord & Relationship & {
  sourceLine: number;
  raw: Record<string, string>;
};
export type WbsRecord = ScheduleRecord & Wbs & {
  sourceLine: number;
  raw: Record<string, string>;
};
export type CalendarRecord = ScheduleRecord & {
  id: string;
  name: string;
  sourceLine: number;
  raw: Record<string, string>;
};
export type SnapshotRecord = ScheduleRecord & Pick<Schedule, "projects" | "exportDate" | "calendarCount" | "warnings"> & {
  approvalStatus: "unconfirmed";
  counts: { activities: number; relationships: number; wbs: number; calendars: number };
  rawHeader: string;
  rawProjects: RawXerRow[];
  // Core tables are stored on their corresponding records. Preserve the other
  // XER tables as source material, without claiming to interpret their semantics.
  rawOtherTables: Record<string, RawXerRow[]>;
  rawTableCounts: Record<string, number>;
};
export type ImportedCell = {
  display: string;
  value: JsonValue;
  formula: string | null;
  cachedValue: JsonValue;
  numberFormat: string;
  original: {
    type: string | null;
    value: string | null;
    formula: string | null;
    style: string | null;
  } | null;
};
export type Quantity = { completed: number; total: number };
export type EvidenceFacts = {
  [key: string]: JsonValue;
};
export type EvidenceRecord = ImportRecord & {
  sourceId: string;
  kind: "field-observation" | "field-plan" | "mapping";
  observedDate: string | null;
  activityCode: string | null;
  text: string;
  locator: { sheet: string; cell: string };
  href: string;
  facts: EvidenceFacts;
  rawCells: Record<string, ImportedCell>;
  selection: "curated-source-extract";
  reviewStatus: "unreviewed";
};
export type ProjectImport = {
  projectId: "bp-tunnel";
  importVersion: string;
  sources: SourceRecord[];
  snapshot: SnapshotRecord;
  activities: ActivityRecord[];
  relationships: RelationshipRecord[];
  wbs: WbsRecord[];
  calendars: CalendarRecord[];
  evidence: EvidenceRecord[];
};
