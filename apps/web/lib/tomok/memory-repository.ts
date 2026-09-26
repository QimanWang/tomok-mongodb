import type { Db, Filter } from "mongodb";
import { z } from "zod";
import { TomokError } from "./errors";
import type { MemoryRevision, ProjectMemory } from "./memory-types";

const PROJECT_ID = "bp-tunnel" as const;
const COLLECTION = "project_memory";
const REVISION_LIMIT = 100;
const identifier = z.string().min(1).max(512);
const actorSchema = z.strictObject({ id: identifier, name: z.string().min(1).max(256) });
const revisionSchema = z.strictObject({
  kind: z.enum(["mapping", "interpretation"]),
  title: z.string().min(1).max(500),
  statement: z.string().min(1).max(12_000),
  validFrom: z.iso.date(),
  validThrough: z.iso.date().nullable(),
  evidenceIds: z.array(identifier).min(1).max(32),
  revision: z.number().int().min(1),
  status: z.enum(["proposed", "reviewed", "needs_review", "withdrawn"]),
  actor: actorSchema,
  recordedAt: z.iso.datetime({ offset: true }),
  reason: z.string().max(5_000).nullable(),
  citations: z.array(z.strictObject({
    evidenceId: identifier,
    sourceId: identifier,
    label: z.string().min(1).max(512),
    href: z.string().min(1).max(1_024),
    observedDate: z.iso.date().nullable(),
  })).min(1).max(32),
  operationId: z.string().min(1).max(256),
}).superRefine((revision, context) => {
  if (revision.validThrough && revision.validFrom > revision.validThrough)
    context.addIssue({ code: "custom", message: "Validity dates are reversed." });
  const evidence = new Set(revision.evidenceIds);
  const citations = new Set(revision.citations.map((citation) => citation.evidenceId));
  if (evidence.size !== revision.evidenceIds.length || citations.size !== revision.citations.length ||
    evidence.size !== citations.size || [...evidence].some((id) => !citations.has(id)))
    context.addIssue({ code: "custom", message: "Evidence and citation identities must match." });
});
const memorySchema = z.strictObject({
  _id: identifier,
  id: identifier,
  projectId: z.literal(PROJECT_ID),
  releaseId: identifier,
  snapshotId: identifier,
  activityCode: identifier,
  originInvestigationId: identifier,
  createdBy: actorSchema,
  createdAt: z.iso.datetime({ offset: true }),
  visibility: z.enum(["private", "project"]),
  latest: revisionSchema,
  revisions: z.array(revisionSchema).min(1).max(REVISION_LIMIT),
});

