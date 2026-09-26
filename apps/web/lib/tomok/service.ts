import { createHash } from "node:crypto";
import { z } from "zod";
import { requirePrincipal, type ProjectPrincipal } from "./auth";
import { projectDb, storageConfiguration } from "./db";
import { TomokError, safeStorageError } from "./errors";
import { buildInvestigation } from "./investigation";
import { evidenceForModel } from "./evidence";
import { evidenceSearchCandidates, rankSearchCandidates, searchIndexStatus } from "./semantic-search";
export { evidenceForModel } from "./evidence";
import { readApplicableMemory, type MemorySummary } from "./memory-service";
import { activeRelease, requireRelease, readContext, readEvidence, readInvestigation, saveInvestigation, PROJECT_ID, JET_GROUT_CODE } from "./repository";
import { milestoneCodes } from "./investigation-options";
import { readMilestoneContext, readSelectedSource } from "./investigation-context";
import { selectedSourceInput, type SelectedSource } from "./source-selection";
import type { SchedulePath } from "./schedule-path";

export const investigationInput = z.strictObject({ cutoff: z.iso.date(), question: z.string().trim().min(1).max(2_000),
  targetMilestoneCode: z.enum(milestoneCodes).optional(), selectedSource: selectedSourceInput.optional() });
const evidenceInput = z.strictObject({ cutoff: z.iso.date(), query: z.string().trim().max(200).optional() });
const scheduleInput = z.strictObject({ activityCode: z.string().trim().min(1).max(100), targetMilestoneCode: z.enum(milestoneCodes).optional() });
// Bump when the investigation's interpretation rules change; old saved findings stay immutable.
const INVESTIGATION_VERSION = "jet-grout-v3";
export type Investigation = ReturnType<typeof buildInvestigation> & { id: string; projectId: string; createdAt: string; releaseId: string; reviewedMemory?: MemorySummary[];
  selectedSource?: SelectedSource; milestoneContext?: SchedulePath };


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
    const db = await projectDb();
    const release = await activeRelease(db);
    const semanticSearch = await searchIndexStatus(db).catch(() => ({ status: "UNAVAILABLE", queryable: false }));
    return { ...config, imported: Boolean(release), counts: release?.counts, semanticSearch };
  } catch (error) { return safeStorageError(error); }
}

export async function getScheduleContext(input: z.infer<typeof scheduleInput>, principal: ProjectPrincipal) {
  requirePrincipal(principal);
  const { activityCode, targetMilestoneCode } = parse(scheduleInput, input);
  try {
    const db = await projectDb();
    const release = await requireRelease(db);
    const context = await readContext(db, release, activityCode);
    const { snapshot, activity, neighbors, relationships, calendar } = context;
    return {
      projectId: PROJECT_ID, releaseId: release.releaseId,
      basis: { snapshotId: snapshot.snapshotId, projects: snapshot.projects, exportDate: snapshot.exportDate, approvalStatus: snapshot.approvalStatus },
      activity, relationships, neighbors,
      ...(targetMilestoneCode ? { milestoneContext: await readMilestoneContext(db, release, activity, snapshot, targetMilestoneCode) } : {}),
      calendar: calendar ? { id: calendar.id, name: calendar.name, raw: calendar.raw, sourceLine: calendar.sourceLine } : null,
      limitations: ["Schedule status and float describe this exported snapshot; no CPM recalculation has been performed.", "Baseline approval and the applicability of this snapshot require project-team confirmation."],
    };
  } catch (error) { return safeStorageError(error); }
}

