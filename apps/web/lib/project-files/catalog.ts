import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import manifest from "./source-manifest.json";
import type { ProjectFile, Schedule } from "./types";
import { parseSchedule } from "./schedule";
import { projectSourceDirectory } from "./source-directory";

const titles: Record<string, string> = {
  xer: "P6 master schedule · R23",
  "SOE-Master-Schedule.xlsx": "SOE master schedule",
  "Daily-Construction-Report-july12-july17.xlsx": "Daily construction report",
  "FDTP - Program 6-Week Lookahead_KSTC_WE 2026.06.27.xlsx":
    "Six-week lookahead",
  "Schedule-Communication-Plan.docx": "Schedule communication plan",
  "Conformed_Set_of_Specs_Div_01__3.pdf": "Specifications · Division 01",
  "Conformed_Set_of_Specs_2-33.pdf": "Specifications · Divisions 02–33",
};
export const projectFiles: ProjectFile[] = manifest.files
  .map((file) => {
    const kind = path.extname(file.name).slice(1) as ProjectFile["kind"];
    return {
      id: file.sha256.slice(0, 16),
      name: file.name,
      title: titles[file.name] ?? titles[kind] ?? "Baseline narrative · draft",
      kind,
      bytes: file.bytes,
      sha256: file.sha256,
      ...("pages" in file ? { pages: file.pages } : {}),
    };
  })
  .sort(
    (a, b) =>
      ["xer", "xlsx", "pdf", "docx"].indexOf(a.kind) -
      ["xer", "xlsx", "pdf", "docx"].indexOf(b.kind),
  );
export class SourceError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
const verified = new Map<string, { stamp: string; bytes: Buffer }>();
const schedules = new Map<string, Schedule>();
export async function readSource(id: string) {
  const file = projectFiles.find((file) => file.id === id);
  if (!file) throw new SourceError("File not found.", 404);
  const filePath = path.join(projectSourceDirectory(), file.name);
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new SourceError("Source file is unavailable on this server.", 503);
  }
  const stamp = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  let cached = verified.get(id);
  if (cached?.stamp !== stamp) {
    const bytes = await readFile(filePath);
    if (
      bytes.length !== file.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== file.sha256
    ) {
      throw new SourceError(
        "Source has changed. Register its new version before viewing it.",
        409,
      );
    }
    cached = { stamp, bytes };
    verified.set(id, cached);
  }
  return { file, bytes: cached!.bytes };
}
export async function readSchedule(id: string) {
  const { file, bytes } = await readSource(id);
  if (file.kind !== "xer")
    throw new SourceError("This file is not an XER schedule.", 400);
  let schedule = schedules.get(file.sha256);
  if (!schedule) {
    schedule = parseSchedule(bytes);
    schedules.set(file.sha256, schedule);
  }
  return schedule;
}
