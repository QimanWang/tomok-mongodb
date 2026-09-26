import test from "node:test";
import assert from "node:assert/strict";
import {
  createSourceManifest, createSourceUnit, readUnit, validateProposedFacts,
  proposedFactSchema, SOURCE_UNIT_LIMITS,
} from "../apps/web/lib/tomok/missions/source-units.ts";
import { auditFactProvenance } from "../apps/web/lib/tomok/missions/validation.ts";

const manifest = createSourceManifest({ releaseId: "source-contract-tests", cutoff: "2026-07-16" });
const cache = new Map();
async function unit(index) {
  if (!cache.has(index)) cache.set(index, readUnit(manifest.units[index]));
  return cache.get(index);
}
const record = (read, suffix) => read.records.find((item) => item.locator.endsWith(suffix));
const citation = (read, source, quote = source.display) => ({ unitId: read.unit.id, locator: source.locator, quote });
const textFact = (read, source) => ({ kind: "text", label: "Source excerpt", value: source.display, citation: citation(read, source) });

test("mission manifest inventories eight originals and declares exactly nine bounded units", () => {
  assert.equal(manifest.sources.length, 8);
  assert.equal(manifest.sources.filter((source) => source.extraction === "in-scope").length, 3);
  assert.equal(manifest.units.length, 9);
  assert.equal(new Set(manifest.units.map((item) => item.id)).size, 9);
  assert.deepEqual(manifest, createSourceManifest({ releaseId: "source-contract-tests", cutoff: "2026-07-16" }));
  assert.notEqual(manifest.id, createSourceManifest({ releaseId: "next-release", cutoff: "2026-07-16" }).id);
  assert.notEqual(manifest.units[5].id, createSourceManifest({ releaseId: "source-contract-tests", cutoff: "2026-07-15" }).units[5].id);
  assert.deepEqual(manifest.units[1].headerRows, [4, 5]);
  assert.equal(manifest.units[5].label, "Daily Construction Report!B3:AD3");
  assert.equal(manifest.sources.find((source) => source.kind === "pdf").extraction, "inventory-only");
});

test("source descriptors reject fake hashes, unregistered sheets, excessive ranges, and relabeled observations", async () => {
  const { id, version, name, label, href, ...input } = manifest.units[5];
  for (const patch of [
    { sha256: "0".repeat(64) }, { sourceId: "0".repeat(16) }, { sheet: "invented" },
    { endRow: 100 }, { endColumn: 64 }, { headerRows: [6] }, { cutoff: "2026-02-30" },
  ]) assert.throws(() => createSourceUnit({ ...input, ...patch }));
  await assert.rejects(readUnit({ ...manifest.units[5], endRow: 4 }), /identity or range/);
  await assert.rejects(readUnit({ ...manifest.units[5], href: "/files?file=elsewhere" }), /identity or range/);
});

test("all preset ranges are read from real originals within reader budgets", async () => {
  for (let index = 0; index < manifest.units.length; index++) {
    const read = await unit(index);
    assert.equal(read.status, "read");
    assert.ok(read.records.length > 0 && read.records.length <= SOURCE_UNIT_LIMITS.records);
    assert.ok(JSON.stringify(read.records).length <= SOURCE_UNIT_LIMITS.characters);
    assert.match(read.contentHash, /^[a-f0-9]{64}$/);
    assert.equal(new Set(read.records.map((item) => item.locator)).size, read.records.length);
    for (const source of read.records) assert.ok(source.href.startsWith(`/files?file=${read.unit.sourceId}&`));
  }
});

test("SOE retains original formula caches, shared formulas, merged group headers, and unknown issue date", async () => {
  const read = await unit(2), forecast = record(read, "!O98");
  assert.equal(forecast.display, "21-Oct-26T");
  assert.equal(forecast.cachedValue, "21-Oct-26T");
  assert.equal(forecast.original.value, "21-Oct-26T");
  assert.equal(forecast.original.type, "str");
  assert.match(forecast.formula, /COUNTA\(O99:O114\).*ROWS\(O99:O112\)/);
  assert.equal(forecast.dateSemantics, "forecast");
  assert.equal(record(read, "!N98").dateSemantics, "observed");
  assert.equal(record(read, "!L98").dateSemantics, "planned");
  assert.match(record(read, "!J4").display, /field conditions/);
  assert.equal(record(read, "!K4").mergeMaster, "J4");
  assert.ok(read.warnings.some((warning) => warning.includes("no established issue date")));
  const line = await unit(3);
  assert.equal(record(line, "!P102").display, "");
  assert.ok(record(line, "!P102").formula);
  assert.ok(record(line, "!Q102").formula);
});

