import { createHash } from "node:crypto";
import { z } from "zod";
import { evidenceForModel } from "./evidence";
import type { ActivityRecord, EvidenceRecord, Quantity, SnapshotRecord } from "./import-types";
import type { InvestigationFinding } from "./investigation";
import type { MemorySummary } from "./memory-service";
import type { CaseReplay, ReplayExhibit, ReplayProgress, ReplayReassessment } from "./replay-types";

export const REPLAY_VERSION = "south-portal-replay-v1";
export const INITIAL_CUTOFF = "2026-07-14";
export const LATER_CUTOFF = "2026-07-16";
export const REPLAY_AVAILABILITY_NOTE = "Controlled reporting-date replay using real source extracts. Dated observations are revealed in stages; the undated field plan and one P6 snapshot are assumed context in both stages. This does not reconstruct what was historically available or known. Current reviewed notes are applied by validity and source scope, not backdated to the reporting date.";

const key = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 16);
const quantitySchema = z.object({ completed: z.number().int().nonnegative(), total: z.number().int().positive() }).refine(q => q.completed <= q.total);
const reportSchema = z.object({ jetGrouted: quantitySchema, predrilled: quantitySchema, lines: z.object({ M: z.object({ jetGrouted: quantitySchema }), L: z.object({ jetGrouted: quantitySchema }) }) });
const amount = (q: Quantity) => `${q.completed}/${q.total}`;

export function replayProgress(evidence: EvidenceRecord[]): ReplayProgress[] {
  return evidence.filter(row => row.kind === "field-observation" && row.facts.published === true && row.observedDate)
    .map(row => {
      const facts = reportSchema.parse(row.facts);
      return { observedDate: row.observedDate!, evidenceId: row._id, jetGrouted: facts.jetGrouted, predrilled: facts.predrilled, lineM: facts.lines.M.jetGrouted, lineL: facts.lines.L.jetGrouted };
    }).sort((a, b) => a.observedDate.localeCompare(b.observedDate));
}

/** Explicit projections are the boundary: raw cells/whole worksheets never reach replay clients. */
export function replayExhibits(id: string, evidence: EvidenceRecord[], activity: ActivityRecord, snapshot: SnapshotRecord): ReplayExhibit[] {
  const href = (exhibitId: string) => `/replays/${id}#exhibit-${exhibitId}`;
  const project = snapshot.projects.find(row => row.id === activity.p6ProjectId);
  const exhibits: ReplayExhibit[] = [{
    id: "schedule", sourceId: activity.sourceId, evidenceIds: [], kind: "schedule", observedDate: null,
    label: `P6 ${activity.code} · source line ${activity.sourceLine}`,
    text: `${activity.name}. Snapshot data date ${project?.dataDate || "not recorded"}; export ${snapshot.exportDate || "not recorded"}. Approval unconfirmed. These are imported snapshot results, not a recalculation at the replay cutoff.`,
    cells: [
      ["task_code", activity.code], ["target_start_date", activity.dates.target_start_date], ["target_end_date", activity.dates.target_end_date],
      ["total_float_hr_cnt", activity.floatHours === null ? "Not recorded" : String(activity.floatHours)], ["driving_path_flag", activity.longestPath ? "Y" : "N"],
    ].map(([address, display]) => ({ address, display: display || "Not recorded", formula: null })), href: href("schedule"),
  }];
  for (const row of evidence) {
    const rowNumber = /([1-9]\d*)$/.exec(row.locator.cell)?.[1];
    if (!rowNumber) throw new Error("Replay evidence has no supported source locator.");
    const columns = row.kind === "field-plan" ? ["E", "K", "L", ...(row.facts.actualFinishIsForecast === true ? ["O"] : [])]
      : row.kind === "mapping" ? ["E"]
      : row.facts.published === true ? ["B", "C", "AD"] : ["E", "F"];
    const cells = columns.flatMap(column => {
      const address = `${column}${rowNumber}`, cell = row.rawCells[address];
      return cell ? [{ address, display: cell.display, formula: row.kind === "field-plan" && column === "O" ? cell.formula : null }] : [];
    });
    const exhibitId = key(row._id);
    exhibits.push({ id: exhibitId, sourceId: row.sourceId, evidenceIds: [row._id],
      kind: row.kind, observedDate: row.observedDate,
      label: `${row.locator.sheet} · ${row.kind === "field-plan" ? `row ${rowNumber}, selected planning cells` : row.locator.cell}`,
      text: evidenceForModel(row).text,
      cells, href: href(exhibitId),
    });
  }
  return exhibits;
}

export function replayCitations(findings: InvestigationFinding[], exhibits: ReplayExhibit[]) {
  return findings.map(finding => ({ ...finding, citations: finding.citations.map(citation => {
    const url = new URL(citation.href, "https://tomok.invalid");
    const sourceId = url.searchParams.get("file"), cell = url.searchParams.get("cell");
    const exhibit = exhibits.find(item => item.sourceId === sourceId && (cell ? item.cells.some(c => c.address === cell) : item.kind === "schedule"));
    if (!exhibit) throw new Error("A replay citation is outside the frozen exhibits.");
    return { label: citation.label, href: exhibit.href };
  }) }));
}

