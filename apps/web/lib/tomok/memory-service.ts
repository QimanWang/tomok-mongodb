import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import { z } from "zod";
import { projectActor, type ProjectPrincipal } from "./auth";
import { projectDb } from "./db";
import { TomokError, safeStorageError } from "./errors";
import { evidenceForModel } from "./evidence";
import { selectApplicableMemory } from "./memory-eligibility";
import { appendMemoryRevision, createProposal, getMemory, listMemory } from "./memory-repository";
import type { MemoryCitation, MemoryContent, MemoryOrigin, MemoryRevision, ProjectMemory } from "./memory-types";
import { JET_GROUT_CODE, PROJECT_ID, readContext, readEvidence, readInvestigation, requireRelease, type Release } from "./repository";
import type { Investigation } from "./service";
import { memorySearchCandidates, rankSearchCandidates } from "./semantic-search";
import type { CaseReplay } from "./replay-types";
import { REPLAY_VERSION } from "./replay";

const contentShape = {
  kind: z.enum(["mapping", "interpretation"]),
  title: z.string().trim().min(1).max(120),
  statement: z.string().trim().min(1).max(2_000),
  validFrom: z.iso.date(), validThrough: z.iso.date().nullable(),
  evidenceIds: z.array(z.string().min(1).max(300)).min(1).max(10),
};
const contentSchema = z.strictObject(contentShape).refine((v) => !v.validThrough || v.validFrom <= v.validThrough);
const proposalSchema = z.strictObject({ ...contentShape, investigationId: z.string().regex(/^[a-f0-9]{32}$/) });
const revisionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("review"), expectedRevision: z.number().int().min(1).max(100), reason: z.string().trim().min(1).max(1_000).nullable(), content: contentSchema }),
  z.strictObject({ action: z.enum(["flag", "withdraw"]), expectedRevision: z.number().int().min(1).max(100), reason: z.string().trim().min(1).max(1_000) }),
]);
const retrievalSchema = z.strictObject({ cutoff: z.iso.date(), activityCode: z.string().trim().min(1).max(100).optional(), query: z.string().trim().min(1).max(200).optional() });
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new TomokError("Enter a title, statement, valid date range, and 1–10 source references. Review changes need a reason.", 422);
  return result.data;
}
function contentOf(input: MemoryContent): MemoryContent {
  const content = parse(contentSchema, input);
  return { ...content, evidenceIds: [...new Set(content.evidenceIds)].sort() };
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
function validId(id: string) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new TomokError("Project memory not found.", 404);
}
function sameRelease(release: Release, releaseId: string) {
  if (release.releaseId !== releaseId) throw new TomokError("The project import changed. Create a new investigation before reviewing this knowledge.", 409);
}
async function requireMemory(db: Db, id: string, actorId: string) {
  validId(id);
  const memory = await getMemory(db, id, actorId);
  if (!memory) throw new TomokError("Project memory not found.", 404);
  return memory;
}
async function requireInvestigation(db: Db, id: string, owner: string) {
  validId(id);
  const investigation = await readInvestigation<Investigation>(db, id, owner);
  if (!investigation) throw new TomokError("Investigation not found.", 404);
  return investigation;
}
function memoryOrigin(investigation: Investigation): MemoryOrigin {
  const kind = (investigation as Partial<CaseReplay>).replay?.version === REPLAY_VERSION ? "replay" : "investigation";
  return { id: investigation.id, title: investigation.title, cutoff: investigation.cutoff, kind,
    href: `/${kind === "replay" ? "replays" : "investigations"}/${investigation.id}` };
}
async function evidenceChoices(db: Db, release: Release, cutoff: string) {
  return (await readEvidence(db, release, cutoff))
    .filter((row) => row.activityCode === JET_GROUT_CODE || row.facts.candidateActivityCode === JET_GROUT_CODE)
    .map(evidenceForModel).map((row) => ({
      id: row._id, sourceId: row.sourceId,
      label: `${row.locator.sheet}!${row.locator.cell}`,
      text: row.text, href: row.href, observedDate: row.observedDate, kind: row.kind,
    }));
}
function resolveCitations(content: MemoryContent, choices: Awaited<ReturnType<typeof evidenceChoices>>): MemoryCitation[] {
  return content.evidenceIds.map((id) => {
    const source = choices.find((row) => row.id === id);
    if (!source) throw new TomokError("A selected source is outside this investigation's activity, import, or reporting date.", 422);
    return { evidenceId: id, sourceId: source.sourceId, label: source.label, href: source.href, observedDate: source.observedDate };
  });
}
export type MemorySummary = Pick<MemoryContent, "kind" | "title" | "statement" | "validFrom" | "validThrough"> & {
  id: string; revision: number; reviewedBy: { id: string; name: string }; reviewedAt: string;
  href: string; citations: MemoryCitation[];
};
export function memorySummary(memory: ProjectMemory): MemorySummary {
  const { kind, title, statement, validFrom, validThrough, revision, actor, recordedAt, citations } = memory.latest;
  return { id: memory.id, revision, kind, title, statement, validFrom, validThrough, reviewedBy: actor, reviewedAt: recordedAt, href: `/memory/${memory.id}`, citations };
}
export async function readApplicableMemory(db: Db, release: Release, actorId: string, cutoff: string, activityCode: string) {
  const selection = selectApplicableMemory(await listMemory(db, actorId), { releaseId: release.releaseId, activityCode, cutoff });
  return { memories: selection.applicable.map(memorySummary).sort((a, b) => a.id.localeCompare(b.id)), excluded: selection.excluded };
}
export async function getProjectMemory(input: { cutoff: string; activityCode?: string; query?: string }, principal: ProjectPrincipal) {
  const viewer = projectActor(principal);
  const { cutoff, activityCode = JET_GROUT_CODE, query } = parse(retrievalSchema, input);
  try {
    const db = await projectDb(); const release = await requireRelease(db);
    const eligible = await readApplicableMemory(db, release, viewer.id, cutoff, activityCode);
    const ranked = await rankSearchCandidates(db, release, "memory", cutoff, query, memorySearchCandidates(eligible.memories));
    // A human can flag or revise a note while the remote search runs. Recheck the authoritative revision.
    const current = query ? await readApplicableMemory(db, release, viewer.id, cutoff, activityCode) : eligible;
    const memories = ranked.values.filter((row) => current.memories.some((note) => note.id === row.id && note.revision === row.revision));
    return { projectId: PROJECT_ID, releaseId: release.releaseId, cutoff, activityCode,
      memories, excluded: current.excluded, retrieval: { ...ranked.retrieval, returnedCount: memories.length },
      scopeNote: "Current reviewed knowledge applied to this reporting date, not what was known then. Latest 100 accessible notes considered. Sources and human interpretations remain distinct; review does not establish an undated plan's issue date or recalculate CPM. Excluded note text and superseded revisions are not supplied.",
    };
  } catch (error) { return safeStorageError(error); }
}
export async function listProjectMemory(principal: ProjectPrincipal) {
  const viewer = projectActor(principal);
  try {
    const db = await projectDb(); const release = await requireRelease(db);
    return { memories: await listMemory(db, viewer.id), viewer, activeReleaseId: release.releaseId };
  } catch (error) { return safeStorageError(error); }
}
export async function getMemoryContext(id: string, principal: ProjectPrincipal) {
  const viewer = projectActor(principal);
  try {
    const db = await projectDb(); const release = await requireRelease(db);
    const investigation = await requireInvestigation(db, id, viewer.id);
    sameRelease(release, investigation.releaseId);
    const { activity } = await readContext(db, release, JET_GROUT_CODE);
    return { investigation: memoryOrigin(investigation),
      activity: { code: activity.code, name: activity.name, href: activity.href },
      evidence: await evidenceChoices(db, release, investigation.cutoff), viewer, activeReleaseId: release.releaseId };
  } catch (error) { return safeStorageError(error); }
}
export async function proposeProjectMemory(input: MemoryContent & { investigationId: string }, principal: ProjectPrincipal) {
  const viewer = projectActor(principal);
  const { investigationId, ...rawContent } = parse(proposalSchema, input);
  const content = contentOf(rawContent);
  try {
    const db = await projectDb(); const release = await requireRelease(db);
    const investigation = await requireInvestigation(db, investigationId, viewer.id);
    sameRelease(release, investigation.releaseId);
    const citations = resolveCitations(content, await evidenceChoices(db, release, investigation.cutoff));
    const id = hash([PROJECT_ID, viewer.id, investigationId, content]);
    const createdAt = new Date().toISOString();
    const latest: MemoryRevision = { ...content, revision: 1, status: "proposed", actor: viewer, recordedAt: createdAt, reason: null, citations, operationId: id };
    const memory = await createProposal(db, { _id: id, id, projectId: PROJECT_ID, releaseId: release.releaseId,
      snapshotId: investigation.basis.snapshotId, activityCode: JET_GROUT_CODE, originInvestigationId: investigationId,
      createdBy: viewer, createdAt, visibility: "private", latest, revisions: [latest] });
    return { memory, href: `/memory/${id}` };
  } catch (error) { return safeStorageError(error); }
}
export async function getProjectMemoryDetail(id: string, principal: ProjectPrincipal) {
  const viewer = projectActor(principal);
  try {
    const db = await projectDb(); const release = await requireRelease(db);
    const memory = await requireMemory(db, id, viewer.id);
    // Access was checked on the shared note; its origin supplies only the immutable cutoff.
    const origin = await requireInvestigation(db, memory.originInvestigationId, memory.createdBy.id);
    return { memory, evidence: await evidenceChoices(db, { ...release, releaseId: memory.releaseId }, origin.cutoff), viewer, activeReleaseId: release.releaseId,
      origin: memory.createdBy.id === viewer.id ? memoryOrigin(origin) : null };
  } catch (error) { return safeStorageError(error); }
}
export async function reviseProjectMemory(id: string, input: unknown, principal: ProjectPrincipal) {
  const viewer = projectActor(principal);
  const change = parse(revisionSchema, input);
  const normalized = change.action === "review" ? { ...change, content: contentOf(change.content) } : change;
  const operationId = hash([id, viewer.id, normalized]);
  try {
    const db = await projectDb(); const release = await requireRelease(db);
    const memory = await requireMemory(db, id, viewer.id);
    if (memory.revisions.some((r) => r.operationId === operationId && r.actor.id === viewer.id)) return { memory };
    if (memory.latest.revision !== change.expectedRevision) throw new TomokError("Project memory changed. Reload it before submitting your review.", 409);
    if (change.action === "review" && memory.latest.status !== "proposed" && !change.reason) throw new TomokError("Explain why this reviewed knowledge is changing.", 422);
    let content: MemoryContent = { kind: memory.latest.kind, title: memory.latest.title, statement: memory.latest.statement, validFrom: memory.latest.validFrom, validThrough: memory.latest.validThrough, evidenceIds: memory.latest.evidenceIds };
    let citations = memory.latest.citations;
    if (change.action === "review") {
      sameRelease(release, memory.releaseId);
      const origin = await requireInvestigation(db, memory.originInvestigationId, memory.createdBy.id);
      content = contentOf(change.content);
      citations = resolveCitations(content, await evidenceChoices(db, release, origin.cutoff));
    }
    const revision: MemoryRevision = { ...content, revision: change.expectedRevision + 1,
      status: change.action === "review" ? "reviewed" : change.action === "flag" ? "needs_review" : "withdrawn",
      actor: viewer, recordedAt: new Date().toISOString(), reason: change.reason, citations, operationId };
    return { memory: await appendMemoryRevision(db, { id, actorId: viewer.id, expectedRevision: change.expectedRevision, revision }) };
  } catch (error) { return safeStorageError(error); }
}
