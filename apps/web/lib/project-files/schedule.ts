import { XER } from "xer-parser";
import type { Activity, Schedule } from "./types";

const number = (value: string | undefined): number | null =>
  value?.trim() && Number.isFinite(Number(value)) ? Number(value) : null;
const key = (project: string, id: string) => `${project}:${id}`;

export function parseSchedule(bytes: Uint8Array): Schedule {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("windows-1252").decode(bytes);
  }
  if (bytes[0] === 255 && bytes[1] === 254)
    text = new TextDecoder("utf-16le").decode(bytes);
  const xer = new XER(text);
  const issues = xer.validate();
  const errors = issues.filter((issue) => issue.severity === "error");
  if (errors.length) throw new Error(`Invalid XER: ${errors[0].message}`);
  const rows = (name: string): Record<string, string>[] => {
    const table = xer.tables.find((table) => table.name === name);
    return (
      table?.rows.map((row) =>
        Object.fromEntries(
          table.header.map((field, i) => [field, row[i] ?? ""]),
        ),
      ) ?? []
    );
  };
  const lines = new Map<string, number>();
  let table = "",
    fields: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const [marker, ...values] = line.split("\t");
    if (marker === "%T") table = values[0];
    if (marker === "%F") fields = values;
    if (marker === "%R" && table === "TASK")
      lines.set(
        key(
          values[fields.indexOf("proj_id")],
          values[fields.indexOf("task_id")],
        ),
        i + 1,
      );
  });
  const calendars = new Map(
    rows("CALENDAR").map((row) => [row.clndr_id, row.clndr_name]),
  );
  const activities = rows("TASK").map((row): Activity => {
    const original = number(row.target_drtn_hr_cnt),
      remaining = number(row.remain_drtn_hr_cnt);
    const percent =
      row.status_code === "TK_Complete"
        ? 100
        : row.complete_pct_type === "CP_Phys"
          ? number(row.phys_complete_pct)
          : row.complete_pct_type === "CP_Drtn" &&
              original &&
              remaining !== null
            ? ((original - remaining) / original) * 100
            : null;
    return {
      id: key(row.proj_id, row.task_id),
      projectId: row.proj_id,
      code: row.task_code,
      name: row.task_name,
      wbsId: key(row.proj_id, row.wbs_id),
      status: row.status_code,
      type: row.task_type,
      calendar: calendars.get(row.clndr_id) ?? row.clndr_id,
      floatHours: number(row.total_float_hr_cnt),
      originalHours: original,
      remainingHours: remaining,
      percent,
      percentType: row.complete_pct_type,
      longestPath: row.driving_path_flag === "Y",
      dates: Object.fromEntries(
        Object.entries(row).filter(([field]) => field.endsWith("_date")),
      ),
      constraints: [
        row.cstr_type && `${row.cstr_type}: ${row.cstr_date || "—"}`,
        row.cstr_type2 && `${row.cstr_type2}: ${row.cstr_date2 || "—"}`,
      ].filter(Boolean),
      sourceLine: lines.get(key(row.proj_id, row.task_id)) ?? 0,
    };
  });
  const ids = new Set(activities.map((activity) => activity.id));
  if (ids.size !== activities.length)
    throw new Error("Duplicate activity identity in XER.");
  const relationships = rows("TASKPRED").map((row) => ({
    id: row.task_pred_id,
    predecessor: key(row.pred_proj_id || row.proj_id, row.pred_task_id),
    successor: key(row.proj_id, row.task_id),
    type: row.pred_type.replace(/^PR_/, ""),
    lagHours: number(row.lag_hr_cnt),
  }));
  const unresolved = relationships.filter(
    (link) => !ids.has(link.predecessor) || !ids.has(link.successor),
  ).length;
  return {
    projects: rows("PROJECT").map((row) => ({
      id: row.proj_id,
      name: row.proj_short_name,
      dataDate: row.last_recalc_date,
      baselineId: row.sum_base_proj_id,
    })),
    exportDate: text.split(/\r?\n/)[0].split("\t")[2] ?? "",
    activities,
    relationships,
    calendarCount: calendars.size,
    wbs: rows("PROJWBS").map((row) => ({
      id: key(row.proj_id, row.wbs_id),
      parentId: key(row.proj_id, row.parent_wbs_id),
      code: row.wbs_short_name,
      name: row.wbs_name,
      order: number(row.seq_num) ?? 0,
    })),
    warnings: [
      ...issues
        .filter((issue) => issue.severity === "warn")
        .map((issue) => issue.message),
      ...(unresolved
        ? [
            `${unresolved} relationships reference activities outside this export.`,
          ]
        : []),
    ],
  };
}
