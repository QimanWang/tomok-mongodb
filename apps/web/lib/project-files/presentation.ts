import type { Activity, DateBasis } from "./types";

// XER dates are wall-clock values with no timezone. UTC is used only for chart arithmetic.
export function dateNumber(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const result = Date.UTC(+year, +month - 1, +day);
  return new Date(result).toISOString().slice(0, 10) === match[0]
    ? result
    : null;
}
export function activityDates(
  activity: Activity,
  basis: DateBasis,
): [string, string] {
  const d = activity.dates;
  if (basis === "planned") return [d.target_start_date, d.target_end_date];
  if (basis === "actual") return [d.act_start_date, d.act_end_date];
  return [
    d.act_start_date ||
      d.restart_date ||
      d.early_start_date ||
      d.target_start_date,
    d.act_end_date || d.reend_date || d.early_end_date || d.target_end_date,
  ];
}
export function statusLabel(status: string) {
  return (
    (
      {
        TK_NotStart: "Not started",
        TK_Active: "In progress",
        TK_Complete: "Complete",
      } as Record<string, string>
    )[status] ?? status
  );
}
