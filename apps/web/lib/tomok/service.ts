import { createHash } from "node:crypto";
import { z } from "zod";
import { requirePrincipal, type ProjectPrincipal } from "./auth";
import { projectDb, storageConfiguration } from "./db";
import { TomokError, safeStorageError } from "./errors";
import { buildInvestigation } from "./investigation";
import { evidenceForModel } from "./evidence";
export { evidenceForModel } from "./evidence";
import { readApplicableMemory, type MemorySummary } from "./memory-service";
import { activeRelease, requireRelease, readContext, readEvidence, readInvestigation, saveInvestigation, PROJECT_ID, JET_GROUT_CODE } from "./repository";

export const investigationInput = z.strictObject({ cutoff: z.iso.date(), question: z.string().trim().min(1).max(2_000) });
const evidenceInput = z.strictObject({ cutoff: z.iso.date(), query: z.string().trim().max(200).optional() });
const scheduleInput = z.strictObject({ activityCode: z.string().trim().min(1).max(100) });
// Bump when the investigation's interpretation rules change; old saved findings stay immutable.
const INVESTIGATION_VERSION = "jet-grout-v2";
export type Investigation = ReturnType<typeof buildInvestigation> & { id: string; projectId: string; createdAt: string; releaseId: string; reviewedMemory?: MemorySummary[] };


function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new TomokError("Enter a valid reporting date and bounded request text.", 400);
  return result.data;
}

export async function getProjectStatus(principal: ProjectPrincipal) {
  requirePrincipal(principal);
  const config = storageConfiguration();
  if (!config.configured) return { ...config, imported: false };
  try {
    const release = await activeRelease(await projectDb());
    return { ...config, imported: Boolean(release), counts: release?.counts };
  } catch (error) { return safeStorageError(error); }
}

export async function getScheduleContext(input: { activityCode: string }, principal: ProjectPrincipal) {
  requirePrincipal(principal);
  const { activityCode } = parse(scheduleInput, input);
  try {
    const db = await projectDb();
    const release = await requireRelease(db);
    const context = await readContext(db, release, activityCode);
    const { snapshot, activity, neighbors, relationships, calendar } = context;
    return {
      projectId: PROJECT_ID, releaseId: release.releaseId,
      basis: { snapshotId: snapshot.snapshotId, projects: snapshot.projects, exportDate: snapshot.exportDate, approvalStatus: snapshot.approvalStatus },
      activity, relationships, neighbors,
      calendar: calendar ? { id: calendar.id, name: calendar.name, raw: calendar.raw, sourceLine: calendar.sourceLine } : null,
      limitations: ["Schedule status and float describe this exported snapshot; no CPM recalculation has been performed.", "Baseline approval and the applicability of this snapshot require project-team confirmation."],
    };
  } catch (error) { return safeStorageError(error); }
}

export async function getProjectEvidence(input: { query?: string; cutoff: string }, principal: ProjectPrincipal) {
  requirePrincipal(principal);
  const { query, cutoff } = parse(evidenceInput, input);
  try {
    const db = await projectDb();
    const release = await requireRelease(db);
    return {
      projectId: PROJECT_ID, releaseId: release.releaseId, cutoff,
      evidence: (await readEvidence(db, release, cutoff)).map(evidenceForModel).filter((record) => !query || query.toLowerCase().split(/\s+/).every((term) => `${record.text} ${record.activityCode ?? ""} ${record.facts.candidateActivityCode ?? ""}`.toLowerCase().includes(term))),
      scopeNote: "Curated South Portal jet-grout extracts only. The cutoff filters dated daily observations. The supplied field plan is undated and is not proof of what was known by that date. Candidate activity mappings are unreviewed. Text search requires all supplied terms; an empty result does not prove absence elsewhere in the project files.",
    };
  } catch (error) { return safeStorageError(error); }
}

export async function investigateJetGrouting(input: { cutoff: string; question: string }, principal: ProjectPrincipal) {
  const owner = requirePrincipal(principal);
  const { cutoff, question } = parse(investigationInput, input);
  try {
    const db = await projectDb();
    const release = await requireRelease(db);
    const [{ activity, snapshot }, evidence] = await Promise.all([readContext(db, release, JET_GROUT_CODE), readEvidence(db, release, cutoff)]);
    if (!evidence.some((row) => row.kind === "field-observation" && row.facts.published === true && row.observedDate && row.observedDate <= cutoff)) throw new TomokError("No imported daily observations are available on or before that reporting date.", 422);
    const result = buildInvestigation({ cutoff, question, activity, snapshot, evidence });
    const { memories: reviewedMemory } = await readApplicableMemory(db, release, owner, cutoff, JET_GROUT_CODE);
    const id = createHash("sha256").update(JSON.stringify([INVESTIGATION_VERSION, PROJECT_ID, release.releaseId, owner, cutoff, question, reviewedMemory.map(({ id, revision }) => [id, revision])])).digest("hex").slice(0, 32);
    const investigation = await saveInvestigation(db, release, owner, { ...result, reviewedMemory, id, projectId: PROJECT_ID, releaseId: release.releaseId, createdAt: new Date().toISOString() });
    return { href: `/investigations/${id}`, investigation };
  } catch (error) { return safeStorageError(error); }
}

export async function getInvestigation(id: string, principal: ProjectPrincipal) {
  const owner = requirePrincipal(principal);
  if (!/^[a-f0-9]{32}$/.test(id)) throw new TomokError("Investigation not found.", 404);
  try {
    const investigation = await readInvestigation<Investigation>(await projectDb(), id, owner);
    if (!investigation) throw new TomokError("Investigation not found.", 404);
    return { investigation };
  } catch (error) { return safeStorageError(error); }
}
