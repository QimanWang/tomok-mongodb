import ExcelJS from "exceljs";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

const xml = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  removeNSPrefix: true,
});
const array = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

export async function loadWorkbook(bytes: ArrayBuffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  // ExcelJS coerces cached formula strings into Date objects when the cell has a date style.
  // Recover their original OOXML type; e.g. "21-Oct-26T" is a forecast marker, not a date.
  const zip = await JSZip.loadAsync(bytes);
  const [bookXml, relsXml] = await Promise.all([
    zip.file("xl/workbook.xml")?.async("string"),
    zip.file("xl/_rels/workbook.xml.rels")?.async("string"),
  ]);
  if (!bookXml || !relsXml) return workbook;
  const book = xml.parse(bookXml),
    rels = xml.parse(relsXml);
  const targets = new Map(
    array<Record<string, string>>(rels.Relationships?.Relationship).map(
      (rel) => [rel["@_Id"], rel["@_Target"]],
    ),
  );
  for (const source of array<Record<string, string>>(
    book.workbook?.sheets?.sheet,
  )) {
    const sheet = workbook.getWorksheet(source["@_name"]),
      target = targets.get(source["@_id"]);
    if (!sheet || !target) continue;
    const entry = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    const sheetXml = await zip.file(entry)?.async("string");
    if (!sheetXml) continue;
    const data = xml.parse(sheetXml);
    for (const row of array<{ c?: Record<string, unknown>[] }>(
      data.worksheet?.sheetData?.row,
    )) {
      for (const raw of array(row.c)) {
        if (
          raw["@_t"] !== "str" ||
          raw.f === undefined ||
          typeof raw["@_r"] !== "string"
        )
          continue;
        const cell = sheet.getCell(raw["@_r"]),
          value = cell.value;
        if (
          value &&
          typeof value === "object" &&
          ("formula" in value || "sharedFormula" in value)
        ) {
          cell.value = { ...value, result: String(raw.v ?? "") };
        }
      }
    }
  }
  return workbook;
}
