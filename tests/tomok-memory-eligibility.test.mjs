import test from "node:test";
import assert from "node:assert/strict";
import { selectApplicableMemory } from "../apps/web/lib/tomok/memory-eligibility.ts";

const scope = {
  releaseId: "active-release",
  activityCode: "2A-SP01-GRND-710C-XP",
  cutoff: "2026-07-16",
};
const actor = { id: "reviewer-user", name: "Recorded reviewer" };

function revision(overrides = {}) {
  return {
    revision: 1,
    status: "reviewed",
    kind: "mapping",
    title: "A reviewed mapping",
    statement: "Use the recorded row mapping with the source's date qualifications.",
    validFrom: "2026-07-14",
    validThrough: null,
    evidenceIds: ["evidence-1"],
    actor,
    recordedAt: "2026-09-23T01:00:00.000Z",
    reason: null,
    citations: [{
      evidenceId: "evidence-1",
      sourceId: "soe-source",
      label: "2026 Master Schedule!E98",
      href: "/files?file=soe-source&sheet=2026+Master+Schedule&cell=E98",
      observedDate: null,
    }],
    operationId: "review-operation",
    ...overrides,
  };
}

function memory(id, latest = revision(), overrides = {}) {
  return {
    _id: id,
    id,
    projectId: "bp-tunnel",
    releaseId: scope.releaseId,
    snapshotId: "snapshot-1",
    activityCode: scope.activityCode,
    originInvestigationId: "a".repeat(32),
    createdBy: actor,
    createdAt: "2026-09-22T01:00:00.000Z",
    visibility: "project",
    latest,
    revisions: [latest],
    ...overrides,
  };
}

test("only the latest reviewed status is applicable", () => {
  const records = ["reviewed", "proposed", "needs_review", "withdrawn"].map((status) =>
    memory(status, revision({ status, statement: status === "reviewed" ? "Allowed text" : `Excluded ${status} text` })),
  );
  const result = selectApplicableMemory(records, scope);
  assert.deepEqual(result.applicable.map((item) => item.id), ["reviewed"]);
  assert.deepEqual(result.excluded, {
    unreviewed: 3, otherImport: 0, otherActivity: 0, outsideValidity: 0, futureEvidence: 0,
  });
  assert.doesNotMatch(JSON.stringify(result), /Excluded .* text/);
});

test("validity endpoints are inclusive and null remains open-ended", () => {
  const records = [
    memory("starts-at-cutoff", revision({ validFrom: scope.cutoff })),
    memory("ends-at-cutoff", revision({ validThrough: scope.cutoff })),
    memory("single-day", revision({ validFrom: scope.cutoff, validThrough: scope.cutoff })),
    memory("starts-later", revision({ validFrom: "2026-07-17" })),
    memory("expired", revision({ validThrough: "2026-07-15" })),
  ];
  const result = selectApplicableMemory(records, scope);
  assert.deepEqual(result.applicable.map((item) => item.id), ["starts-at-cutoff", "ends-at-cutoff", "single-day"]);
  assert.equal(result.excluded.outsideValidity, 2);
  assert.equal(selectApplicableMemory([records[0]], { ...scope, cutoff: "2027-07-16" }).applicable.length, 1);
});

test("any later cited observation excludes the memory while undated sources remain qualified data", () => {
  const original = revision();
  const dated = (observedDate) => ({ ...original.citations[0], observedDate });
  const records = [
    memory("undated", original),
    memory("same-date", revision({ citations: [dated(scope.cutoff)] })),
    memory("earlier-date", revision({ citations: [dated("2026-07-14")] })),
    memory("future-date", revision({ citations: [dated("2026-07-14"), dated("2026-07-17")] })),
  ];
  const result = selectApplicableMemory(records, scope);
  assert.deepEqual(result.applicable.map((item) => item.id), ["undated", "same-date", "earlier-date"]);
  assert.equal(result.excluded.futureEvidence, 1);
  assert.equal(result.applicable[0].latest.citations[0].observedDate, null);
});

test("release and activity scopes require exact matches", () => {
  const records = [
    memory("matching"),
    memory("older-import", revision(), { releaseId: "previous-release" }),
    memory("other-activity", revision(), { activityCode: "2A-SP01-GRND-710B-XP" }),
    memory("case-mismatch", revision(), { activityCode: scope.activityCode.toLowerCase() }),
  ];
  const result = selectApplicableMemory(records, scope);
  assert.deepEqual(result.applicable.map((item) => item.id), ["matching"]);
  assert.equal(result.excluded.otherImport, 1);
  assert.equal(result.excluded.otherActivity, 2);
});

test("a later review can apply to the reporting date without being backdated", () => {
  const record = memory("later-review");
  const result = selectApplicableMemory([record], scope);
  assert.equal(result.applicable.length, 1);
  assert.equal(result.applicable[0].latest.recordedAt, "2026-09-23T01:00:00.000Z");
  assert.deepEqual(result.applicable[0].latest.actor, actor);
});

test("older reviewed revisions never resurface after correction, withdrawal, or scope changes", () => {
  const old = revision({ revision: 1, statement: "Obsolete reviewed statement" });
  const corrected = revision({ revision: 2, status: "needs_review", statement: "Correction awaiting review" });
  const withdrawn = revision({ revision: 2, status: "withdrawn" });
  const laterValidity = revision({ revision: 2, validFrom: "2026-07-17" });
  const records = [
    memory("correction", corrected, { revisions: [old, corrected] }),
    memory("withdrawal", withdrawn, { revisions: [old, withdrawn] }),
    memory("later-validity", laterValidity, { revisions: [old, laterValidity] }),
  ];
  const before = JSON.stringify(records);
  const result = selectApplicableMemory(records, scope);
  assert.equal(result.applicable.length, 0);
  assert.equal(result.excluded.unreviewed, 2);
  assert.equal(result.excluded.outsideValidity, 1);
  assert.doesNotMatch(JSON.stringify(result), /statement|Correction awaiting|Obsolete/);
  assert.equal(JSON.stringify(records), before);
});

test("invalid dates fail closed and exclusions count each record once", () => {
  const base = revision();
  const records = [
    memory("bad-validity", revision({ validFrom: "2026-02-30" })),
    memory("bad-end", revision({ validThrough: "2026-02-30" })),
    memory("bad-citation", revision({ citations: [{ ...base.citations[0], observedDate: "2026-02-30" }] })),
    memory("many-exclusions", revision({ status: "withdrawn", validFrom: "2026-07-20" }), { releaseId: "other", activityCode: "other" }),
  ];
  const result = selectApplicableMemory(records, scope);
  assert.equal(result.applicable.length, 0);
  assert.equal(Object.values(result.excluded).reduce((sum, count) => sum + count, 0), records.length);
  assert.throws(() => selectApplicableMemory([], { ...scope, cutoff: "2026-02-30" }), /valid reporting date/);
});
