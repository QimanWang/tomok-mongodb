import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requirePrincipal, type ProjectPrincipal } from "../auth";
import { projectDb } from "../db";
import { TomokError, safeStorageError } from "../errors";
import { PROJECT_ID, requireRelease } from "../repository";
import { createSourceManifest, readUnit, validateProposedFacts } from "./source-units";
import { applyProcessingPolicy, evaluateProcessingPolicy, proposedPolicySchema } from "./policies";
import { auditFactProvenance } from "./validation";
import { bindings, committedOutputs, ensureMissionCollections, isTerminal, missionDetail, missionHash, missionSummary, missions, outputs, requireMission, updateMission } from "./repository";
import { claimMissionJobSchema, commitMissionJobSchema, completeMissionSchema, missionActionSchema, readMissionUnitSchema, startMissionSchema,
  type MissionDispatchDescriptor, type MissionDocument, type MissionOutput, type MissionSession } from "./types";

const MARKER = "tomokMissionId";
export const JOB_LEASE_MS = 180_000;
const now = () => new Date().toISOString();
const schemaInput = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new TomokError(`Invalid mission input: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`, 422);
  return parsed.data;
};
const defaultPolicy = () => ({ id: "workbook-context-v1", version: 1, label: "Complete bounded source context", rowWindow: 1,
  headerRows: 2, omitEmptyCells: false, inspectFormulas: true as const, createdAt: now() });
function storedPrincipal(principal: NonNullable<ProjectPrincipal>) {
  return { principalId: principal.principalId, principalType: principal.principalType,
    authenticator: principal.authenticator, ...(principal.issuer ? { issuer: principal.issuer } : {}) };
}

export async function createMission(input: unknown, principal: ProjectPrincipal) {
  const owner = requirePrincipal(principal), parsed = schemaInput(startMissionSchema, input);
  try {
    const db = await projectDb(), id = missionHash([PROJECT_ID, owner, parsed.requestId]);
    const requestHash = missionHash([parsed.goal, parsed.cutoff, parsed.preset]);
    const existing = await missions(db).findOne({ _id: id, owner, projectId: PROJECT_ID });
    if (existing) {
      if (existing.requestHash !== requestHash) throw new TomokError("That start request already belongs to a different mission. Start a new request.", 409);
      return { mission: await missionDetail(db, existing), href: `/missions/${id}` };
    }
    const release = await requireRelease(db), manifest = createSourceManifest({ releaseId: release.releaseId, cutoff: parsed.cutoff });
    const registered = await db.collection("project_sources").find({ projectId: PROJECT_ID, releaseId: release.releaseId }, { projection: { sourceId: 1, sha256: 1 } }).toArray();
    if (manifest.sources.some((source) => !registered.some((row) => row.sourceId === source.id && row.sha256 === source.sha256))) {
      throw new TomokError("The registered source versions differ from the active import. Reimport before starting a mission.", 409);
    }
    const policy = defaultPolicy(), createdAt = now();
    const mission: MissionDocument = { _id: id, id, projectId: PROJECT_ID, owner, principal: storedPrincipal(principal!),
      releaseId: release.releaseId, importVersion: release.importVersion, goal: parsed.goal, cutoff: parsed.cutoff, requestHash,
      createdAt, updatedAt: createdAt, status: "queued", generation: 1, revision: 1, manifest,
      jobs: manifest.units.map((unit) => ({ id: missionHash([id, unit.id, policy.id]), unitId: unit.id, policyVersion: policy.id, status: "pending", attempt: 0 })),
      activeLease: null, currentSessionId: null, dispatch: { id: randomUUID(), status: "pending", attempts: 0 },
      budget: { maxJobs: 64, maxAttempts: 48, maxToolCalls: 120, toolCalls: 0, attempts: 0 },
      pauseReason: null, lastCheckpoint: null, report: null, policies: [policy], activePolicyId: policy.id, policyEvaluations: [], actionIds: [],
    };
    await ensureMissionCollections(db);
    try { await missions(db).updateOne({ _id: id }, { $setOnInsert: mission }, { upsert: true }); }
    catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
    const saved = await requireMission(db, id, owner);
    if (saved.requestHash !== requestHash) throw new TomokError("This request belongs to a different mission.", 409);
    return { mission: await missionDetail(db, saved), href: `/missions/${id}` };
  } catch (error) { return safeStorageError(error); }
}

