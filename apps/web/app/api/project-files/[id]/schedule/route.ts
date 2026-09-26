import { readSchedule } from "@/lib/project-files/catalog";
import { fileError, requireProjectAccess } from "@/lib/project-files/access";
import { storageConfiguration, projectDb } from "@/lib/tomok/db";
import { readPersistedSchedule, requireRelease } from "@/lib/tomok/repository";
import { projectError } from "@/lib/tomok/http";
import { TomokError, safeStorageError } from "@/lib/tomok/errors";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireProjectAccess();
    const { id } = await params;
    let schedule;
    if (storageConfiguration().configured) {
      try {
        const db = await projectDb();
        schedule = await readPersistedSchedule(db, await requireRelease(db), id);
      } catch (error) { safeStorageError(error); }
    } else {
      schedule = await readSchedule(id);
    }
    return Response.json(schedule, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof TomokError) return projectError(error);
    return fileError(error);
  }
}
