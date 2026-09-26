import { buildProjectImport } from "../apps/web/lib/tomok/import-data";
import { closeProjectDb, projectDb, storageConfiguration } from "../apps/web/lib/tomok/db";
import { persistProjectImport } from "../apps/web/lib/tomok/repository";
import { TomokError } from "../apps/web/lib/tomok/errors";

try {
  const data = await buildProjectImport();
  const counts = {
    sources: data.sources.length, activities: data.activities.length,
    relationships: data.relationships.length, wbs: data.wbs.length,
    calendars: data.calendars.length, evidence: data.evidence.length,
  };
  if (process.argv.includes("--dry-run")) {
    console.log(JSON.stringify({ mode: "validated-local-sources", projectId: data.projectId, importVersion: data.importVersion, counts }, null, 2));
  } else {
    const release = await persistProjectImport(await projectDb(), data);
    console.log(JSON.stringify({ projectId: release.projectId, storage: storageConfiguration().storage, releaseId: release.releaseId, counts: release.counts, activatedAt: release.activatedAt }, null, 2));
  }
} catch (error) {
  console.error(error instanceof TomokError ? error.message : "Project import failed. Check the source manifest, input files, and MongoDB configuration. No new import was activated.");
  process.exitCode = 1;
} finally {
  await closeProjectDb();
}