export async function listMissions(principal: ProjectPrincipal) {
  const owner = requirePrincipal(principal);
  try {
    const rows = await missions(await projectDb()).find({ owner, projectId: PROJECT_ID }).sort({ createdAt: -1, _id: -1 }).limit(21).toArray();
    return { missions: rows.slice(0, 20).map(missionSummary), hasMore: rows.length > 20 };
  } catch (error) { return safeStorageError(error); }
}
export async function getMission(id: string, principal: ProjectPrincipal) {
  const owner = requirePrincipal(principal);
  try { const db = await projectDb(); return { mission: await missionDetail(db, await requireMission(db, id, owner)) }; }
  catch (error) { return safeStorageError(error); }
}

/** Recheck published facts against pinned source records without changing immutable outputs. */
export async function reconcileMissionReportProvenance(id: string, principal: ProjectPrincipal) {
  const owner = requirePrincipal(principal);
  try {
    const db = await projectDb(), mission = await requireMission(db, id, owner);
    if (!isTerminal(mission) || !mission.report || mission.activeLease
      || mission.jobs.some((job) => job.status === "pending" || job.status === "running")) {
      throw new TomokError("Only a completed report with no active source work can be reconciled.", 409);
    }
    const facts = (await committedOutputs(db, mission)).flatMap((output) => output.facts);
    const questions = new Set(mission.report.questions);
    const addedQuestions: string[] = [];
    for (const unit of mission.manifest.units) {
      const unitFacts = facts.filter((fact) => fact.unitId === unit.id);
      if (!unitFacts.length) continue;
      for (const question of auditFactProvenance(await readUnit(unit), unitFacts)) {
        if (questions.has(question)) continue;
        questions.add(question);
        addedQuestions.push(question);
      }
    }
    if (!addedQuestions.length) return { changed: false, addedQuestions, reportRevisionId: null,
      mission: missionSummary(mission), report: mission.report };
    const revision = { id: missionHash([mission.id, mission.revision, "report-provenance-reconciliation", addedQuestions]),
      recordedAt: now(), reason: "Reconciled committed date labels against pinned source formula provenance; appended unsupported-provenance questions. Source facts and report review status are unchanged.",
      report: mission.report };
    const saved = await updateMission(db, mission, { status: "completed_with_gaps",
      report: { ...mission.report, questions: [...mission.report.questions, ...addedQuestions] }, reportRevisions: [...(mission.reportRevisions ?? []), revision] });
    return { changed: true, addedQuestions, reportRevisionId: revision.id, mission: missionSummary(saved), report: saved.report };
  } catch (error) { return safeStorageError(error); }
}

export async function missionAction(id: string, input: unknown, principal: ProjectPrincipal) {
  const owner = requirePrincipal(principal), action = schemaInput(missionActionSchema, input);
  try {
    const db = await projectDb(), current = await requireMission(db, id, owner);
    const actionId = missionHash([action.action, action.requestId]);
    if (current.actionIds.includes(actionId)) return { mission: await missionDetail(db, current) };
    if (action.action === "pause" && !["queued", "running"].includes(current.status)) return { mission: await missionDetail(db, current) };
    if (action.action === "resume" && current.status !== "paused") throw new TomokError("Only a paused mission can be resumed.", 409);
    if (action.action === "retry" && current.status !== "failed" && !current.jobs.some((job) => job.status === "failed")) throw new TomokError("This mission has no failed work to retry.", 409);
    const jobs = current.jobs.map((job) => job.status === "running" || (action.action === "retry" && job.status === "failed")
      ? { ...job, status: "pending" as const, ...(action.action === "retry" ? { attempt: 0 } : {}) } : job);
    const paused = action.action === "pause";
    const updated = await updateMission(db, current, { jobs, status: paused ? "paused" : "queued", generation: current.generation + 1,
      currentSessionId: null, activeLease: null, pauseReason: paused ? "Paused by the project operator." : null,
      dispatch: { id: randomUUID(), status: "pending", attempts: 0 }, report: action.action === "retry" ? null : current.report,
      budget: paused ? current.budget : { ...current.budget, maxToolCalls: current.budget.toolCalls + 120, maxAttempts: current.budget.attempts + 48,
        maxModelSteps: (current.budget.modelSteps ?? 0) + 60, maxInputTokens: (current.budget.inputTokens ?? 0) + 500_000, maxOutputTokens: (current.budget.outputTokens ?? 0) + 30_000 },
      actionIds: [...current.actionIds.slice(-19), actionId], lastCheckpoint: paused ? "Paused. Committed outputs are preserved; unfinished work is fenced." : "Resuming from committed outputs.",
    });
    return { mission: await missionDetail(db, updated) };
  } catch (error) { return safeStorageError(error); }
}

