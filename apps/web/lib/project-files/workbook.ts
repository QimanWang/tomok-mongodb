import type { Cell, Worksheet } from "exceljs";
export function columnName(column: number): string {
  let name = "";
  while (column > 0) {
    column--;
    name = String.fromCharCode(65 + (column % 26)) + name;
    column = Math.floor(column / 26);
  }
  return name;
}
export function cellPosition(address: string) {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/i.exec(address.trim());
  if (!match) return null;
  const column = [...match[1].toUpperCase()].reduce(
    (value, char) => value * 26 + char.charCodeAt(0) - 64,
    0,
  );
  const row = Number(match[2]);
  return column <= 16384 && row <= 1048576 ? { column, row } : null;
}
export function populatedBounds(sheet: Worksheet) {
  let rows = 1,
    columns = 1;
  sheet.eachRow((row) =>
    row.eachCell((cell) => {
      if (cell.value !== null && cell.value !== undefined) {
        rows = Math.max(rows, Number(cell.row));
        columns = Math.max(columns, Number(cell.col));
      }
    }),
  );
  return { rows, columns };
}
export function cellDisplay(cell: Cell): string {
  if (cell.isMerged && cell.master.address !== cell.address) return "";
  let value = cell.value;
  if (value === null || value === undefined) return "";
  if (
    typeof value === "object" &&
    ("formula" in value || "sharedFormula" in value)
  )
    value = value.result ?? null;
  if (value === null || value === undefined) return "";
  if (value instanceof Date && !Number.isFinite(value.getTime()))
    return "[Invalid cached date]";
  if (value instanceof Date)
    return value
      .toISOString()
      .replace("T00:00:00.000Z", "")
      .replace(".000Z", "")
      .replace("T", " ");
  if (typeof value === "object" && "richText" in value)
    return value.richText.map((run) => run.text).join("");
  if (typeof value === "object" && "text" in value) return value.text;
  if (typeof value === "object" && "error" in value) return value.error;
  if (typeof value === "number" && cell.numFmt?.includes("%"))
    return `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
  return String(value);
}
export function cellFormula(cell: Cell) {
  const value = cell.value;
  if (
    typeof value !== "object" ||
    value === null ||
    !("formula" in value || "sharedFormula" in value)
  )
    return null;
  return (
    cell.formula ||
    ("sharedFormula" in value
      ? `Shared formula: ${value.sharedFormula}`
      : value.formula) ||
    null
  );
}
