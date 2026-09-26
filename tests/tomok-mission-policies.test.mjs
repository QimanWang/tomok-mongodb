import test from "node:test";
import assert from "node:assert/strict";
import { createSourceManifest, readUnit } from "../apps/web/lib/tomok/missions/source-units.ts";
import { applyProcessingPolicy, checkPolicyProjection, evaluateProcessingPolicy, proposedPolicySchema } from "../apps/web/lib/tomok/missions/policies.ts";

const policy = (sparse, extra = {}) => ({ id: sparse ? "test-sparse-v2" : "test-dense-v1", version: sparse ? 2 : 1,
  label: sparse ? "Sparse raw context" : "Dense raw context", rowWindow: 1, headerRows: 2,
  omitEmptyCells: sparse, inspectFormulas: true, createdAt: "2026-09-26T12:00:00Z", ...extra });

// Independent fixed guard fixture. It is never returned to a policy-generating agent.
// This is synthetic regression evidence, not an uninspected real-source accuracy benchmark.
function guardFixture() {
  const manifest = createSourceManifest({ releaseId: "policy-private-regression", cutoff: "2026-07-16" });
  const base = { href: "/files?file=test&sheet=fixture&cell=A1", display: "", raw: null, formula: null, cachedValue: null,
    original: null, numberFormat: "", mergeMaster: null, role: "data", dateSemantics: "unknown", observedDate: null };
  const values = [
    { id: "blank", locator: "fixture!A1" },
    { id: "header", locator: "fixture!A2", role: "header" },
    { id: "zero", locator: "fixture!A3", display: "0", raw: 0 },
    { id: "false", locator: "fixture!A4", display: "false", raw: false },
    { id: "space", locator: "fixture!A5", display: " ", raw: " " },
    { id: "formula", locator: "fixture!A6", formula: "SUM(B1:B2)", raw: { formula: "SUM(B1:B2)" } },
    { id: "original-formula", locator: "fixture!A7", original: { formula: "SUM(B1:B2)", value: null, type: null, style: "1" } },
    { id: "forecast", locator: "fixture!A8", display: "21-Oct-26T", formula: 'TEXT(B1,"dd-mmm-yy")&"T"', cachedValue: "21-Oct-26T", dateSemantics: "forecast" },
    { id: "merged", locator: "fixture!A9", mergeMaster: "A8" },
    { id: "date", locator: "fixture!A10", display: "2026-07-14", raw: "2026-07-14T00:00:00Z", dateSemantics: "observed", observedDate: "2026-07-14" },
  ].map((item) => ({ ...base, ...item }));
  return { unit: manifest.units[1], status: "read", records: values, contentHash: "a".repeat(64),
    coverage: { records: values.length, omitted: 0, bounds: "private structural fixture" }, warnings: ["Test fixture only"] };
}

test("fixed structural fixture retains every header, formula, cached marker, zero, false, whitespace, and merged dependency", () => {
  const raw = guardFixture(), before = JSON.stringify(raw), projected = applyProcessingPolicy(raw, policy(true));
  assert.deepEqual(projected.records.map((record) => record.id), ["header", "zero", "false", "space", "formula", "original-formula", "forecast", "merged", "date"]);
  assert.deepEqual(projected.processing.omittedEmptyLocators, ["fixture!A1"]);
  assert.equal(projected.contentHash, raw.contentHash);
  assert.equal(JSON.stringify(raw), before);
  assert.equal(checkPolicyProjection(raw, projected).passed, true);
});

test("independent scorer rejects altered source identities, values, locators, semantics, scope, and required context", () => {
  const raw = guardFixture(), projected = applyProcessingPolicy(raw, policy(true));
  for (const mutate of [
    (copy) => { copy.unit.cutoff = "2026-07-17"; },
    (copy) => { copy.unit.sha256 = "f".repeat(64); },
    (copy) => { copy.contentHash = "f".repeat(64); },
    (copy) => { copy.status = "outside-cutoff"; },
    (copy) => { copy.coverage.omitted = 3; },
    (copy) => { copy.records = copy.records.filter((record) => record.id !== "header"); },
    (copy) => { copy.records = copy.records.filter((record) => record.id !== "formula"); },
    (copy) => { copy.records.find((record) => record.id === "forecast").dateSemantics = "observed"; },
    (copy) => { copy.records[0].href = "/files?file=outside"; },
    (copy) => { copy.records.push(copy.records[0]); },
    (copy) => { copy.processing.omittedEmptyLocators = []; },
    (copy) => { copy.processing.omittedEmptyLocators.push("fixture!not-omitted"); },
  ]) {
    const copy = structuredClone(projected); mutate(copy);
    assert.equal(checkPolicyProjection(raw, copy).passed, false);
  }
});