export async function findMissionSession(sessionId: string) {
  if (!/^[A-Za-z0-9_-]{1,180}$/.test(sessionId)) throw new TomokError("Mission session not found.", 404);
  try {
    const db = await projectDb(), binding = await bindings(db).findOne({ sessionId });
    if (!binding) return null;
    const mission = await requireMission(db, binding.missionId, binding.owner);
    return { ...binding, principal: mission.principal, status: mission.status, currentGeneration: mission.generation };
  } catch (error) { return safeStorageError(error); }
}
export async function authorizeMissionSession<T extends NonNullable<ProjectPrincipal>>(sessionId: string, principal: T): Promise<T> {
  const binding = await findMissionSession(sessionId);
  if (!binding) {
    if (principal.attributes?.[MARKER]) throw new TomokError("The mission session scope is unavailable.", 403);
    return principal;
  }
  if (binding.owner !== requirePrincipal(principal)) throw new TomokError("Mission session not found.", 403);
  return { ...principal, attributes: { ...principal.attributes, [MARKER]: binding.missionId } };
}
export async function getSessionMission(session: MissionSession) {
  const binding = await findMissionSession(session.id);
  const markers = [session.auth.current?.attributes?.[MARKER], session.auth.initiator?.attributes?.[MARKER]].filter(Boolean);
  if (!binding) {
    if (markers.length) throw new TomokError("The mission session scope is unavailable.", 403);
    return null;
  }
  if (binding.owner !== requirePrincipal(session.auth.current) || markers.some((marker) => marker !== binding.missionId)
    || (session.auth.initiator && binding.owner !== requirePrincipal(session.auth.initiator))) throw new TomokError("The mission session owner or scope does not match.", 403);
  return requireMission(await projectDb(), binding.missionId, binding.owner);
}

/** Signature verification happens in the channel; DB state is the authority for its scope. */
export async function authorizeMissionDispatch(claims: Omit<MissionDispatchDescriptor, "sessionId"> & { operation: "create" | "send" | "inspect" | "cancel"; sessionId?: string | null }) {
  const db = await projectDb(), mission = await requireMission(db, claims.missionId, claims.owner);
  if (mission.releaseId !== claims.releaseId || requirePrincipal(mission.principal) !== claims.owner) throw new TomokError("Mission dispatch scope is unavailable.", 403);
  if (claims.operation === "inspect" || claims.operation === "cancel") {
    const binding = claims.sessionId ? await bindings(db).findOne({ sessionId: claims.sessionId, missionId: mission.id, owner: mission.owner, generation: claims.generation }) : null;
    if (!binding) throw new TomokError("The mission session is not bound.", 403);
  } else {
    if (!["queued", "running"].includes(mission.status) || mission.generation !== claims.generation || mission.dispatch.id !== claims.dispatchId) throw new TomokError("This dispatch was superseded or paused.", 403);
    if (claims.operation === "create" && (claims.sessionId || mission.currentSessionId)) throw new TomokError("Mission session creation is unavailable.", 403);
    if (claims.operation === "send" && (!claims.sessionId || claims.sessionId !== mission.currentSessionId)) throw new TomokError("The dispatch session does not match the current mission.", 403);
  }
  return { ...mission.principal, attributes: { ...mission.principal.attributes, [MARKER]: mission.id } };
}

