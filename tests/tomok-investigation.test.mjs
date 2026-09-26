import test from "node:test";
import assert from "node:assert/strict";
import { buildProjectImport } from "../apps/web/lib/tomok/import-data.ts";
import { buildInvestigation } from "../apps/web/lib/tomok/investigation.ts";

const imported = await buildProjectImport();
const activity = imported.activities.find((item) => item.code === "2A-SP01-GRND-710C-XP");
const base = {
  cutoff: "2026-07-16",
  question: "How is South Portal jet grouting progressing against the field plan and P6?",
  snapshot: imported.snapshot,
  activity,
  evidence: imported.evidence,
};

function finding(result, id) {
  const value = result.findings.find((item) => item.id === id);
  assert.ok(value, `Missing finding: ${id}`);
  return value;
}

test("July 16 investigation preserves daily quantities, snapshot dates, and real source links", () => {
  const result = buildInvestigation(base);
  assert.match(finding(result, "reported-production").text, /2026-07-16.*56\/392.*90\/392/);
  assert.match(finding(result, "reported-lines").text, /Line M at 28\/28.*Line L at 0\/28/);
  assert.match(finding(result, "observed-change").text, /55\/392 to 56\/392.*27\/28 to 28\/28/);
  assert.equal(result.basis.dataDate, "2026-04-27 07:00");
  assert.equal(result.basis.exportDate, "2026-07-06");
  assert.equal(result.basis.approvalStatus, "unconfirmed");
  const known = new Set([activity.href, ...imported.evidence.flatMap((item) => [
    item.href,
    ...Object.keys(item.rawCells).map((cell) => {
      const url = new URL(item.href, "https://tomok.invalid");
      url.searchParams.set("cell", cell);
      return `${url.pathname}${url.search}`;
    }),
  ])]);
  for (const item of result.findings) {
    assert.ok(item.citations.length > 0, item.id);
    for (const citation of item.citations) assert.ok(known.has(citation.href), citation.href);
  }
});

test("cutoff excludes later daily observations even when the full import is supplied", () => {
  const result = buildInvestigation({ ...base, cutoff: "2026-07-14" });
  assert.match(finding(result, "reported-production").text, /2026-07-14.*49\/392.*76\/392/);
  assert.match(finding(result, "reported-lines").text, /Line M at 21\/28.*Line L at 0\/28/);
  assert.match(finding(result, "observed-change").text, /44\/392 to 49\/392/);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /56\/392|55\/392|90\/392|83\/392/);
  const futureHrefs = imported.evidence.filter((item) => item.observedDate > "2026-07-14").map((item) => item.href);
  for (const href of futureHrefs) assert.ok(!result.findings.some((item) => item.citations.some((citation) => citation.href === href)));
});

test("undated plans stay conditional and cached forecast text is not an actual finish", () => {
  const result = buildInvestigation(base);
  const m = finding(result, "line-m-plan-review");
  const l = finding(result, "line-l-plan-review");
  assert.equal(m.kind, "inferred");
  assert.equal(l.kind, "inferred");
  assert.match(m.text, /undated.*2026-07-15.*If Jae confirms/);
  assert.match(l.text, /undated.*2026-07-16.*If Jae confirms/);
  assert.match(finding(result, "forecast-marker").text, /21-Oct-26T.*not an observed actual finish/);
  assert.equal(new URL(m.citations[0].href, "https://tomok.invalid").searchParams.get("cell"), "L102");
  assert.equal(new URL(l.citations[0].href, "https://tomok.invalid").searchParams.get("cell"), "K103");
  assert.equal(new URL(finding(result, "forecast-marker").citations[0].href, "https://tomok.invalid").searchParams.get("cell"), "O98");
  assert.match(finding(result, "cause-and-impact").text, /do not establish the cause/);
  assert.equal(finding(result, "cause-and-impact").kind, "unresolved");
  assert.doesNotMatch(JSON.stringify(result), /one.day delay|1.day delay|29 days early|14\.3%/i);
});

test("missing or pre-observation cutoffs fail instead of fabricating progress", () => {
  assert.throws(() => buildInvestigation({ ...base, cutoff: "2026-07-12" }), /No eligible dated daily-report evidence/);
  assert.throws(() => buildInvestigation({ ...base, evidence: [] }), /No eligible dated daily-report evidence/);
  assert.throws(() => buildInvestigation({ ...base, cutoff: "2026-02-30" }));
  const result = buildInvestigation({ ...base, cutoff: "2026-07-13" });
  assert.match(finding(result, "reported-production").text, /44\/392/);
  assert.equal(result.findings.some((item) => item.id === "observed-change"), false);
});

test("scope isolation ignores other imports and unpublished reports", () => {
  const daily = imported.evidence.find((item) => item.facts.published === true);
  const canary = {
    ...daily,
    _id: "other-import",
    importVersion: "other-version",
    observedDate: "2026-07-16",
    facts: { ...daily.facts, jetGrouted: { completed: 391, total: 392 } },
  };
  const unpublished = { ...canary, _id: "unpublished", importVersion: daily.importVersion, facts: { ...canary.facts, published: false } };
  const result = buildInvestigation({ ...base, evidence: [...base.evidence, canary, unpublished] });
  assert.match(finding(result, "reported-production").text, /56\/392/);
  assert.doesNotMatch(JSON.stringify(result), /391\/392/);
  assert.throws(() => buildInvestigation({ ...base, activity: { ...activity, snapshotId: "other" } }), /matching schedule snapshot/);
});

test("latest imported report does not imply coverage through a later requested cutoff", () => {
  const result = buildInvestigation({ ...base, cutoff: "2026-07-20" });
  assert.match(finding(result, "reported-production").text, /report dated 2026-07-16/);
  assert.match(result.limitations[0], /2026-07-16.*does not establish.*coverage through 2026-07-20/);
});
