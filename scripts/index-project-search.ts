import { closeProjectDb, projectDb } from "../apps/web/lib/tomok/db";
import { readEvidence, requireRelease } from "../apps/web/lib/tomok/repository";
import { ensureSearchIndex, evidenceSearchCandidates, rankSearchCandidates, searchIndexStatus, syncSearchCandidates } from "../apps/web/lib/tomok/semantic-search";

try {
  const db = await projectDb(); const release = await requireRelease(db);
  if (process.argv.includes("--status")) {
    console.log(JSON.stringify(await searchIndexStatus(db), null, 2));
  } else if (process.argv.includes("--verify")) {
    const cutoff = "2026-07-14";
    const result = await rankSearchCandidates(db, release, "evidence", cutoff, "How many columns were grouted versus predrilled?",
      evidenceSearchCandidates(await readEvidence(db, release, cutoff)));
    const checks = {
      semanticRetrieval: result.retrieval.mode === "atlas-vector",
      datesWithinCutoff: result.values.every((row) => row.observedDate === null || row.observedDate <= cutoff),
      includesDailyReport: result.values.some((row) => row.sourceId === "a32dce5276ea5268" && row.locator.sheet === "Daily Construction Report" && row.locator.cell === "AD4"),
    };
    console.log(JSON.stringify({ cutoff, checks, retrieval: result.retrieval, matches: result.values.map((row) => ({ id: row._id, date: row.observedDate, locator: row.locator })) }, null, 2));
    if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
  } else {
    const candidates = evidenceSearchCandidates(await readEvidence(db, release, "9999-12-31"));
    await syncSearchCandidates(db, release, "evidence", candidates);
    console.log(JSON.stringify({ documents: candidates.length, ...await ensureSearchIndex(db) }, null, 2));
  }
} catch {
  console.error("Search setup failed. Check Atlas search-index permissions and Automated Embedding availability. No source import or reviewed note was changed.");
  process.exitCode = 1;
} finally { await closeProjectDb(); }