async function activeMission(session: MissionSession, countCall = true) {
  const mission = await getSessionMission(session);
  if (!mission) throw new TomokError("Start a bound archive mission before using this tool.", 403);
  const binding = await findMissionSession(session.id);
  if (binding?.generation !== mission.generation || mission.currentSessionId !== session.id) throw new TomokError("This worker was replaced. Its previous results remain saved.", 409);
  if (!["queued", "running"].includes(mission.status)) throw new TomokError(`This mission is ${mission.status}. Stop processing and retain its checkpoint.`, 409);
  const db = await projectDb();
  if (countCall && mission.budget.toolCalls >= mission.budget.maxToolCalls) {
    await updateMission(db, mission, { status: "paused", pauseReason: "The mission reached its tool budget. Resume explicitly to grant another bounded work period.", activeLease: null });
    throw new TomokError("Mission budget reached; work is paused, not complete.", 409);
  }
  return countCall ? updateMission(db, mission, { status: "running", budget: { ...mission.budget, toolCalls: mission.budget.toolCalls + 1 } }) : mission;
}

export async function getMissionContext(input: unknown, session: MissionSession) {
  schemaInput(z.strictObject({}), input);
  const mission = await activeMission(session), db = await projectDb();
  const committed = await committedOutputs(db, mission);
  const current = [...new Map(committed.map((output) => [output.unitId, output])).values()];
  return { id: mission.id, goal: mission.goal, cutoff: mission.cutoff, status: mission.status, releaseId: mission.releaseId,
    href: `/missions/${mission.id}`, generation: mission.generation, budget: mission.budget, lastCheckpoint: mission.lastCheckpoint,
    sources: mission.manifest.sources, units: mission.manifest.units,
    jobs: mission.jobs, activeLease: mission.activeLease, policies: mission.policies, activePolicyId: mission.activePolicyId,
    committedFacts: current.flatMap((output) => output.facts), warnings: [...new Set(current.flatMap((output) => output.warnings))],
    rules: "Read actual source units. Preserve raw dates and forecast markers. Extracted statements and links are not human-reviewed knowledge. Choose one pending job at a time, explain why it matters, then claim/read/commit. Do not repeat completed jobs. Report unresolved mappings and limits; never infer CPM delay or productivity from column counts.",
  };
}

export async function claimMissionJob(input: unknown, session: MissionSession) {
  const { jobId, reason } = schemaInput(claimMissionJobSchema, input);
  let mission = await activeMission(session);
  const db = await projectDb();
  if (mission.activeLease && mission.activeLease.expiresAt > now()) {
    if (mission.activeLease.jobId === jobId) return { jobId, leaseToken: mission.activeLease.token, expiresAt: mission.activeLease.expiresAt,
      policyVersion: mission.jobs.find((job) => job.id === jobId)?.policyVersion,
      unit: mission.manifest.units.find((unit) => unit.id === mission.jobs.find((job) => job.id === jobId)?.unitId) };
    throw new TomokError("Finish the claimed job before choosing another source unit.", 409);
  }
  if (mission.activeLease || mission.jobs.some((job) => job.status === "running")) {
    const expiredJobs = mission.jobs.map((job) => job.status === "running" ? { ...job, status: job.attempt >= 3 ? "failed" as const : "pending" as const, lastError: "An interrupted worker's lease expired." } : job);
    // Publish expiry before any early return/error. The revision check fences a concurrent pause or replacement.
    mission = await updateMission(db, mission, { jobs: expiredJobs, activeLease: null, lastCheckpoint: "Expired work was settled; exhausted ranges remain visible as failures." });
  }
  const jobs = mission.jobs.map((job) => ({ ...job }));
  const job = jobs.find((row) => row.id === jobId);
  if (!job) throw new TomokError("This job is outside the mission manifest.", 404);
  if (job.status === "completed") return { alreadyCompleted: true, outputId: job.outputId };
  if (job.status !== "pending" || job.attempt >= 3) throw new TomokError("This source unit exhausted its retries; disclose the gap or retry it from the workspace.", 409);
  if (mission.budget.attempts >= mission.budget.maxAttempts) {
    await updateMission(db, mission, { status: "paused", activeLease: null, pauseReason: "The mission attempt budget was reached. Resume explicitly to continue." });
    throw new TomokError("Mission attempt budget reached.", 409);
  }
  job.status = "running"; job.attempt++; job.startedAt = now(); job.reason = reason;
  const lease = { jobId, token: randomUUID(), generation: mission.generation, expiresAt: new Date(Date.now() + JOB_LEASE_MS).toISOString() };
  await updateMission(db, mission, { jobs, activeLease: lease, budget: { ...mission.budget, attempts: mission.budget.attempts + 1 }, lastCheckpoint: `Reading ${mission.manifest.units.find((unit) => unit.id === job.unitId)!.label}` });
  return { jobId, leaseToken: lease.token, expiresAt: lease.expiresAt, policyVersion: job.policyVersion, unit: mission.manifest.units.find((unit) => unit.id === job.unitId)! };
}

