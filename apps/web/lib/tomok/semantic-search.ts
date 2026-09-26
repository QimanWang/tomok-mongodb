import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import { evidenceForModel } from "./evidence";
import type { EvidenceRecord } from "./import-types";
import type { MemorySummary } from "./memory-service";
import { PROJECT_ID, type Release } from "./repository";

// Derived projections only: original imports and reviewed revision histories stay immutable.
export const SEARCH_COLLECTION = "project_search_documents";
export const SEARCH_INDEX = "tomok_semantic_v1";
export const EMBEDDING_MODEL = "voyage-4";
export const EMBEDDING_DIMENSIONS = 1024;
const PROJECTION_VERSION = "safe-evidence-and-reviewed-memory-v1";
export type SearchKind = "evidence" | "memory";
export type SearchCandidate<T> = { id: string; text: string; availableOn: string; value: T };
type SearchDocument = {
  _id: string; projectId: string; releaseId: string; kind: SearchKind;
  recordId: string; text: string; availableOn: string; projectionVersion: string;
  embeddingModel: string; embeddingDimensions: number;
};
type SearchHit = { _id: string; score: number };
export type Retrieval = {
  mode: "all-eligible" | "atlas-vector" | "keyword-fallback";
  eligibleCount: number; returnedCount: number;
  index?: string; model?: string; dimensions?: number;
  reason?: "index-not-ready" | "index-catching-up" | "search-unavailable";
  note: string;
};

export const searchIndexDefinition = {
  fields: [
    { type: "autoEmbed", modality: "text", path: "text", model: EMBEDDING_MODEL,
      numDimensions: EMBEDDING_DIMENSIONS, quantization: "float", similarity: "dotProduct" },
    ...["_id", "projectId", "releaseId", "kind", "availableOn"].map((path) => ({ type: "filter", path })),
  ],
};

export function evidenceSearchCandidates(rows: EvidenceRecord[]) {
  return rows.map(evidenceForModel).map((value) => ({ id: value._id, value,
    text: `${value.text}\nActivity: ${value.activityCode ?? value.facts.candidateActivityCode ?? "unconfirmed"}`,
    availableOn: value.observedDate ?? "0001-01-01" }));
}

export function memorySearchCandidates(rows: MemorySummary[]) {
  return rows.map((value) => ({ id: `${value.id}:${value.revision}`, value,
    text: `${value.kind}: ${value.title}\n${value.statement}`,
    availableOn: [value.validFrom, ...value.citations.flatMap((citation) => citation.observedDate ? [citation.observedDate] : [])].sort().at(-1)!,
  }));
}

export function searchDocument<T>(release: Release, kind: SearchKind, candidate: SearchCandidate<T>): SearchDocument {
  const identity = [PROJECTION_VERSION, release.projectId, release.releaseId, kind, candidate.id, candidate.text, candidate.availableOn];
  return {
    _id: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
    projectId: PROJECT_ID, releaseId: release.releaseId, kind, recordId: candidate.id,
    text: candidate.text, availableOn: candidate.availableOn, projectionVersion: PROJECTION_VERSION,
    embeddingModel: EMBEDDING_MODEL, embeddingDimensions: EMBEDDING_DIMENSIONS,
  };
}

export async function syncSearchCandidates<T>(db: Db, release: Release, kind: SearchKind, candidates: SearchCandidate<T>[]) {
  const documents = candidates.map((candidate) => searchDocument(release, kind, candidate));
  if (documents.length) {
    await db.collection<SearchDocument>(SEARCH_COLLECTION).bulkWrite(documents.map((document) => ({
      updateOne: { filter: { _id: document._id }, update: { $setOnInsert: document }, upsert: true },
    })), { ordered: false });
  }
  return documents;
}

export async function searchIndexStatus(db: Db) {
  const index = (await db.collection(SEARCH_COLLECTION).listSearchIndexes(SEARCH_INDEX).toArray())[0] as
    { name: string; status?: string; queryable?: boolean } | undefined;
  return { name: SEARCH_INDEX, model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS,
    status: index?.status ?? "NOT_CREATED", queryable: index?.queryable === true };
}

