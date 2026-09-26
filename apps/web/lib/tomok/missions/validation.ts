import { createHash } from "node:crypto";
import { z } from "zod";
import type { SourceUnitRead, SourceValue } from "./source-units";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Expected a real calendar date.");
const base = {
  label: z.string().trim().min(1).max(180),
  citation: z.strictObject({ unitId: z.string().regex(/^[a-f0-9]{32}$/), locator: z.string().min(1).max(220), quote: z.string().min(1).max(4_000) }),
  applicableDate: date.nullable().optional(),
};
const dateSemantics = z.enum(["observed", "planned", "forecast", "snapshot", "unknown"]);
export const proposedFactSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...base, kind: z.literal("text"), value: z.string().min(1).max(4_000) }),
  z.strictObject({ ...base, kind: z.literal("identifier"), value: z.string().min(1).max(180).regex(/^(?=.*\d)[A-Z0-9]+(?:-[A-Z0-9]+){2,}$/, "Use the complete explicit P6 activity code; aliases and roll-up labels remain text.") }),
  z.strictObject({ ...base, kind: z.literal("number"), value: z.number().finite() }),
  z.strictObject({ ...base, kind: z.literal("quantity"), value: z.strictObject({ completed: z.number().int().nonnegative(), total: z.number().int().positive(), unit: z.literal("columns"), operation: z.enum(["predrilled", "jet-grouted", "unclassified"]) }) }),
  z.strictObject({ ...base, kind: z.literal("date"), value: date, dateSemantics }),
]);
export type ProposedFact = z.infer<typeof proposedFactSchema>;
export type Fact = ProposedFact & {
  id: string; sourceId: string; sha256: string; releaseId: string; unitId: string; contentHash: string;
  href: string; observedDate: string | null; method: "model-proposed-source-validated";
  reviewStatus: "unreviewed"; validation: "citation-and-value";
};
function reject(message: string): never { throw new Error(`Invalid proposed source fact: ${message}`); }
const whitespace = (text: string) => text.trim().replace(/\s+/g, " ");
function formulaProvenanceClaim(label: string): string | null {
  const phrases = /\b(?:formula[-\s]+(?:derived|based)|derived\s+from\s+(?:(?:a|the)\s+)?formula)\b/gi;
  for (const match of label.matchAll(phrases)) {
    const prefix = label.slice(0, match.index);
    if (/\b(?:not\s+|non[-\s])$/i.test(prefix)) continue;
    return match[0];
  }
  return null;
}

/** Audit only explicit formula-provenance claims; do not rewrite an immutable committed fact. */
export function auditFactProvenance(read: SourceUnitRead, facts: Fact[]): string[] {
  const records = new Map(read.records.map((record) => [record.locator, record]));
  const questions = new Set<string>();
  for (const fact of facts) {
    if (fact.kind !== "date" || fact.citation.unitId !== read.unit.id) continue;
    const claim = formulaProvenanceClaim(fact.label), record = records.get(fact.citation.locator);
    if (!claim || !record || record.formula) continue;
    questions.add(`Provenance check at ${record.locator}: the committed date label claims "${claim}", but this source record preserves a literal date value and no formula. The date value is unchanged; the label's formula provenance is unsupported and needs review.`);
  }
  return [...questions];
}
function normalizeSourceDate(text: string): string | null {
  const iso = /^(\d{4}-\d{2}-\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?Z?)?)?$/.exec(text.trim());
  if (iso) return date.safeParse(iso[1]).success ? iso[1] : null;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim());
  if (us) { const value = `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`; return date.safeParse(value).success ? value : null; }
  const named = /^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})T?$/.exec(text.trim());
  if (named) {
    const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(named[2].toLowerCase()) + 1;
    const value = `${named[3].length === 2 ? `20${named[3]}` : named[3]}-${String(month).padStart(2, "0")}-${named[1].padStart(2, "0")}`;
    return date.safeParse(value).success ? value : null;
  }
  return null;
}
function numericQuote(quote: string): number | null {
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?%?$/.test(quote.trim())) return null;
  const number = Number(quote.trim().replaceAll(",", "").replace(/%$/, ""));
  return Number.isFinite(number) ? number : null;
}
function validateQuantity(fact: Extract<ProposedFact, { kind: "quantity" }>, record: SourceValue, sourceName: string) {
  const { completed, total, operation } = fact.value;
  if (completed > total) reject("completed quantity exceeds its denominator");
  // These two registered workbook formats report column counts. No productivity, volumes, or resources are inferred.
  if (!["Daily-Construction-Report-july12-july17.xlsx", "SOE-Master-Schedule.xlsx"].includes(sourceName)) reject("column units are not established for this source format");
  const quote = fact.citation.quote;
  const ratios = [...quote.matchAll(/(?<![\d/])(\d+)\s*\/\s*(\d+)(?![\d/])/g)];
  const completeSourceRatio = ratios.some((match) => {
    if (Number(match[1]) !== completed || Number(match[2]) !== total) return false;
    for (let offset = record.display.indexOf(quote); offset !== -1; offset = record.display.indexOf(quote, offset + 1)) {
      const start = offset + match.index!, end = start + match[0].length;
      if (!/[\d/,.-]/.test(record.display.slice(Math.max(0, start - 1), start)) && !/[\d/,.-]/.test(record.display.slice(end, end + 1))) return true;
    }
    return false;
  });
  if (!completeSourceRatio) reject("quantity must preserve a complete numerator and denominator at the source locator");
  const line = /^Line [A-N]:\s*(\d+)\/(\d+)\s+(\d+)\/(\d+)\s*$/m.exec(quote);
  if (line && operation !== "unclassified") {
    const offset = operation === "predrilled" ? 1 : 3;
    if (Number(line[offset]) !== completed || Number(line[offset + 1]) !== total) reject("line quantity belongs to the other operation");
  } else if (operation !== "unclassified") {
    const expression = operation === "predrilled" ? /(?:Predrill(?:ed|ing)?)[^\d]{0,90}(\d+)\/(\d+)/i : /(?:Jet\s*Grout(?:ed|ing)?)[^\d]{0,90}(\d+)\/(\d+)/i;
    const labeled = expression.exec(quote);
    if (!labeled || Number(labeled[1]) !== completed || Number(labeled[2]) !== total) reject("the exact quote does not label this quantity's operation");
  }
  if (record.role === "header") reject("a header does not establish an observed quantity");
}