function requireLease(mission: MissionDocument, jobId: string, leaseToken: string) {
  const lease = mission.activeLease, job = mission.jobs.find((item) => item.id === jobId);
  if (!job || job.status !== "running" || !lease || lease.jobId !== jobId || lease.token !== leaseToken || lease.generation !== mission.generation || lease.expiresAt <= now()) throw new TomokError("This job lease expired or was replaced. Load the checkpoint before retrying.", 409);
  return job;
}

export async function readMissionUnit(input: unknown, session: MissionSession) {
  const { jobId, leaseToken } = schemaInput(readMissionUnitSchema, input), mission = await activeMission(session);
  const job = requireLease(mission, jobId, leaseToken), unit = mission.manifest.units.find((item) => item.id === job.unitId)!;
  try {
    const result = applyProcessingPolicy(await readUnit(unit), mission.policies.find((policy) => policy.id === job.policyVersion)!);
    // Keep the model's extraction interval bounded but long enough for this source unit.
    await updateMission(await projectDb(), mission, { activeLease: { ...mission.activeLease!, expiresAt: new Date(Date.now() + JOB_LEASE_MS).toISOString() } });
    return result;
  } catch (error) {
    if (error instanceof TomokError) throw error;
    const jobs = mission.jobs.map((item) => item.id === jobId ? { ...item, status: "failed" as const, lastError: "The pinned source could not be read or exceeded its supported bounds." } : item);
    await updateMission(await projectDb(), mission, { jobs, activeLease: null });
    throw new TomokError("The pinned source could not be read. Its failed range remains in coverage; continue other eligible jobs.", 422);
  }
}

export async function commitMissionJob(input: unknown, session: MissionSession) {
  const parsed = schemaInput(commitMissionJobSchema, input), mission = await activeMission(session), db = await projectDb();
  const existingJob = mission.jobs.find((item) => item.id === parsed.jobId);
  if (existingJob?.status === "completed") return { alreadyCompleted: true, outputId: existingJob.outputId };
  const job = requireLease(mission, parsed.jobId, parsed.leaseToken);
  const unit = mission.manifest.units.find((item) => item.id === job.unitId)!;
  const source = await readUnit(unit);
  let facts;
  try { facts = validateProposedFacts(source, parsed.facts); }
  catch (error) { throw new TomokError(error instanceof Error ? error.message.slice(0, 1_000) : "Source fact validation failed.", 422); }
  if (source.status === "read" && source.records.some((record) => record.role === "data" && record.display.trim()) && facts.length === 0) throw new TomokError("A non-empty source unit needs at least one verified extracted fact; otherwise retain an explicit failed range.", 422);
  const outputId = missionHash([mission.id, job.id, parsed.leaseToken]);
  const output: MissionOutput = { _id: outputId, missionId: mission.id, jobId: job.id, unitId: unit.id, releaseId: mission.releaseId,
    policyVersion: job.policyVersion, generation: mission.generation, attempt: job.attempt, createdAt: now(),
    status: source.status === "outside-cutoff" ? "outside-cutoff" : "processed", facts,
    metrics: { inputBytes: Buffer.byteLength(JSON.stringify(applyProcessingPolicy(source, mission.policies.find((policy) => policy.id === job.policyVersion)!))), records: source.records.length, facts: facts.length }, warnings: source.warnings };
  await outputs(db).updateOne({ _id: outputId }, { $setOnInsert: output }, { upsert: true });
  const persisted = await outputs(db).findOne({ _id: outputId });
  if (!persisted || JSON.stringify(persisted.facts) !== JSON.stringify(facts)) {
    throw new TomokError("This attempt already saved different facts. Retry its original facts or let the lease expire before starting a new attempt.", 409);
  }
  // Re-read after source validation/output write. Pause, lease expiry and a successor worker all win over this attempt.
  const latest = await requireMission(db, mission.id, mission.owner);
  requireLease(latest, job.id, parsed.leaseToken);
  if (latest.generation !== mission.generation || latest.currentSessionId !== session.id || latest.status !== "running") throw new TomokError("This worker no longer owns the mission.", 409);
  const jobs = latest.jobs.map((item) => item.id === job.id ? { ...item, status: "completed" as const, outputId, completedAt: now() } : item);
  await updateMission(db, latest, { jobs, activeLease: null, lastCheckpoint: `Saved ${facts.length} verified source facts from ${unit.label}` });
  return { outputId, jobId: job.id, facts, status: output.status, committed: true };
}

