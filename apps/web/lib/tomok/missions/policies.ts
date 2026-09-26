import { createHash } from "node:crypto";
import { z } from "zod";
import { readUnit, type SourceManifest, type SourceUnitRead, type SourceValue } from "./source-units";
import type { MissionPolicy, PolicyEvaluation } from "./types";

/** Only representation of genuinely empty workbook cells is adaptive in this version. */
export const proposedPolicySchema = z.strictObject({ omitEmptyCells: z.boolean() });
export const POLICY_GATE = { minimumByteReduction: 0.05, rowWindow: 1, headerRows: 2 } as const;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
function validPolicy(policy: MissionPolicy) {
  return Boolean(policy && typeof policy.id === "string" && policy.id.length &&
    Number.isInteger(policy.version) && policy.version > 0 && typeof policy.omitEmptyCells === "boolean" &&
    policy.inspectFormulas === true && policy.rowWindow === POLICY_GATE.rowWindow && policy.headerRows === POLICY_GATE.headerRows);
}
function emptyCell(record: SourceValue) {
  return record.role === "data" && record.display === "" &&
    (record.raw === null || record.raw === "") && !record.formula &&
    (record.cachedValue === null || record.cachedValue === "") &&
    (!record.original || (!record.original.formula && (record.original.value === null || record.original.value === ""))) && !record.mergeMaster;
}
function projection(read: SourceUnitRead, records: SourceValue[], policyId: string): SourceUnitRead {
  const retained = new Set(records.map((record) => record.locator));
  return { ...read, records, processing: { policyId, rawRecordCount: read.records.length,
    omittedEmptyLocators: read.records.filter((record) => !retained.has(record.locator)).map((record) => record.locator) } };
}

/** The dense immutable read remains the evidence; this only projects the model's context. */
export function applyProcessingPolicy(read: SourceUnitRead, policy: MissionPolicy): SourceUnitRead {
  if (!validPolicy(policy)) throw new Error("The proposed policy changes a fixed source-range, header, or formula guard.");
  if (read.processing?.omittedEmptyLocators.length) throw new Error("Apply a policy to the immutable dense source read, not an earlier projection.");
  const records = policy.omitEmptyCells && read.unit.kind === "workbook-range" ? read.records.filter((record) => !emptyCell(record)) : read.records;
  return projection(read, records, policy.id);
}

/** Separate structural scorer: never accepts a score or expected facts supplied by the agent. */
export function checkPolicyProjection(raw: SourceUnitRead, candidate: SourceUnitRead): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (JSON.stringify(raw.unit) !== JSON.stringify(candidate.unit) || raw.contentHash !== candidate.contentHash || raw.status !== candidate.status ||
    JSON.stringify(raw.coverage) !== JSON.stringify(candidate.coverage) || JSON.stringify(raw.warnings) !== JSON.stringify(candidate.warnings)) reasons.push("Source identity, cutoff, coverage, or evidence hash changed.");
  const originals = new Map(raw.records.map((record) => [record.locator, record]));
  const present = new Map(candidate.records.map((record) => [record.locator, record]));
  if (present.size !== candidate.records.length) reasons.push("Duplicate context records.");
  for (const record of candidate.records) {
    if (JSON.stringify(originals.get(record.locator)) !== JSON.stringify(record)) reasons.push(`Context record was added or changed: ${record.locator}`);
  }
  for (const record of raw.records) {
    // Intentionally score against independent raw-field conditions, not the projection helper.
    const required = raw.unit.kind !== "workbook-range" || record.role !== "data" ||
      record.display !== "" || (record.raw !== null && record.raw !== "") ||
      (record.cachedValue !== null && record.cachedValue !== "") || Boolean(record.formula) ||
      Boolean(record.original?.formula) || Boolean(record.original?.value) || Boolean(record.mergeMaster);
    if (required && !present.has(record.locator)) reasons.push(`Required raw value, formula, or header was removed: ${record.locator}`);
  }
  const actualOmitted = raw.records.filter((record) => !present.has(record.locator)).map((record) => record.locator).sort();
  const declaredOmitted = [...candidate.processing?.omittedEmptyLocators ?? []].sort();
  if (JSON.stringify(actualOmitted) !== JSON.stringify(declaredOmitted) || candidate.processing?.rawRecordCount !== raw.records.length)
    reasons.push("Omitted empty locators or the raw record count are not declared exactly.");
  return { passed: !reasons.length, reasons };
}

export async function evaluateProcessingPolicy(manifest: SourceManifest, baseline: MissionPolicy, candidate: MissionPolicy): Promise<PolicyEvaluation> {
  const evaluatedAt = new Date().toISOString(), reasons: string[] = [];
  let baselineCells = 0, candidateCells = 0, baselineBytes = 0, candidateBytes = 0;
  let requiredFactsPreserved = true;
  if (!validPolicy(baseline) || !validPolicy(candidate)) {
    reasons.push("A policy changes fixed row windows, header context, or formula inspection.");
    requiredFactsPreserved = false;
  } else {
    for (const unit of manifest.units) {
      const raw = await readUnit(unit), before = applyProcessingPolicy(raw, baseline), after = applyProcessingPolicy(raw, candidate);
      const baselineCheck = checkPolicyProjection(raw, before), candidateCheck = checkPolicyProjection(raw, after);
      if (!baselineCheck.passed || !candidateCheck.passed) {
        requiredFactsPreserved = false;
        reasons.push(...baselineCheck.reasons, ...candidateCheck.reasons);
      }
      baselineCells += before.records.length; candidateCells += after.records.length;
      // Compare the actual serializable model context, including explicit omission metadata.
      baselineBytes += bytes(before); candidateBytes += bytes(after);
    }
  }
  const reduction = baselineBytes ? (baselineBytes - candidateBytes) / baselineBytes : 0;
  if (reduction < POLICY_GATE.minimumByteReduction) reasons.push(`Context-byte reduction ${(reduction * 100).toFixed(2)}% does not meet the predeclared 5% gate.`);
  if (candidate.omitEmptyCells === baseline.omitEmptyCells) reasons.push("The candidate does not change the active context policy.");
  const decision = requiredFactsPreserved && !reasons.length ? "promoted" : "rejected";
  if (decision === "promoted") reasons.push(`All source records required by the structural guard remain byte-identical; serialized context decreased ${(reduction * 100).toFixed(2)}%.`);
  return { id: hash({ manifest: manifest.id, baseline, candidate, evaluatedAt }), candidateId: candidate.id, baselineId: baseline.id, evaluatedAt, decision,
    baselineCells, candidateCells, baselineBytes, candidateBytes, requiredFactsPreserved, reasons,
    dataset: `${manifest.id}:registered-nine-unit-development-regression`,
    scopeNote: "Measured serialized-context bytes on the immutable registered mission units. These inspected records are development/regression data, not an untouched holdout. Structural source/citation/formula/date-boundary fidelity was checked; model token savings, extraction accuracy, and generalization were not measured. Human acceptance is unchanged." };
}