export function replayMemory(notes: MemorySummary[], exhibits: ReplayExhibit[], id: string): MemorySummary[] {
  return notes.filter(note => note.citations.length > 0 && note.citations.every(citation => exhibits.some(exhibit => exhibit.evidenceIds.includes(citation.evidenceId))))
    .map(note => ({ ...note, href: `/replays/${id}#memory-${note.id}`, citations: note.citations.map(citation => ({
      ...citation, href: exhibits.find(exhibit => exhibit.evidenceIds.includes(citation.evidenceId))!.href,
    })) }));
}

export function reassessReplay(previous: CaseReplay, progress: ReplayProgress[], exhibits: ReplayExhibit[], evidence: EvidenceRecord[], memories: MemorySummary[]): ReplayReassessment {
  const before = previous.replay.progress.at(-1), after = progress.at(-1);
  if (!before || !after || after.observedDate <= before.observedDate) throw new Error("Reassessment requires a later daily observation.");
  const citation = (evidenceId: string) => {
    const exhibit = exhibits.find(item => item.evidenceIds.includes(evidenceId));
    if (!exhibit) throw new Error("Reassessment evidence is outside the frozen exhibits.");
    return { label: exhibit.label, href: exhibit.href };
  };
  const reportCitations = [citation(before.evidenceId), citation(after.evidenceId)];
  const sameBasis = (["jetGrouted", "predrilled", "lineM", "lineL"] as const).every(k => before[k].total === after[k].total);
  const findings: InvestigationFinding[] = [{
    id: "replay-production-change", kind: "documented",
    text: sameBasis
      ? `Between the ${before.observedDate} and ${after.observedDate} reports, jet-grouted columns changed from ${amount(before.jetGrouted)} to ${amount(after.jetGrouted)}; predrilled columns from ${amount(before.predrilled)} to ${amount(after.predrilled)}. Line M changed from ${amount(before.lineM)} to ${amount(after.lineM)}; Line L from ${amount(before.lineL)} to ${amount(after.lineL)}. These are cumulative reported counts, not a production-rate or completion forecast.`
      : "The later report changes the quantity denominators. Confirm the counting basis before comparing production.",
    citations: reportCitations,
  }];
  const affected = new Map<string, InvestigationFinding>();
  for (const line of ["M", "L"] as const) {
    const plan = evidence.find(row => row.kind === "field-plan" && row.facts.line === line);
    if (!plan) continue;
    const date = z.iso.date().safeParse(line === "M" ? plan.facts.currentFinish : plan.facts.currentStart);
    if (!date.success || date.data <= previous.cutoff || date.data > after.observedDate) continue;
    const onDate = progress.find(row => row.observedDate === date.data);
    const q = onDate?.[line === "M" ? "lineM" : "lineL"];
    if (!q || (line === "M" ? q.completed >= q.total : q.completed !== 0)) continue;
    const finding: InvestigationFinding = {
      id: `replay-line-${line.toLowerCase()}-review`, kind: "inferred",
      text: line === "M"
        ? `Line M's undated field-plan finish is ${date.data}. The report dated ${date.data} records ${amount(q)} grouted columns; the ${after.observedDate} report records ${amount(after.lineM)}. If the mapping, plan applicability, and report cutoffs are confirmed, revisit an assumption that all grouting was reported complete by the planned finish. A full count does not establish testing or acceptance completion.`
        : `Line L's undated field-plan start is ${date.data}. That day's report still records ${amount(q)} grouted columns. Confirm what work the planned start represents before relying on an assumption that grouting production would already be reported. Zero reported grouted columns does not establish a missed activity start.`,
      citations: [citation(plan._id), citation(onDate.evidenceId), citation(after.evidenceId)].filter((c, i, list) => list.findIndex(x => x.href === c.href) === i),
    };
    findings.push(finding); affected.set(plan._id, finding);
  }
  findings.push({ id: "replay-impact-gap", kind: "unresolved", text: "The new observations change the production comparison and the conditional review questions. They do not establish a delay cause, an accepted target milestone, or a recalculated project finish. The original investigation and reviewed memory revisions remain preserved.", citations: reportCitations });
  return { previousId: previous.id, previousCutoff: previous.cutoff, findings,
    memoryChecks: memories.map(memory => {
      const matches = memory.citations.flatMap(c => affected.has(c.evidenceId) ? [affected.get(c.evidenceId)!] : []);
      return { memoryId: memory.id, revision: memory.revision,
        disposition: memory.kind === "mapping" ? "mapping-retained" : matches.length ? "review-suggested" : "no-specific-conflict",
        reason: memory.kind === "mapping"
          ? "The later production counts do not contradict this field-to-schedule mapping. Its reviewed revision remains unchanged."
          : matches.length
            ? "This interpretation cites a planning row with a new conditional review question. Check whether its statement depends on that assumption; the citation overlap alone does not prove a contradiction. No memory status was changed."
            : "No specific conflict was established by these bounded production and planning-date checks. This is not validation of every claim in the note.",
        citations: memory.kind === "interpretation" ? matches.flatMap(f => f.citations).filter((c, i, list) => list.findIndex(x => x.href === c.href) === i) : [],
      };
    }),
  };
}