export async function completeMission(input: unknown, session: MissionSession) {
  const report = schemaInput(completeMissionSchema, input), mission = await activeMission(session), db = await projectDb();
  if (mission.activeLease || mission.jobs.some((job) => job.status === "pending" || job.status === "running")) throw new TomokError("Finish every in-scope source unit or retain a failed outcome before completing this mission.", 409);
  const committed = await committedOutputs(db, mission);
  const facts = committed.flatMap((output) => output.facts), byId = new Map(facts.map((fact) => [fact.id, fact]));
  const connections = report.connections.map((connection) => {
    const left = byId.get(connection.leftFactId), right = byId.get(connection.rightFactId);
    if (!left || !right || left.id === right.id) throw new TomokError("A connection must cite two different committed source facts.", 422);
    if (connection.relation === "same-identifier" && (left.kind !== "identifier" || right.kind !== "identifier" || left.value !== right.value)) throw new TomokError("A documented identifier connection requires the exact same source identifier on both sides.", 422);
    if (connection.relation === "same-identifier" && left.sourceId === right.sourceId) throw new TomokError("A documented cross-source identifier connection requires two different source files.", 422);
    return { ...connection, status: connection.relation === "same-identifier" ? "documented-identifier" as const : "proposed" as const };
  });
  for (const lesson of report.lessons) if (lesson.factIds.some((id) => !byId.has(id))) throw new TomokError("A draft lesson cites a fact outside this mission's committed evidence.", 422);
  const failures = mission.jobs.filter((job) => job.status === "failed");
  const provenanceQuestions: string[] = [];
  for (const unit of mission.manifest.units) {
    const unitFacts = facts.filter((fact) => fact.unitId === unit.id);
    if (unitFacts.length) provenanceQuestions.push(...auditFactProvenance(await readUnit(unit), unitFacts));
  }
  const questions = [...new Set([...report.questions, ...provenanceQuestions,
    ...failures.map((job) => `Unprocessed range: ${mission.manifest.units.find((unit) => unit.id === job.unitId)!.label}. ${job.lastError ?? "Processing failed."}`)])];
  const processedSources = new Set(mission.manifest.units.map((unit) => unit.sourceId));
  const scopeNotes = [...new Set([
    `This report covers ${mission.manifest.units.length} bounded source units in ${processedSources.size} files; ${mission.manifest.sources.length - processedSources.size} other registered files were inventoried only.`,
    "The account, proposed mappings and reusable lessons are unreviewed model interpretations. Exact value and citation validation does not establish causation, CPM delay or labor productivity.",
    "Zero completed counts do not establish that work has not started. First observed completion does not establish actual finish. Same-day predrilling does not establish an earlier start or a grouting start. The raw physical-complete field does not establish the controlling P6 completion basis.",
    ...committed.flatMap((output) => output.warnings),
  ])];
  const saved = await updateMission(db, mission, { status: questions.length ? "completed_with_gaps" : "completed",
    report: { ...report, connections, questions, scopeNotes, createdAt: now(), reviewStatus: "unreviewed" }, lastCheckpoint: "All scoped ranges have a recorded outcome. Report saved for human review." });
  return { href: `/missions/${mission.id}`, mission: missionSummary(saved), report: saved.report };
}

