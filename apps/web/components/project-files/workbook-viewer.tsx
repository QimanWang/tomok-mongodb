"use client";
import type { Workbook, Worksheet } from "exceljs";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ProjectFile } from "@/lib/project-files/types";
import {
  cellDisplay,
  cellFormula,
  cellPosition,
  columnName,
  populatedBounds,
} from "@/lib/project-files/workbook";
import { checkedFetch, Failure, Loading, updateLocation } from "./shared";
const ROWS = 100,
  COLS = 30;
export default function WorkbookViewer({ file }: { file: ProjectFile }) {
  const [workbook, setWorkbook] = useState<Workbook>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      const [response, { loadWorkbook }] = await Promise.all([
        checkedFetch(
          `/api/project-files/${file.id}/content`,
          controller.signal,
        ),
        import("@/lib/project-files/load-workbook"),
      ]);
      const buffer = await response.arrayBuffer();
      const workbook = await loadWorkbook(buffer);
      if (!controller.signal.aborted) setWorkbook(workbook);
    }
    load().catch((error) => {
      if (!controller.signal.aborted) setError(error.message);
    });
    return () => controller.abort();
  }, [file.id]);
  return error ? (
    <Failure message={error} />
  ) : !workbook ? (
    <Loading>Reading workbook cells and cached formulas…</Loading>
  ) : (
    <WorkbookSheet file={file} workbook={workbook} />
  );
}
function WorkbookSheet({
  file,
  workbook,
}: {
  file: ProjectFile;
  workbook: Workbook;
}) {
  const params = useSearchParams();
  const requestedSheet = params.get("sheet");
  const sheet =
    workbook.worksheets.find((sheet) => sheet.name === requestedSheet) ??
    workbook.worksheets.find((sheet) => sheet.state === "visible") ??
    workbook.worksheets[0];
  if (!sheet) return <Failure message="This workbook has no worksheets." />;
  return (
    <div className="pf-workbook">
      <div className="pf-toolbar">
        <label className="pf-control">
          Worksheet
          <select
            aria-label="Worksheet"
            value={sheet.name}
            onChange={(event) =>
              updateLocation({
                file: file.id,
                sheet: event.target.value,
                cell: null,
              })
            }
          >
            {workbook.worksheets.map((sheet) => (
              <option key={sheet.id} value={sheet.name}>
                {sheet.name}
                {sheet.state !== "visible" ? " (hidden)" : ""}
              </option>
            ))}
          </select>
        </label>
        <span className="pf-muted">
          {workbook.worksheets.length} worksheets
        </span>
        {sheet.state !== "visible" && (
          <span className="pf-badge">Hidden in original</span>
        )}
        {requestedSheet && requestedSheet !== sheet.name && (
          <span className="pf-muted">
            Requested sheet not found; showing {sheet.name}.
          </span>
        )}
      </div>
      <SheetGrid key={sheet.id} sheet={sheet} file={file} />
    </div>
  );
}
function SheetGrid({ sheet, file }: { sheet: Worksheet; file: ProjectFile }) {
  const params = useSearchParams();
  const address = params.get("cell")?.toUpperCase() ?? "A1";
  const position = cellPosition(address) ?? { row: 1, column: 1 };
  const [rowPage, setRowPage] = useState(Math.floor((position.row - 1) / ROWS));
  const [colPage, setColPage] = useState(
    Math.floor((position.column - 1) / COLS),
  );
  const [jump, setJump] = useState(address);
  const [jumpError, setJumpError] = useState("");
  const gridRef = useRef<HTMLDivElement>(null);
  const bounds = useMemo(() => populatedBounds(sheet), [sheet]);
  const firstRow =
    Math.min(rowPage, Math.floor((bounds.rows - 1) / ROWS)) * ROWS + 1;
  const firstCol =
    Math.min(colPage, Math.floor((bounds.columns - 1) / COLS)) * COLS + 1;
  const rowCount = Math.min(ROWS, bounds.rows - firstRow + 1),
    colCount = Math.min(COLS, bounds.columns - firstCol + 1);
  const cell = sheet.getCell(position.row, position.column);
  const formula = cellFormula(cell);
  useEffect(() => {
    const current = cellPosition(address);
    if (
      current &&
      current.row <= bounds.rows &&
      current.column <= bounds.columns
    ) {
      setRowPage(Math.floor((current.row - 1) / ROWS));
      setColPage(Math.floor((current.column - 1) / COLS));
      setJump(address);
      requestAnimationFrame(() =>
        gridRef.current
          ?.querySelector('[aria-selected="true"]')
          ?.scrollIntoView({ block: "nearest", inline: "nearest" }),
      );
    }
  }, [address, bounds]);
  function choose(row: number, col: number) {
    updateLocation({
      file: file.id,
      sheet: sheet.name,
      cell: `${columnName(col)}${row}`,
    });
  }
  return (
    <>
      <div className="pf-cell-toolbar">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const target = cellPosition(jump);
            if (
              !target ||
              target.row > bounds.rows ||
              target.column > bounds.columns
            ) {
              setJumpError(
                `Choose a cell within A1:${columnName(bounds.columns)}${bounds.rows}.`,
              );
              return;
            }
            setJumpError("");
            choose(target.row, target.column);
          }}
        >
          <input
            aria-label="Go to cell"
            value={jump}
            onChange={(event) => setJump(event.target.value.toUpperCase())}
          />
          <button className="pf-button" type="submit">
            Go
          </button>
        </form>
        <div className="pf-formula">
          <span>{formula ? "ƒx" : "Value"}</span>
          <code title={formula ?? cellDisplay(cell)}>
            {formula ? `=${formula}` : cellDisplay(cell) || "Empty cell"}
          </code>
        </div>
      </div>
      {jumpError && (
        <p className="pf-inline-error" role="alert">
          {jumpError}
        </p>
      )}
      <div className="pf-sheet-grid" ref={gridRef}>
        <table aria-label={`${sheet.name} cells`}>
          <thead>
            <tr>
              <th aria-label="Row number" />
              {Array.from({ length: colCount }, (_, i) => (
                <th key={i}>{columnName(firstCol + i)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rowCount }, (_, r) => (
              <tr key={r}>
                <th>{firstRow + r}</th>
                {Array.from({ length: colCount }, (_, c) => {
                  const cell = sheet.getCell(firstRow + r, firstCol + c);
                  const text = cellDisplay(cell);
                  const selected = cell.address === address;
                  const fill =
                    cell.fill?.type === "pattern"
                      ? cell.fill.fgColor?.argb
                      : undefined;
                  const color = cell.font?.color?.argb;
                  return (
                    <td
                      key={c}
                      aria-selected={selected}
                      style={{
                        background:
                          fill && /^[A-Fa-f0-9]{8}$/.test(fill)
                            ? `#${fill.slice(2)}`
                            : undefined,
                        color:
                          color && /^[A-Fa-f0-9]{8}$/.test(color)
                            ? `#${color.slice(2)}`
                            : undefined,
                        fontWeight: cell.font?.bold ? 600 : undefined,
                      }}
                    >
                      <button
                        title={`${cell.address}: ${text}${cellFormula(cell) ? " (cached formula result)" : ""}${cell.isMerged ? ` · merged from ${cell.master.address}` : ""}`}
                        onClick={() => choose(firstRow + r, firstCol + c)}
                      >
                        {text || "\u00a0"}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pf-sheet-footer">
        <div>
          <button
            className="pf-icon-button"
            aria-label="Previous rows"
            disabled={firstRow === 1}
            onClick={() => {
              setRowPage((page) => page - 1);
              if (gridRef.current) gridRef.current.scrollTop = 0;
            }}
          >
            <ChevronLeft size={15} />
          </button>
          <span>
            Rows {firstRow}–{firstRow + rowCount - 1} / {bounds.rows}
          </span>
          <button
            className="pf-icon-button"
            aria-label="Next rows"
            disabled={firstRow + rowCount > bounds.rows}
            onClick={() => {
              setRowPage((page) => page + 1);
              if (gridRef.current) gridRef.current.scrollTop = 0;
            }}
          >
            <ChevronRight size={15} />
          </button>
        </div>
        <div>
          <button
            className="pf-icon-button"
            aria-label="Previous columns"
            disabled={firstCol === 1}
            onClick={() => {
              setColPage((page) => page - 1);
              if (gridRef.current) gridRef.current.scrollLeft = 0;
            }}
          >
            <ChevronLeft size={15} />
          </button>
          <span>
            Columns {columnName(firstCol)}–{columnName(firstCol + colCount - 1)}{" "}
            / {columnName(bounds.columns)}
          </span>
          <button
            className="pf-icon-button"
            aria-label="Next columns"
            disabled={firstCol + colCount > bounds.columns}
            onClick={() => {
              setColPage((page) => page + 1);
              if (gridRef.current) gridRef.current.scrollLeft = 0;
            }}
          >
            <ChevronRight size={15} />
          </button>
        </div>
      </div>
      <div className="pf-cell-inspector">
        <strong>
          {sheet.name}!{address}
        </strong>
        <span>
          {formula
            ? `Cached result: ${cellDisplay(cell) || "not stored"}. Formulas are not recalculated.`
            : cellDisplay(cell) || "Empty cell"}
        </span>
        <small>
          Cell data preview · merged content appears in its top-left cell ·
          dates use source values
        </small>
      </div>
    </>
  );
}
