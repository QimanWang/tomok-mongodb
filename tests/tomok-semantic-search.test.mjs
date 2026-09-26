import test from "node:test";
import assert from "node:assert/strict";
import { evidenceSearchCandidates, memorySearchCandidates, rankSearchCandidates, searchDocument, SEARCH_COLLECTION } from "../apps/web/lib/tomok/semantic-search.ts";

const release = { projectId: "bp-tunnel", releaseId: "current-import" };
const candidate = (id, date, text = "Grouting completion is separate from predrilling") => ({ id, availableOn: date, text, value: { id, text } });
function searchDb({ hits, queryable = true, fail = false } = {}) {
  const observed = { documents: [], pipeline: null };
  const db = { collection(name) {
    assert.equal(name, SEARCH_COLLECTION);
    return {
      listSearchIndexes: () => ({ toArray: async () => { if (fail) throw new Error("mongodb://secret"); return [{ queryable }]; } }),
      bulkWrite: async (operations) => { observed.documents = operations.map((row) => row.updateOne.update.$setOnInsert); },
      aggregate: (pipeline) => { observed.pipeline = pipeline; return { toArray: async () => hits ?? observed.documents.map((row, i) => ({ _id: row._id, score: 0.9 - i / 10 })) }; },
    };
  } };
  return { db, observed };
}

test("semantic prefilter excludes future evidence and every hit resolves to an allowed current projection", async () => {
  const { db, observed } = searchDb();
  const result = await rankSearchCandidates(db, release, "evidence", "2026-07-14", "progress",
    [candidate("allowed", "2026-07-14"), candidate("future", "2026-07-16")]);
  assert.equal(result.retrieval.mode, "atlas-vector");
  assert.deepEqual(result.values.map((row) => row.id), ["allowed"]);
  assert.equal(observed.documents.length, 1);
  const filter = observed.pipeline[0].$vectorSearch.filter.$and;
  assert.ok(filter.some((row) => row.projectId?.$eq === "bp-tunnel"));
  assert.ok(filter.some((row) => row.releaseId?.$eq === "current-import"));
  assert.ok(filter.some((row) => row.kind?.$eq === "evidence"));
  assert.ok(filter.some((row) => row.availableOn?.$lte === "2026-07-14"));
  assert.deepEqual(filter.find((row) => row._id)._id.$in, [observed.documents[0]._id]);
  assert.deepEqual(observed.pipeline[1].$project, { _id: 1, score: { $meta: "vectorSearchScore" } });
});

test("old revision IDs, duplicate IDs, foreign hits and indexed text cannot enter semantic results", async () => {
  const row = candidate("note:3", "2026-07-14", "Current reviewed interpretation");
  const current = searchDocument(release, "memory", row);
  const previous = searchDocument(release, "memory", { ...row, id: "note:2", text: "Superseded private content" });
  assert.notEqual(current._id, previous._id);
  const { db } = searchDb({ hits: [
    { _id: previous._id, score: 1, text: "Superseded private content" },
    { _id: current._id, score: 0.8, text: "Tampered indexed text" },
    { _id: current._id, score: 0.8 }, { _id: "foreign", score: 1 },
  ] });
  const result = await rankSearchCandidates(db, release, "memory", "2026-07-14", "interpretation", [row]);
  assert.equal(result.retrieval.mode, "atlas-vector");
  assert.equal(result.values.length, 1);
  assert.equal(result.values[0].text, "Current reviewed interpretation");
  assert.doesNotMatch(JSON.stringify(result), /Superseded|Tampered|private content|foreign/);
});

test("index lag and failures are explicit keyword fallback, without disclosing driver errors", async () => {
  for (const [options, reason] of [[{ hits: [] }, "index-catching-up"], [{ queryable: false }, "index-not-ready"], [{ fail: true }, "search-unavailable"]]) {
    const result = await rankSearchCandidates(searchDb(options).db, release, "evidence", "2026-07-14", "grouting", [candidate("one", "2026-07-14")]);
    assert.equal(result.retrieval.mode, "keyword-fallback");
    assert.equal(result.retrieval.reason, reason);
    assert.equal(result.values.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /mongodb:|secret|semanticScore/);
  }
});

test("safe evidence projection removes undated plan descriptions and raw future quantity cells before embedding", () => {
  const [record] = evidenceSearchCandidates([{ _id: "plan", kind: "field-plan", activityCode: null, observedDate: null,
    text: "49/392 on 7/14/2026", facts: { description: "49/392 on 7/14/2026", candidateActivityCode: "activity", currentFinish: "2026-07-15" },
    rawCells: { E102: "49/392" } }]);
  assert.doesNotMatch(JSON.stringify(record), /49\/392|7\/14\/2026|rawCells|description/);
  assert.match(record.text, /Undated.*require review/);
});

test("memory embeddings are revision-specific and require both validity and cited observation dates", () => {
  const note = { id: "note", revision: 4, kind: "mapping", title: "Mapping", statement: "Reviewed statement",
    validFrom: "2026-07-13", citations: [{ observedDate: "2026-07-16" }] };
  const [record] = memorySearchCandidates([note]);
  assert.equal(record.availableOn, "2026-07-16");
  assert.equal(record.id, "note:4");
  assert.notEqual(searchDocument(release, "memory", record)._id,
    searchDocument(release, "memory", { ...record, text: "Changed statement" })._id);
});

test("unqueried and empty eligible sets never call the remote index", async () => {
  const db = { collection() { throw new Error("Must not query remote index"); } };
  for (const [query, candidates] of [[undefined, [candidate("one", "2026-07-14")]], ["anything", []]]) {
    const result = await rankSearchCandidates(db, release, "evidence", "2026-07-14", query, candidates);
    assert.equal(result.retrieval.mode, "all-eligible");
    assert.equal(result.values.length, candidates.length);
  }
});
