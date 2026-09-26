import { z } from "zod";
import manifest from "../project-files/source-manifest.json";
import { cellPosition } from "../project-files/workbook";
import type { ActivityRecord, EvidenceRecord, SourceRecord } from "./import-types";
import { TomokError } from "./errors";

export const selectedSourceInput = z.strictObject({
  sourceId: z.string().regex(/^[a-f0-9]{16}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  activity: z.string().trim().min(1).max(100).optional(),
  sheet: z.string().min(1).max(128).optional(),
  cell: z.string().trim().toUpperCase().regex(/^[A-Z]{1,3}[1-9]\d{0,6}$/).optional(),
  page: z.number().int().positive().max(10_000).optional(),
});
export type SelectedSourceInput = z.infer<typeof selectedSourceInput>;
export type SelectedSource = SelectedSourceInput & {
  name: string;
  kind: SourceRecord["kind"];
  label: string;
  href: string;
  coverage: "schedule-activity" | "curated-record" | "reference-only";
  coverageNote: string;
  evidenceIds: string[];
};

/** Validate a locator without turning selected text into trusted or newly ingested evidence. */
export function resolveSelectedSource(input: unknown, context: {
  sources: readonly SourceRecord[];
  activities: readonly ActivityRecord[];
  evidence: readonly EvidenceRecord[];
  activityCode: string;
}): SelectedSource {
  const parsed = selectedSourceInput.safeParse(input);
  if (!parsed.success) throw new TomokError("Select a registered source version and a valid activity, cell, or page.", 400);
  const selected = parsed.data;
  const source = context.sources.find(row => row.sourceId === selected.sourceId && row.sha256 === selected.sha256);
  if (!source) throw new TomokError("The selected source version is not in this project import. Reopen Project files and select it again.", 409);
  const registration = manifest.files.find(row => row.sha256 === source.sha256);
  if (!registration) throw new TomokError("The selected source version is not registered for viewing.", 409);
  const { activity, sheet, cell, page } = selected;
  const wrongKind = (activity !== undefined && source.kind !== "xer") ||
    ((sheet !== undefined || cell !== undefined) && source.kind !== "xlsx") ||
    (page !== undefined && source.kind !== "pdf");
  if (wrongKind) throw new TomokError("This source format does not support the selected location.", 400);
  let selectedActivity: ActivityRecord | undefined;
  if (activity !== undefined) {
    selectedActivity = context.activities.find(row => row.id === activity && row.sourceId === source.sourceId);
    if (!selectedActivity) throw new TomokError("The selected activity is not in this source version.", 404);
  }
  if (cell !== undefined && sheet === undefined) throw new TomokError("Select the worksheet along with its cell.", 400);
  if (sheet !== undefined) {
    const sheets = "sheets" in registration ? registration.sheets ?? [] : [];
    const selectedSheet = sheets.find(row => row.name === sheet);
    if (!selectedSheet) throw new TomokError("The selected worksheet is not in this source version.", 404);
    if (cell !== undefined) {
      const position = cellPosition(cell);
      if (!position || position.row > selectedSheet.rows || position.column > selectedSheet.cols) {
        throw new TomokError("The selected cell is outside this worksheet's registered range.", 400);
      }
    }
  }
  if (page !== undefined && (!source.pages || page > source.pages)) throw new TomokError("The selected page is outside this source version.", 400);

  // The caller supplies only cutoff-eligible evidence. Do not inspect later records to
  // explain a selected location or return raw workbook cells to the model.
  const evidenceIds = sheet && cell ? context.evidence.filter(row =>
    row.sourceId === source.sourceId && row.locator.sheet === sheet && Object.hasOwn(row.rawCells, cell) &&
    (row.activityCode === context.activityCode || row.facts.candidateActivityCode === context.activityCode),
  ).map(row => row._id).sort() : [];
  const coverage = selectedActivity?.code === context.activityCode ? "schedule-activity" : evidenceIds.length ? "curated-record" : "reference-only";
  const coverageNote = coverage === "schedule-activity"
    ? "The selected activity is the work package investigated here. Its dates and relationships describe the imported snapshot, not a new schedule calculation."
    : coverage === "curated-record"
      ? "This location belongs to a curated record available at the selected cutoff. Findings use that record's qualified excerpt; selection does not approve its interpretation or make the whole workbook evidence."
      : "This location is retained for inspection, but its content is not included in this investigation's curated evidence. Opening or selecting a file does not ingest it. The investigation remains about South Portal jet grouting.";
  const params = new URLSearchParams({ file: source.sourceId });
  if (activity) params.set("activity", activity);
  if (sheet) params.set("sheet", sheet);
  if (cell) params.set("cell", cell);
  if (page) params.set("page", String(page));
  const location = selectedActivity ? ` · ${selectedActivity.code}` : sheet ? ` · ${sheet}${cell ? `!${cell}` : ""}` : page ? ` · page ${page}` : "";
  return { ...selected, name: source.name, kind: source.kind, label: `${source.name}${location}`, href: `/files?${params}`, coverage, coverageNote, evidenceIds };
}