/** Verify evidence fidelity, not model-authored labels, causal explanations, or human acceptance. */
export function validateProposedFacts(read: SourceUnitRead, input: unknown): Fact[] {
  const proposed = z.array(proposedFactSchema).max(24).parse(input);
  if (read.status !== "read" && proposed.length) reject("the source unit is outside the cutoff");
  const records = new Map(read.records.map((record) => [record.locator, record]));
  const seen = new Set<string>();
  return proposed.map((fact) => {
    if (fact.citation.unitId !== read.unit.id) reject("citation belongs to another source unit");
    const record = records.get(fact.citation.locator);
    if (!record || !record.display.includes(fact.citation.quote)) reject("citation quote does not occur at the specified source locator");
    if (record.role === "header") reject("worksheet headers provide interpretation context, not a processed source fact");
    if (!fact.citation.quote.trim()) reject("empty citations do not establish facts");
    if (fact.applicableDate != null && fact.applicableDate !== record.observedDate) reject("applicable date is not the source record's observation date");
    if (fact.kind === "text" && whitespace(fact.value) !== whitespace(fact.citation.quote)) reject("text value must preserve the cited source excerpt");
    if (fact.kind === "identifier") {
      if (fact.value !== fact.citation.quote.trim()) reject("identifier must equal the exact cited token");
      const at = record.display.indexOf(fact.citation.quote), before = record.display.slice(0, at).at(-1) ?? "", after = record.display.slice(at + fact.citation.quote.length, at + fact.citation.quote.length + 1);
      if (/[A-Za-z0-9_-]/.test(before) || /[A-Za-z0-9_-]/.test(after)) reject("identifier cannot be a substring of a longer activity code");
    }
    if (fact.kind === "number") {
      const value = numericQuote(fact.citation.quote);
      if (value === null || value !== fact.value) reject("number must normalize the complete cited number");
      const before = record.display.slice(0, record.display.indexOf(fact.citation.quote)).at(-1) ?? "";
      const after = record.display.slice(record.display.indexOf(fact.citation.quote) + fact.citation.quote.length, record.display.indexOf(fact.citation.quote) + fact.citation.quote.length + 1);
      if (/[\d./-]/.test(before) || /[\d./-]/.test(after)) reject("a partial date, denominator, or number cannot become a standalone numeric fact");
    }
    if (fact.kind === "quantity") validateQuantity(fact, record, read.unit.name);
    if (fact.kind === "date") {
      if (formulaProvenanceClaim(fact.label) && !record.formula) reject("the date label claims formula provenance, but this source record contains no formula");
      if (normalizeSourceDate(fact.citation.quote) !== fact.value) reject("date must normalize the complete cited date");
      const forecast = /^\d{1,2}-[A-Za-z]{3}-\d{2,4}T$/.test(record.display.trim());
      if (forecast && fact.dateSemantics !== "forecast") reject("a forecast marker cannot be asserted as an actual or planned finish");
      const anchoredObservation = record.observedDate === fact.value;
      if (fact.dateSemantics !== record.dateSemantics && !(fact.dateSemantics === "observed" && anchoredObservation) && fact.dateSemantics !== "unknown") reject("date semantics do not match the source field or header");
      if (fact.dateSemantics === "observed" && fact.value > read.unit.cutoff) reject("observed date exceeds the mission cutoff");
      if (fact.dateSemantics === "observed" && !anchoredObservation && record.dateSemantics !== "observed") reject("the source does not establish an observed date");
    }
    const { label: _label, ...evidence } = fact;
    const evidenceKey = JSON.stringify(evidence);
    if (seen.has(evidenceKey)) reject("duplicate proposed facts cannot become additional evidence by changing their label");
    seen.add(evidenceKey);
    const id = createHash("sha256").update(JSON.stringify({ unitId: read.unit.id, contentHash: read.contentHash, fact })).digest("hex").slice(0, 32);
    return { ...fact, id, sourceId: read.unit.sourceId, sha256: read.unit.sha256, releaseId: read.unit.releaseId,
      unitId: read.unit.id, contentHash: read.contentHash, href: record.href, observedDate: record.observedDate,
      method: "model-proposed-source-validated", reviewStatus: "unreviewed", validation: "citation-and-value" };
  });
}