test("raw XER neighborhood exposes exact source IDs and relationship fields without a computed case answer", async () => {
  const read = await unit(0);
  assert.equal(record(read, "TASK:2437:task_code").display, "2A-SP01-GRND-710C-XP");
  assert.equal(record(read, "TASK:2436:task_code").display, "2A-SP01-GRND-710B-XP");
  assert.equal(record(read, "PROJECT:393:last_recalc_date").display, "2026-04-27 07:00");
  assert.ok(read.records.some((item) => item.locator.startsWith("TASKPRED:") && item.locator.endsWith(":pred_type")));
  assert.ok(read.records.every((item) => !item.locator.startsWith("UDFVALUE:")));
  assert.ok(read.warnings.some((warning) => warning.includes("Other XER fields and tables are outside")));
});

test("earlier cutoff records explicit exclusions without returning future daily cells or SOE observations", async () => {
  const early = createSourceManifest({ releaseId: "source-contract-tests", cutoff: "2026-07-13" });
  assert.equal(early.units.length, 9);
  const future = await readUnit(early.units[6]);
  assert.equal(future.status, "outside-cutoff");
  assert.deepEqual(future.records, []);
  assert.doesNotMatch(JSON.stringify(future), /49\/392/);
  const soe = await readUnit(early.units[2]);
  assert.equal(record(soe, "!F98"), undefined);
  assert.equal(record(soe, "!E98").display, "2A-SP01-GRND-710C-XP");
  assert.equal(record(soe, "!L98").display, "2026-10-21");
  assert.ok(soe.coverage.omitted > 0);
  const preExport = await readUnit(createSourceManifest({ releaseId: "source-contract-tests", cutoff: "2026-01-01" }).units[0]);
  assert.equal(preExport.status, "outside-cutoff");
  assert.deepEqual(preExport.records, []);
});

test("validated facts preserve source/release/locator identity and remain explicitly unreviewed", async () => {
  const read = await unit(5), source = record(read, "!AD3");
  const proposed = { kind: "quantity", label: "Reported grouted columns", value: { completed: 44, total: 392, unit: "columns", operation: "jet-grouted" },
    applicableDate: "2026-07-13", citation: citation(read, source, "Jet Grouted 44/392") };
  const [fact] = validateProposedFacts(read, [proposed]);
  assert.equal(fact.reviewStatus, "unreviewed");
  assert.equal(fact.validation, "citation-and-value");
  assert.equal(fact.sha256, read.unit.sha256);
  assert.equal(fact.releaseId, manifest.releaseId);
  assert.equal(fact.href, source.href);
  assert.equal(fact.contentHash, read.contentHash);
  assert.equal(fact.observedDate, "2026-07-13");
  assert.deepEqual(validateProposedFacts(read, [proposed]), [fact]);
  assert.throws(() => validateProposedFacts(read, [proposed, proposed]), /duplicate/);
  assert.throws(() => validateProposedFacts(read, [proposed, { ...proposed, label: "Same columns with a new label" }]), /duplicate/);
});

test("facts reject invented citations, cross-unit references, paraphrases, dates and denominators", async () => {
  const read = await unit(5), source = record(read, "!AD3"), valid = textFact(read, source);
  for (const invalid of [
    { ...valid, value: "The source proves a project delay." },
    { ...valid, citation: { ...valid.citation, unitId: manifest.units[6].id } },
    { ...valid, citation: { ...valid.citation, locator: "Daily Construction Report!AD6" } },
    { ...valid, citation: { ...valid.citation, quote: "Jet Grouted 99/392" } },
    { ...valid, applicableDate: "2026-07-16" },
    { kind: "number", label: "Partial denominator", value: 44, citation: citation(read, source, "44") },
    { kind: "quantity", label: "False denominator", value: { completed: 44, total: 400, unit: "columns", operation: "jet-grouted" }, citation: citation(read, source, "Jet Grouted 44/392") },
    { kind: "quantity", label: "Wrong operation", value: { completed: 72, total: 392, unit: "columns", operation: "jet-grouted" }, citation: citation(read, source, "Predrill: 72/392   Jet Grouted 44/392") },
    { kind: "quantity", label: "Clipped numerator", value: { completed: 4, total: 392, unit: "columns", operation: "unclassified" }, citation: citation(read, source, "4/392") },
    { kind: "quantity", label: "Clipped denominator", value: { completed: 0, total: 2, unit: "columns", operation: "unclassified" }, citation: citation(read, source, "0/2") },
  ]) assert.throws(() => validateProposedFacts(read, [invalid]));
  assert.equal(proposedFactSchema.safeParse({ ...valid, humanAccepted: true }).success, false);
  const header = read.records.find((item) => item.role === "header" && item.display.trim());
  assert.throws(() => validateProposedFacts(read, [textFact(read, header)]), /headers provide interpretation context/);
});

