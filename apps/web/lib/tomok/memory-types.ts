export type MemoryKind = "mapping" | "interpretation";
export type MemoryStatus = "proposed" | "reviewed" | "needs_review" | "withdrawn";
export type MemoryActor = { id: string; name: string };
export type MemoryContent = {
  kind: MemoryKind;
  title: string;
  statement: string;
  validFrom: string;
  validThrough: string | null;
  evidenceIds: string[];
};
export type MemoryCitation = {
  evidenceId: string;
  sourceId: string;
  label: string;
  href: string;
  observedDate: string | null;
};
export type MemoryRevision = MemoryContent & {
  revision: number;
  status: MemoryStatus;
  actor: MemoryActor;
  recordedAt: string;
  reason: string | null;
  citations: MemoryCitation[];
  operationId: string;
};
export type ProjectMemory = {
  _id: string;
  id: string;
  projectId: "bp-tunnel";
  releaseId: string;
  snapshotId: string;
  activityCode: string;
  originInvestigationId: string;
  createdBy: MemoryActor;
  createdAt: string;
  visibility: "private" | "project";
  latest: MemoryRevision;
  revisions: MemoryRevision[];
};