function invalid() {
  return new TomokError("The project memory record is invalid.", 400);
}
function visibility(actorId: string): Filter<ProjectMemory> {
  return { projectId: PROJECT_ID, $or: [{ visibility: "project" }, { visibility: "private", "createdBy.id": actorId }] };
}
function requireActor(actorId: string) {
  if (!actorId.trim()) throw new TomokError("Sign in to access project memory.", 401);
}
function mongoCode(error: unknown, code: number) {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

async function ensureCollection(db: Db) {
  try {
    await db.createCollection(COLLECTION, {
      validator: {
        $jsonSchema: {
          bsonType: "object",
          required: ["_id", "id", "projectId", "releaseId", "snapshotId", "activityCode", "originInvestigationId", "createdBy", "createdAt", "visibility", "latest", "revisions"],
          properties: {
            _id: { bsonType: "string" }, id: { bsonType: "string" }, projectId: { enum: [PROJECT_ID] },
            releaseId: { bsonType: "string" }, snapshotId: { bsonType: "string" },
            activityCode: { bsonType: "string" }, originInvestigationId: { bsonType: "string" },
            createdAt: { bsonType: "string" },
            createdBy: { bsonType: "object", required: ["id", "name"], properties: { id: { bsonType: "string" }, name: { bsonType: "string" } } },
            visibility: { enum: ["private", "project"] },
            latest: { bsonType: "object", required: ["revision", "status", "operationId", "recordedAt"], properties: {
              revision: { bsonType: ["int", "long", "double"], minimum: 1, maximum: REVISION_LIMIT },
              status: { enum: ["proposed", "reviewed", "needs_review", "withdrawn"] },
              operationId: { bsonType: "string" }, recordedAt: { bsonType: "string" },
            } },
            revisions: { bsonType: "array", minItems: 1, maxItems: REVISION_LIMIT, items: { bsonType: "object" } },
          },
        },
      },
    });
  } catch (error) {
    if (!mongoCode(error, 48)) throw error;
  }
  await db.collection(COLLECTION).createIndex({ projectId: 1, visibility: 1, "latest.recordedAt": -1 });
  await db.collection(COLLECTION).createIndex({ projectId: 1, "createdBy.id": 1, "latest.recordedAt": -1 });
  await db.collection(COLLECTION).createIndex({ projectId: 1, releaseId: 1, activityCode: 1, "latest.status": 1 });
}

export async function getMemory(db: Db, id: string, actorId: string): Promise<ProjectMemory | null> {
  requireActor(actorId);
  return db.collection<ProjectMemory>(COLLECTION).findOne({ ...visibility(actorId), _id: id });
}

export async function listMemory(db: Db, actorId: string): Promise<ProjectMemory[]> {
  requireActor(actorId);
  return db.collection<ProjectMemory>(COLLECTION).find(visibility(actorId))
    .sort({ "latest.recordedAt": -1, _id: 1 }).limit(100).toArray();
}

/** The authenticated service supplies IDs, actors, and resolved source citations. */
export async function createProposal(db: Db, doc: ProjectMemory): Promise<ProjectMemory> {
  const parsed = memorySchema.safeParse(doc);
  if (!parsed.success) throw invalid();
  const value = parsed.data;
  if (value._id !== value.id || value.visibility !== "private" || value.latest.status !== "proposed" ||
    value.latest.revision !== 1 || value.revisions.length !== 1 || value.latest.actor.id !== value.createdBy.id ||
    JSON.stringify(value.latest) !== JSON.stringify(value.revisions[0])) throw invalid();
  await ensureCollection(db);
  try {
    await db.collection<ProjectMemory>(COLLECTION).updateOne(
      { _id: value._id, projectId: PROJECT_ID, "createdBy.id": value.createdBy.id },
      { $setOnInsert: value }, { upsert: true },
    );
  } catch (error) {
    if (!mongoCode(error, 11000)) throw error;
    // An identical concurrent proposal may have won its insert. Never return a
    // colliding record owned by someone else, even after it becomes shared.
  }
  const saved = await db.collection<ProjectMemory>(COLLECTION).findOne({ _id: value._id, projectId: PROJECT_ID, "createdBy.id": value.createdBy.id });
  if (!saved) throw new TomokError("A project memory record with this identity already exists.", 409);
  return saved;
}

export async function appendMemoryRevision(db: Db, input: {
  id: string;
  actorId: string;
  expectedRevision: number;
  revision: MemoryRevision;
}): Promise<ProjectMemory> {
  requireActor(input.actorId);
  const parsed = revisionSchema.safeParse(input.revision);
  if (!parsed.success || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 1 ||
    parsed.data.actor.id !== input.actorId) throw invalid();
  const revision = parsed.data;
  const current = await getMemory(db, input.id, input.actorId);
  if (!current) throw new TomokError("Project memory not found.", 404);
  const previousOperation = current.revisions.find((item) => item.operationId === revision.operationId);
  if (previousOperation) {
    if (previousOperation.actor.id !== input.actorId) throw new TomokError("This review operation belongs to another reviewer.", 409);
    return current;
  }
  if (current.latest.revision !== input.expectedRevision)
    throw new TomokError("Project memory changed. Reload it before submitting your review.", 409);
  if (current.revisions.length >= REVISION_LIMIT)
    throw new TomokError("This project memory has reached its revision limit. Create a new proposal.", 409);
  if (revision.revision !== input.expectedRevision + 1) throw invalid();

  // Visibility and revision preconditions are checked in the same write as both
  // history append and latest replacement. No multi-document transaction is needed.
  const updated = await db.collection<ProjectMemory>(COLLECTION).findOneAndUpdate({
    ...visibility(input.actorId), _id: input.id,
    "latest.revision": input.expectedRevision,
    "revisions.operationId": { $ne: revision.operationId },
    [`revisions.${REVISION_LIMIT - 1}`]: { $exists: false },
  }, {
    $push: { revisions: revision },
    $set: { latest: revision, visibility: current.visibility === "project" || revision.status === "reviewed" ? "project" : "private" },
  }, { returnDocument: "after" });
  if (updated) return updated;

  // A concurrent retry of the same operation succeeds without appending again.
  const winner = await getMemory(db, input.id, input.actorId);
  if (winner?.revisions.some((item) => item.operationId === revision.operationId && item.actor.id === input.actorId)) return winner;
  throw new TomokError("Project memory changed. Reload it before submitting your review.", 409);
}