test("line quantities distinguish predrilling from grouting and preserve totals", async () => {
  const read = await unit(5), source = record(read, "!AD3");
  const quote = source.display.split("\n").find((line) => line.startsWith("Line M:"));
  const proposed = { kind: "quantity", label: "Line M grouted", value: { completed: 16, total: 28, unit: "columns", operation: "jet-grouted" }, citation: citation(read, source, quote) };
  assert.equal(validateProposedFacts(read, [proposed])[0].value.completed, 16);
  assert.throws(() => validateProposedFacts(read, [{ ...proposed, value: { ...proposed.value, completed: 28 } }]), /other operation/);
});

test("documented identifier candidates require complete activity codes rather than aliases or substrings", async () => {
  const read = await unit(2), source = record(read, "!E98");
  const fact = { kind: "identifier", label: "Explicit activity code", value: source.display, citation: citation(read, source) };
  assert.equal(validateProposedFacts(read, [fact])[0].value, "2A-SP01-GRND-710C-XP");
  const substring = "SP01-GRND-710C";
  assert.throws(() => validateProposedFacts(read, [{ ...fact, value: substring, citation: citation(read, source, substring) }]), /substring/);
  const line = await unit(3), alias = record(line, "!E102");
  assert.throws(() => validateProposedFacts(line, [{ ...fact, value: alias.display, citation: citation(line, alias) }]));
});

test("date validation distinguishes forecast markers, field plan dates, observation dates, and snapshot dates", async () => {
  const soe = await unit(2), forecast = record(soe, "!O98"), plan = record(soe, "!L98");
  const fact = { kind: "date", label: "Formula forecast finish", value: "2026-10-21", dateSemantics: "forecast", citation: citation(soe, forecast) };
  assert.equal(validateProposedFacts(soe, [fact])[0].dateSemantics, "forecast");
  for (const dateSemantics of ["observed", "planned", "unknown"])
    assert.throws(() => validateProposedFacts(soe, [{ ...fact, dateSemantics }]), /forecast marker/);
  assert.throws(() => validateProposedFacts(soe, [{ ...fact, citation: citation(soe, plan), dateSemantics: "observed" }]), /date semantics/);
  const daily = await unit(5), observed = record(daily, "!C3");
  const observedFact = { kind: "date", label: "Report date", value: "2026-07-13", dateSemantics: "observed", citation: citation(daily, observed) };
  assert.equal(validateProposedFacts(daily, [observedFact])[0].value, "2026-07-13");
  assert.throws(() => validateProposedFacts(daily, [{ ...observedFact, value: "2026-07-14" }]), /normalize/);
  const schedule = await unit(0), snapshot = record(schedule, "PROJECT:393:last_recalc_date");
  assert.equal(validateProposedFacts(schedule, [{ kind: "date", label: "Data date", value: "2026-04-27", dateSemantics: "snapshot", citation: citation(schedule, snapshot) }])[0].value, "2026-04-27");
});

test("explicit formula provenance requires a source formula and audits prior labels without changing facts", async () => {
  const summary = await unit(2), computed = record(summary, "!K98");
  const formulaDate = { kind: "date", label: "Current start (formula-derived)", value: "2026-06-22", dateSemantics: "planned", citation: citation(summary, computed) };
  const [computedFact] = validateProposedFacts(summary, [formulaDate]);
  assert.deepEqual(auditFactProvenance(summary, [computedFact]), []);

  const line = await unit(3), literal = record(line, "!K102");
  const literalDate = { ...formulaDate, label: "Current start", value: "2026-07-06", citation: citation(line, literal) };
  const [literalFact] = validateProposedFacts(line, [literalDate]);
  for (const claim of ["formula-derived", "formula based", "derived from formula", "derived from a formula", "derived from the formula"]) {
    assert.throws(() => validateProposedFacts(line, [{ ...literalDate, label: `Current start (${claim})` }]), /claims formula provenance/);
  }
  for (const label of ["Current start; formula not supplied", "Current start (not formula-derived)", "Current start (non-formula-derived)"])
    assert.equal(validateProposedFacts(line, [{ ...literalDate, label }]).length, 1);

  const prior = { ...literalFact, label: "Current start (formula-derived)" }, before = JSON.stringify(prior);
  const questions = auditFactProvenance(line, [prior, prior]);
  assert.equal(questions.length, 1);
  assert.match(questions[0], /2026 Master Schedule!K102/);
  assert.match(questions[0], /literal date value and no formula/);
  assert.match(questions[0], /date value is unchanged/);
  assert.equal(JSON.stringify(prior), before);
  assert.deepEqual(auditFactProvenance(summary, [prior]), []);
  assert.deepEqual(auditFactProvenance(line, [{ ...prior, kind: "text" }]), []);
});