test("adaptive schema cannot change range, header, formula, auth, or evidence guards", () => {
  assert.deepEqual(proposedPolicySchema.parse({ omitEmptyCells: true }), { omitEmptyCells: true });
  for (const field of ["rowWindow", "headerRows", "inspectFormulas", "sourceId", "cutoff", "instructions"])
    assert.equal(proposedPolicySchema.safeParse({ omitEmptyCells: true, [field]: "override" }).success, false);
  for (const extra of [{ rowWindow: 4 }, { headerRows: 0 }, { inspectFormulas: false }])
    assert.throws(() => applyProcessingPolicy(guardFixture(), policy(true, extra)), /fixed/);
  const sparse = applyProcessingPolicy(guardFixture(), policy(true));
  assert.throws(() => applyProcessingPolicy(sparse, policy(true)), /dense source read/);
});

test("out-of-cutoff outcomes retain empty evidence and cannot gain source records", () => {
  const raw = { ...guardFixture(), status: "outside-cutoff", records: [], coverage: { records: 0, omitted: 1, bounds: "outside-cutoff" } };
  const sparse = applyProcessingPolicy(raw, policy(true));
  assert.deepEqual(sparse.records, []);
  assert.equal(checkPolicyProjection(raw, sparse).passed, true);
  sparse.records = guardFixture().records;
  assert.equal(checkPolicyProjection(raw, sparse).passed, false);
});

test("real immutable mission units demonstrate measured byte efficiency without claiming token or accuracy gains", async () => {
  const manifest = createSourceManifest({ releaseId: "policy-real-development", cutoff: "2026-07-16" });
  const evaluation = await evaluateProcessingPolicy(manifest, policy(false), policy(true));
  assert.equal(evaluation.requiredFactsPreserved, true);
  assert.equal(evaluation.decision, "promoted");
  assert.ok(evaluation.candidateCells < evaluation.baselineCells);
  assert.ok(evaluation.candidateBytes <= evaluation.baselineBytes * 0.95);
  assert.match(evaluation.scopeNote, /not an untouched holdout/);
  assert.match(evaluation.scopeNote, /model token savings, extraction accuracy, and generalization were not measured/);
  const sharedFormulaRow = await readUnit(manifest.units[3]);
  const projected = applyProcessingPolicy(sharedFormulaRow, policy(true));
  for (const locator of ["2026 Master Schedule!P102", "2026 Master Schedule!Q102"])
    assert.deepEqual(projected.records.find((record) => record.locator === locator), sharedFormulaRow.records.find((record) => record.locator === locator));
  console.log(`Real context bytes ${evaluation.baselineBytes} -> ${evaluation.candidateBytes}; source records ${evaluation.baselineCells} -> ${evaluation.candidateCells}`);
});

test("identical and guard-changing candidates are rejected rather than manufacturing improvement", async () => {
  const manifest = createSourceManifest({ releaseId: "policy-real-development", cutoff: "2026-07-16" });
  const identical = await evaluateProcessingPolicy(manifest, policy(false), policy(false, { id: "same-behavior" }));
  assert.equal(identical.decision, "rejected");
  assert.equal(identical.baselineCells, identical.candidateCells);
  assert.match(identical.reasons.join(" "), /does not change/);
  const unsafe = await evaluateProcessingPolicy(manifest, policy(false), policy(true, { inspectFormulas: false }));
  assert.equal(unsafe.decision, "rejected");
  assert.equal(unsafe.requiredFactsPreserved, false);
  assert.match(unsafe.reasons.join(" "), /fixed row windows/);
});