export async function getProjectEvidence(input: { query?: string; cutoff: string }, principal: ProjectPrincipal) {
  const owner = requirePrincipal(principal);
  const { query, cutoff } = parse(evidenceInput, input);
  try {
    const db = await projectDb();
    const release = await requireRelease(db);
    const ranked = await rankSearchCandidates(db, release, "evidence", cutoff, query,
      evidenceSearchCandidates(await readEvidence(db, release, cutoff)));
    // A factual evidence answer must not depend on the model remembering a second
    // tool call. Load current reviewed context after the remote ranking completes.
    const reviewed = await readApplicableMemory(db, release, owner, cutoff, JET_GROUT_CODE);
    return {
      projectId: PROJECT_ID, releaseId: release.releaseId, cutoff,
      evidence: ranked.values, retrieval: ranked.retrieval,
      reviewedMemory: reviewed.memories, excludedMemory: reviewed.excluded,
      memoryScopeNote: "Current reviewed South Portal jet-grout knowledge applicable to this date, not a reconstruction of what was known then. Latest 100 accessible notes considered; human interpretation remains separate from source observations.",
      scopeNote: "Curated South Portal jet-grout extracts only. The cutoff filters dated daily observations. The supplied field plan is undated and is not proof of what was known by that date. Candidate activity mappings are unreviewed. Retrieval similarity does not verify a claim or prove absence elsewhere in the project files.",
    };
  } catch (error) { return safeStorageError(error); }
}

export async function investigateJetGrouting(input: z.infer<typeof investigationInput>, principal: ProjectPrincipal) {
  const owner = requirePrincipal(principal);
  const { cutoff, question, targetMilestoneCode, selectedSource: sourceInput } = parse(investigationInput, input);
  try {
    const db = await projectDb();
    const release = await requireRelease(db);
    const [{ activity, snapshot }, evidence] = await Promise.all([readContext(db, release, JET_GROUT_CODE), readEvidence(db, release, cutoff)]);
    if (!evidence.some((row) => row.kind === "field-observation" && row.facts.published === true && row.observedDate && row.observedDate <= cutoff)) throw new TomokError("No imported daily observations are available on or before that reporting date.", 422);
    const result = buildInvestigation({ cutoff, question, activity, snapshot, evidence });
    const [{ memories: reviewedMemory }, selectedSource, milestoneContext] = await Promise.all([
      readApplicableMemory(db, release, owner, cutoff, JET_GROUT_CODE),
      sourceInput ? readSelectedSource(db, release, sourceInput, evidence, JET_GROUT_CODE) : undefined,
      targetMilestoneCode ? readMilestoneContext(db, release, activity, snapshot, targetMilestoneCode) : undefined,
    ]);
    if (milestoneContext) result.findings.push({
      id: "selected-milestone-context", kind: milestoneContext.status === "found" ? "documented" : "unresolved",
      text: milestoneContext.status === "found"
        ? `The selected target is ${milestoneContext.target.code} (${milestoneContext.target.name}). The inspected imported graph contains a ${milestoneContext.relationships.length}-relationship successor path from ${activity.code} to this target. This establishes an imported connection, not a governing path, accepted milestone, or current completion impact; no milestone dates have been recalculated.`
        : `The selected target is ${milestoneContext.target.code} (${milestoneContext.target.name}). No directed successor path was found ${milestoneContext.status === "truncated" ? "within the bounded or incomplete graph" : "in this imported graph"}. This does not establish independence in the current schedule; governing logic and completion impact remain unresolved.`,
      citations: [{ label: `P6 ${activity.code}`, href: activity.href }, { label: `P6 ${milestoneContext.target.code}`, href: milestoneContext.target.href }],
    });
    const id = createHash("sha256").update(JSON.stringify([INVESTIGATION_VERSION, PROJECT_ID, release.releaseId, owner, cutoff, question,
      targetMilestoneCode ?? null, selectedSource ?? null, reviewedMemory.map(({ id, revision }) => [id, revision])])).digest("hex").slice(0, 32);
    const investigation = await saveInvestigation(db, release, owner, { ...result, reviewedMemory,
      ...(selectedSource ? { selectedSource } : {}), ...(milestoneContext ? { milestoneContext } : {}),
      id, projectId: PROJECT_ID, releaseId: release.releaseId, createdAt: new Date().toISOString() });
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