export async function ensureSearchIndex(db: Db) {
  const collection = db.collection(SEARCH_COLLECTION);
  const existing = (await collection.listSearchIndexes(SEARCH_INDEX).toArray())[0];
  if (!existing) await collection.createSearchIndex({ name: SEARCH_INDEX, type: "vectorSearch", definition: searchIndexDefinition });
  return searchIndexStatus(db);
}

export function vectorPipeline(release: Release, kind: SearchKind, cutoff: string, query: string, documentIds: string[]) {
  return [
    { $vectorSearch: {
      index: SEARCH_INDEX, path: "text", query: { text: query }, model: EMBEDDING_MODEL,
      exact: true, limit: documentIds.length,
      // IDs are derived from the current authorized/eligible revision, never supplied by a caller.
      // This prefilter also excludes stale index entries after edits, flags, withdrawals, or imports.
      filter: { $and: [
        { projectId: { $eq: PROJECT_ID } }, { releaseId: { $eq: release.releaseId } },
        { kind: { $eq: kind } }, { availableOn: { $lte: cutoff } }, { _id: { $in: documentIds } },
      ] },
    } },
    // Never return indexed text. Resolve every hit against the freshly authorized source projection.
    { $project: { _id: 1, score: { $meta: "vectorSearchScore" } } },
  ];
}

export function resolveSearchHits<T>(documents: SearchDocument[], candidates: SearchCandidate<T>[], hits: SearchHit[]) {
  const allowed = new Map(documents.map((document, index) => [document._id, candidates[index]!]));
  const seen = new Set<string>();
  return hits.filter((hit) => {
    if (!allowed.has(hit._id) || seen.has(hit._id) || !Number.isFinite(hit.score)) return false;
    seen.add(hit._id); return true;
  }).sort((a, b) => b.score - a.score || a._id.localeCompare(b._id))
    .map((hit) => ({ candidate: allowed.get(hit._id)!, score: hit.score }));
}

export async function rankSearchCandidates<T>(db: Db, release: Release, kind: SearchKind, cutoff: string, query: string | undefined, input: SearchCandidate<T>[]) {
  const candidates = input.filter((row) => row.availableOn <= cutoff).slice(0, 100);
  if (!query?.trim() || candidates.length === 0) return {
    values: candidates.map((row) => row.value),
    retrieval: { mode: "all-eligible", eligibleCount: candidates.length, returnedCount: candidates.length,
      note: "All eligible records in the bounded corpus; no semantic ranking was needed." } satisfies Retrieval,
  };
  const fallback = (reason: NonNullable<Retrieval["reason"]>) => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const values = candidates.filter((row) => terms.every((term) => row.text.toLowerCase().includes(term))).map((row) => row.value);
    return { values, retrieval: { mode: "keyword-fallback", reason, eligibleCount: candidates.length, returnedCount: values.length,
      note: "Semantic search is unavailable or still indexing. These results require every query word. An empty result does not establish absence in the source files." } satisfies Retrieval };
  };
  try {
    if (!(await searchIndexStatus(db)).queryable) return fallback("index-not-ready");
    const documents = await syncSearchCandidates(db, release, kind, candidates);
    const hits = await db.collection<SearchDocument>(SEARCH_COLLECTION)
      .aggregate<SearchHit>(vectorPipeline(release, kind, cutoff, query, documents.map((row) => row._id)), { maxTimeMS: 15_000 }).toArray();
    const resolved = resolveSearchHits(documents, candidates, hits);
    // Atlas indexing is asynchronous. Do not silently omit newly reviewed or newly imported records.
    if (resolved.length !== candidates.length) return fallback("index-catching-up");
    const values = resolved.slice(0, 8).map(({ candidate, score }) => ({ ...candidate.value, semanticScore: score }));
    return { values, retrieval: { mode: "atlas-vector", eligibleCount: candidates.length, returnedCount: values.length,
      index: SEARCH_INDEX, model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS,
      note: "Semantic similarity ranks up to eight eligible records. Scores measure retrieval similarity, not confidence, factual correctness, or approval." } satisfies Retrieval };
  } catch {
    // Query/index failures must not leak driver connection details or masquerade as semantic results.
    return fallback("search-unavailable");
  }
}
