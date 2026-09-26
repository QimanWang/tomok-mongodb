import type { EvidenceRecord } from "./import-types";

// Raw source cells remain in storage/viewers. Undated plan rows may contain a separately
// dated quantity description, so do not leak that description around the report cutoff.
export function evidenceForModel(row: EvidenceRecord) {
  const { rawCells: _rawCells, ...record } = row;
  if (record.kind !== "field-plan") return record;
  const { description: _description, ...facts } = record.facts;
  return {
    ...record, facts,
    text: `Undated field-plan row for ${record.activityCode ?? facts.candidateActivityCode}${facts.line ? `, Line ${facts.line}` : ""}. Current planned dates: ${facts.currentStart ?? "not recorded"} to ${facts.currentFinish ?? "not recorded"}. Applicability at the reporting cutoff and mappings require review.`,
  };
}

