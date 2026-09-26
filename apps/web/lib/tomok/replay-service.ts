import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import { z } from "zod";
import { requirePrincipal, type ProjectPrincipal } from "./auth";
import { projectDb } from "./db";
import { TomokError, safeStorageError } from "./errors";
import { buildInvestigation } from "./investigation";
import { selectApplicableMemory } from "./memory-eligibility";
import { listMemory } from "./memory-repository";
import { memorySummary } from "./memory-service";
import { JET_GROUT_CODE, PROJECT_ID, readContext, readEvidence, readInvestigation, requireRelease, saveInvestigation, type Release } from "./repository";
import { INITIAL_CUTOFF, LATER_CUTOFF, REPLAY_AVAILABILITY_NOTE, REPLAY_VERSION, reassessReplay, replayCitations, replayExhibits, replayMemory, replayProgress } from "./replay";
import type { CaseReplay, ReplayHistory, ReplayStageSummary } from "./replay-types";
import type { Investigation } from "./service";

const emptyInput = z.strictObject({});
const startInput = z.strictObject({ requestId: z.uuid().optional() });
function parseInput(input: unknown) {
  if (!emptyInput.safeParse(input).success) throw new TomokError("Replay stages use a fixed project and evidence window. Do not supply a different cutoff or source set.", 400);
}
const replayId = (parts: string[]) => createHash("sha256").update(JSON.stringify([REPLAY_VERSION, PROJECT_ID, ...parts])).digest("hex").slice(0, 32);
const result = (investigation: CaseReplay) => ({ href: `/replays/${investigation.id}`, investigation });
const HISTORY_LIMIT = 20;

function stageSummary(replay: CaseReplay): ReplayStageSummary {
  return { id: replay.id, href: `/replays/${replay.id}`, cutoff: replay.cutoff,
    label: replay.replay.label, createdAt: replay.createdAt,
    reviewedMemoryCount: replay.reviewedMemory?.length ?? 0 };
}

/** Only owner-visible summaries are listed; frozen evidence stays on its authorized stage route. */
export async function listCaseReplays(principal: ProjectPrincipal): Promise<ReplayHistory> {
  const owner = requirePrincipal(principal);
  try {
    const collection = (await projectDb()).collection<{ _id: string; investigation: CaseReplay }>("investigations");
    const filter = { projectId: PROJECT_ID, owner, "investigation.replay.version": REPLAY_VERSION };
    const rows = await collection.find({ ...filter, "investigation.replay.stage": "initial" }, { projection: { investigation: 1 } })
      .sort({ "investigation.createdAt": -1, _id: -1 }).limit(HISTORY_LIMIT + 1).toArray();
    const initial = rows.slice(0, HISTORY_LIMIT).map(row => row.investigation);
    const later = initial.length ? await collection.find({ ...filter, "investigation.replay.stage": "later",
      "investigation.replay.reassessment.previousId": { $in: initial.map(replay => replay.id) },
    }, { projection: { investigation: 1 } }).limit(HISTORY_LIMIT).toArray() : [];
    const byPrevious = new Map(later.map(row => [row.investigation.replay.reassessment!.previousId, row.investigation]));
    return { cases: initial.map(replay => ({ initial: stageSummary(replay),
      later: byPrevious.has(replay.id) ? stageSummary(byPrevious.get(replay.id)!) : null })), hasMore: rows.length > HISTORY_LIMIT };
  } catch (error) { return safeStorageError(error); }
}

async function requireReplay(db: Db, id: string, owner: string) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new TomokError("Case replay not found.", 404);
  const replay = await readInvestigation<CaseReplay>(db, id, owner);
  if (!replay?.replay || replay.replay.version !== REPLAY_VERSION) throw new TomokError("Case replay not found.", 404);
  return replay;
}