export async function proposeMissionPolicy(input: unknown, session: MissionSession) {
  const proposal = schemaInput(proposedPolicySchema.extend({ reason: z.string().trim().min(10).max(600) }), input);
  const mission = await activeMission(session), db = await projectDb();
  const existing = mission.policies.find((policy) => policy.omitEmptyCells === proposal.omitEmptyCells);
  if (existing) return { candidateId: existing.id, policy: existing, alreadyExists: true };
  if (mission.policies.length >= 4) throw new TomokError("This mission reached its policy-candidate budget. Retain the current policy and disclose remaining questions.", 409);
  const candidate = { ...defaultPolicy(), id: `workbook-context-${missionHash([mission.id, proposal.omitEmptyCells])}`,
    version: mission.policies.length + 1, label: proposal.omitEmptyCells ? "Sparse context; raw evidence retained" : "Complete bounded source context",
    omitEmptyCells: proposal.omitEmptyCells };
  await updateMission(db, mission, { policies: [...mission.policies, candidate], lastCheckpoint: `Processing policy proposed: ${proposal.reason}` });
  return { candidateId: candidate.id, policy: candidate, active: false,
    gate: "Requires unchanged source/cutoff/header/formula/citation records and at least 5% lower serialized context bytes across the pinned development/regression units. No model-accuracy improvement is assumed." };
}

export async function evaluateMissionPolicy(input: unknown, session: MissionSession) {
  const { candidateId } = schemaInput(z.strictObject({ candidateId: z.string().min(1).max(100) }), input);
  const mission = await activeMission(session), db = await projectDb();
  const previous = mission.policyEvaluations.find((item) => item.candidateId === candidateId);
  if (previous) return previous;
  if (mission.activeLease) throw new TomokError("Commit the active source unit before evaluating a policy. In-flight jobs keep their pinned policy.", 409);
  const candidate = mission.policies.find((item) => item.id === candidateId), baseline = mission.policies.find((item) => item.id === mission.activePolicyId)!;
  if (!candidate) throw new TomokError("Policy candidate is outside this mission.", 404);
  const evaluation = await evaluateProcessingPolicy(mission.manifest, baseline, candidate);
  const latest = await requireMission(db, mission.id, mission.owner);
  if (latest.generation !== mission.generation || latest.status !== "running" || latest.activeLease || latest.activePolicyId !== baseline.id) throw new TomokError("The mission changed during evaluation; reload its checkpoint before retrying.", 409);
  let jobs = latest.jobs;
  if (evaluation.decision === "promoted") {
    // Completed attempts remain immutable. Explicit new jobs reprocess those ranges;
    // pending ranges are pinned to the candidate only at their next job boundary.
    const completedUnits = [...new Set(jobs.filter((job) => job.status === "completed" && latest.manifest.units.find((unit) => unit.id === job.unitId)?.kind === "workbook-range").map((job) => job.unitId))];
    const added = completedUnits.map((unitId) => ({ id: missionHash([mission.id, unitId, candidate.id]), unitId, policyVersion: candidate.id, status: "pending" as const, attempt: 0 }));
    if (jobs.length + added.length > mission.budget.maxJobs) throw new TomokError("Policy reprocessing exceeds this mission's job budget.", 409);
    jobs = [...jobs.map((job) => job.status === "pending" ? { ...job, id: missionHash([mission.id, job.unitId, candidate.id]), policyVersion: candidate.id } : job), ...added.filter((job) => !jobs.some((existing) => existing.id === job.id))];
  }
  await updateMission(db, latest, { jobs, activePolicyId: evaluation.decision === "promoted" ? candidate.id : baseline.id,
    policyEvaluations: [...latest.policyEvaluations, evaluation], lastCheckpoint: `Processing policy ${evaluation.decision}; ${evaluation.reasons[0]}` });
  return evaluation;
}