async function buildReplay(db: Db, release: Release, owner: string, id: string, previous?: CaseReplay): Promise<CaseReplay> {
  const cutoff = previous ? LATER_CUTOFF : INITIAL_CUTOFF;
  const [{ activity, snapshot }, available, accessibleMemory] = await Promise.all([
    readContext(db, release, JET_GROUT_CODE), readEvidence(db, release, cutoff), listMemory(db, owner),
  ]);
  const evidence = available.filter(row =>
    (row.activityCode === JET_GROUT_CODE || row.facts.candidateActivityCode === JET_GROUT_CODE) &&
    (row.observedDate === null || row.observedDate <= cutoff),
  );
  const progress = replayProgress(evidence);
  if (progress.at(-1)?.observedDate !== cutoff) throw new TomokError("The required published daily report is missing from this project import.", 422);
  const selected = selectApplicableMemory(accessibleMemory, { releaseId: release.releaseId, activityCode: JET_GROUT_CODE, cutoff });
  // A note originating in a later investigation must not bring hindsight into the first stage,
  // even when it only cites an undated planning row and has a backdated validity range.
  const scoped = await Promise.all(selected.applicable.map(async memory => {
    const origin = await readInvestigation<Investigation>(db, memory.originInvestigationId, memory.createdBy.id);
    return origin && origin.releaseId === release.releaseId && origin.cutoff <= cutoff ? memorySummary(memory) : null;
  }));
  const exhibits = replayExhibits(id, evidence, activity, snapshot);
  const reviewedMemory = replayMemory(scoped.filter(note => note !== null).sort((a, b) => a.id.localeCompare(b.id)), exhibits, id);
  const investigation = buildInvestigation({ cutoff, question: previous
    ? "After revealing the next daily reports, what changed in South Portal jet grouting and which assumptions need review?"
    : "As of July 14, how is South Portal jet grouting progressing against the field plan and P6? What needs attention?",
  activity, snapshot, evidence });
  return { ...investigation, id, projectId: PROJECT_ID, releaseId: release.releaseId, createdAt: new Date().toISOString(),
    title: `Case replay · South Portal · ${cutoff}`,
    findings: replayCitations(investigation.findings, exhibits), reviewedMemory,
    scopeNote: REPLAY_AVAILABILITY_NOTE,
    replay: { version: REPLAY_VERSION, stage: previous ? "later" : "initial",
      label: previous ? "Later reports revealed · July 15–16" : "Initial evidence · through July 14",
      availabilityNote: REPLAY_AVAILABILITY_NOTE, exhibits, progress,
      reassessment: previous ? reassessReplay(previous, progress, exhibits, evidence, reviewedMemory) : null,
    },
  };
}

/** A new request ID starts a new case; retries preserve both saved stages despite later reviews. */
export async function startCaseReplay(input: unknown, principal: ProjectPrincipal) {
  const owner = requirePrincipal(principal);
  const parsed = startInput.safeParse(input);
  if (!parsed.success) throw new TomokError("Start a replay with a valid request ID and the fixed evidence window.", 400);
  try {
    const db = await projectDb(), release = await requireRelease(db);
    const id = replayId([release.releaseId, owner, "initial", parsed.data.requestId ?? "default"]);
    const existing = await readInvestigation<CaseReplay>(db, id, owner);
    if (existing) return result(existing);
    return result(await saveInvestigation(db, release, owner, await buildReplay(db, release, owner, id)));
  } catch (error) { return safeStorageError(error); }
}

export async function getCaseReplay(id: string, principal: ProjectPrincipal) {
  const owner = requirePrincipal(principal);
  try { return result(await requireReplay(await projectDb(), id, owner)); }
  catch (error) { return safeStorageError(error); }
}

export async function advanceCaseReplay(id: string, input: unknown, principal: ProjectPrincipal) {
  const owner = requirePrincipal(principal); parseInput(input);
  try {
    const db = await projectDb(), previous = await requireReplay(db, id, owner);
    if (previous.replay.stage !== "initial") throw new TomokError("This replay has already reached its final report window. Open the initial stage to revisit it.", 409);
    const nextId = replayId([previous.releaseId, owner, "later", previous.id]);
    const existing = await readInvestigation<CaseReplay>(db, nextId, owner);
    if (existing) return result(existing);
    const release = await requireRelease(db);
    if (release.releaseId !== previous.releaseId) throw new TomokError("The project import changed. Start a new case replay; the saved stages remain available.", 409);
    return result(await saveInvestigation(db, release, owner, await buildReplay(db, release, owner, nextId, previous)));
  } catch (error) { return safeStorageError(error); }
}
