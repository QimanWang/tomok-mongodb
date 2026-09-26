"use client";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Search,
  X,
} from "lucide-react";
import type {
  Activity,
  DateBasis,
  ProjectFile,
  Schedule,
  Wbs,
} from "@/lib/project-files/types";
import {
  activityDates,
  dateNumber,
  statusLabel,
} from "@/lib/project-files/presentation";
import { Failure, Loading, updateLocation, useJson } from "./shared";
const DAY = 86_400_000,
  ROW = 32;
type Row = {
  id: string;
  depth: number;
  wbs?: Wbs;
  activity?: Activity;
  start: number | null;
  end: number | null;
};
const shortDate = (value: string) => (value ? value.slice(0, 10) : "—");
const numberText = (value: number | null) =>
  value === null
    ? "—"
    : value.toLocaleString(undefined, { maximumFractionDigits: 1 });
export default function ScheduleViewer({ file }: { file: ProjectFile }) {
  const { data, error, retry } = useJson<Schedule>(
    `/api/project-files/${file.id}/schedule`,
  );
  return error ? (
    <Failure message={error} retry={retry} />
  ) : !data ? (
    <Loading>Reading activities, WBS, and relationships…</Loading>
  ) : (
    <ScheduleWorkspace file={file} schedule={data} />
  );
}
function ScheduleWorkspace({
  file,
  schedule,
}: {
  file: ProjectFile;
  schedule: Schedule;
}) {
  const params = useSearchParams();
  const selectedId = params.get("activity");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [basis, setBasis] = useState<DateBasis>("schedule");
  const [zoom, setZoom] = useState("fit");
  const [expanded, setExpanded] = useState(
    () => new Set(schedule.wbs.map((wbs) => wbs.id)),
  );
  const [widths, setWidths] = useState([220, 320, 112, 112, 90, 110]);
  const [split, setSplit] = useState(57);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(500);
  const [chartWidth, setChartWidth] = useState(400);
  const gridRef = useRef<HTMLDivElement>(null),
    chartRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ index: number; start: number; width: number } | null>(
    null,
  );
  const selected = schedule.activities.find(
    (activity) => activity.id === selectedId,
  );
  const activityMap = useMemo(
    () =>
      new Map(schedule.activities.map((activity) => [activity.id, activity])),
    [schedule],
  );
  const wbsMap = useMemo(
    () => new Map(schedule.wbs.map((wbs) => [wbs.id, wbs])),
    [schedule],
  );
  const matching = useMemo(
    () =>
      schedule.activities.filter(
        (activity) =>
          (status === "all" ||
            (status === "float"
              ? activity.status !== "TK_Complete" &&
                activity.floatHours !== null &&
                activity.floatHours <= 0
              : activity.status === status)) &&
          `${activity.code} ${activity.name} ${wbsMap.get(activity.wbsId)?.name ?? ""}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
      ),
    [schedule, status, query, wbsMap],
  );
  const rows = useMemo(() => {
    const members = new Map<string, Activity[]>(),
      children = new Map<string, Wbs[]>(),
      retained = new Set<string>();
    for (const activity of matching) {
      const group = members.get(activity.wbsId) ?? [];
      group.push(activity);
      members.set(activity.wbsId, group);
      let node = wbsMap.get(activity.wbsId);
      const visited = new Set<string>();
      while (node && !visited.has(node.id)) {
        visited.add(node.id);
        retained.add(node.id);
        node = wbsMap.get(node.parentId);
      }
    }
    for (const wbs of schedule.wbs) {
      const siblings = children.get(wbs.parentId) ?? [];
      siblings.push(wbs);
      children.set(wbs.parentId, siblings);
    }
    children.forEach((siblings) => siblings.sort((a, b) => a.order - b.order));
    const result: Row[] = [],
      seen = new Set<string>();
    const visit = (
      wbs: Wbs,
      depth: number,
      visible: boolean,
    ): [number | null, number | null] => {
      if (seen.has(wbs.id) || !retained.has(wbs.id)) return [null, null];
      seen.add(wbs.id);
      const row: Row = { id: wbs.id, depth, wbs, start: null, end: null };
      if (visible) result.push(row);
      const showChildren = visible && (expanded.has(wbs.id) || Boolean(query));
      const starts: number[] = [],
        ends: number[] = [];
      for (const child of children.get(wbs.id) ?? []) {
        const [start, end] = visit(child, depth + 1, showChildren);
        if (start !== null) starts.push(start);
        if (end !== null) ends.push(end);
      }
      for (const activity of members.get(wbs.id) ?? []) {
        const [from, to] = activityDates(activity, basis);
        const start = dateNumber(from),
          end = dateNumber(to);
        if (start !== null) starts.push(start);
        if (end !== null) ends.push(end);
        if (showChildren)
          result.push({
            id: activity.id,
            activity,
            depth: depth + 1,
            start,
            end,
          });
      }
      row.start = starts.length ? Math.min(...starts) : null;
      row.end = ends.length ? Math.max(...ends) : null;
      return [row.start, row.end];
    };
    for (const root of schedule.wbs.filter((wbs) => !wbsMap.has(wbs.parentId)))
      visit(root, 0, true);
    for (const activity of matching.filter(
      (activity) => !wbsMap.has(activity.wbsId),
    )) {
      const [from, to] = activityDates(activity, basis);
      result.push({
        id: activity.id,
        activity,
        depth: 0,
        start: dateNumber(from),
        end: dateNumber(to),
      });
    }
    return result;
  }, [matching, schedule.wbs, wbsMap, expanded, query, basis]);
  const bounds = useMemo(() => {
    const values = matching
      .flatMap((activity) => activityDates(activity, basis).map(dateNumber))
      .filter((date): date is number => date !== null);
    const fallback = dateNumber(schedule.projects[0]?.dataDate) ?? 0;
    return {
      start: (values.length ? Math.min(...values) : fallback) - DAY * 14,
      end:
        (values.length ? Math.max(...values) : fallback + DAY * 30) + DAY * 30,
    };
  }, [matching, basis, schedule.projects]);
  const days = Math.max(1, (bounds.end - bounds.start) / DAY);
  const pixels =
    zoom === "day"
      ? 28
      : zoom === "week"
        ? 8
        : zoom === "month"
          ? 2.5
          : Math.max(0.08, (chartWidth - 32) / days);
  const timelineWidth = Math.max(chartWidth, days * pixels);
  const visibleRows = rows.slice(
    Math.max(0, Math.floor(scrollTop / ROW) - 8),
    Math.ceil((scrollTop + height) / ROW) + 8,
  );
  const firstRow = Math.max(0, Math.floor(scrollTop / ROW) - 8);
  const ticks = useMemo(() => {
    const ticks: { x: number; label: string }[] = [];
    const step =
      zoom === "day"
        ? 1
        : zoom === "week"
          ? 7
          : zoom === "month"
            ? 30
            : Math.max(30, Math.ceil(days / Math.max(1, chartWidth / 100)));
    for (let day = 0; day <= days; day += step)
      ticks.push({
        x: day * pixels,
        label: new Date(bounds.start + day * DAY).toLocaleDateString("en-US", {
          timeZone: "UTC",
          month: "short",
          day: zoom === "day" || zoom === "week" ? "numeric" : undefined,
          year: "2-digit",
        }),
      });
    return ticks;
  }, [zoom, days, chartWidth, pixels, bounds.start]);
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (gridRef.current) setHeight(gridRef.current.clientHeight);
      if (chartRef.current) setChartWidth(chartRef.current.clientWidth);
    });
    if (gridRef.current) observer.observe(gridRef.current);
    if (chartRef.current) observer.observe(chartRef.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!selectedId) return;
    const index = rows.findIndex((row) => row.activity?.id === selectedId);
    const grid = gridRef.current;
    if (
      index >= 0 &&
      grid &&
      (index * ROW < grid.scrollTop ||
        index * ROW > grid.scrollTop + grid.clientHeight - 90)
    ) {
      grid.scrollTop = Math.max(0, index * ROW - ROW * 2);
      if (chartRef.current) chartRef.current.scrollTop = grid.scrollTop;
    }
  }, [selectedId, rows]);
  useEffect(() => {
    if (!selected || !chartRef.current) return;
    const start = dateNumber(activityDates(selected, basis)[0]);
    if (start !== null)
      chartRef.current.scrollLeft = Math.max(
        0,
        ((start - bounds.start) / DAY) * pixels - 50,
      );
  }, [selected, basis, bounds.start, pixels]);
  function select(activity: Activity, reveal = false) {
    if (reveal) {
      setQuery("");
      setStatus("all");
    }
    setExpanded((previous) => {
      const next = new Set(previous);
      let wbs = wbsMap.get(activity.wbsId);
      const visited = new Set<string>();
      while (wbs && !visited.has(wbs.id)) {
        next.add(wbs.id);
        visited.add(wbs.id);
        wbs = wbsMap.get(wbs.parentId);
      }
      return next;
    });
    updateLocation({ file: file.id, activity: activity.id });
  }
  function syncScroll(source: HTMLDivElement, target: HTMLDivElement | null) {
    setScrollTop(source.scrollTop);
    if (target && target.scrollTop !== source.scrollTop)
      target.scrollTop = source.scrollTop;
  }
  const columns = widths.map((width) => `${width}px`).join(" ");
  const gridWidth = widths.reduce((sum, width) => sum + width, 0);
  return (
    <div className="pf-schedule">
      <div className="pf-schedule-summary">
        <strong>
          {schedule.activities.length.toLocaleString()} activities
        </strong>
        <span>
          {schedule.relationships.length.toLocaleString()} relationships
        </span>
        <span>{schedule.wbs.length} WBS nodes</span>
        <span>
          Data date <b>{shortDate(schedule.projects[0]?.dataDate)}</b>
        </span>
        <span>Export {schedule.exportDate}</span>
      </div>
      <div className="pf-toolbar">
        <label className="pf-search pf-activity-search">
          <Search size={15} />
          <input
            aria-label="Search activities"
            placeholder="Search activity ID or name…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              if (gridRef.current) gridRef.current.scrollTop = 0;
            }}
          />
          {query && (
            <button
              aria-label="Clear activity search"
              onClick={() => setQuery("")}
            >
              <X size={14} />
            </button>
          )}
        </label>
        <select
          aria-label="Activity filter"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="all">All activities</option>
          <option value="TK_NotStart">Not started</option>
          <option value="TK_Active">In progress</option>
          <option value="TK_Complete">Complete</option>
          <option value="float">Unfinished · float ≤ 0</option>
        </select>
        <label className="pf-control">
          Dates
          <select
            aria-label="Date basis"
            value={basis}
            onChange={(event) => setBasis(event.target.value as DateBasis)}
          >
            <option value="schedule">Schedule</option>
            <option value="planned">Planned</option>
            <option value="actual">Actual</option>
          </select>
        </label>
        <select
          aria-label="Timeline scale"
          value={zoom}
          onChange={(event) => setZoom(event.target.value)}
        >
          <option value="fit">Fit range</option>
          <option value="day">Day</option>
          <option value="week">Week</option>
          <option value="month">Month</option>
        </select>
        <button
          className="pf-icon-button"
          title="Expand all WBS"
          aria-label="Expand all WBS"
          onClick={() =>
            setExpanded(new Set(schedule.wbs.map((wbs) => wbs.id)))
          }
        >
          <ChevronsUpDown size={16} />
        </button>
        <button
          className="pf-icon-button"
          title="Collapse all WBS"
          aria-label="Collapse all WBS"
          onClick={() => setExpanded(new Set())}
        >
          <ChevronsDownUp size={16} />
        </button>
        <label className="pf-control pf-grid-width">
          Grid
          <input
            aria-label="Activity grid width"
            type="range"
            min="30"
            max="85"
            value={split}
            onChange={(event) => setSplit(Number(event.target.value))}
          />
        </label>
      </div>
      <div className="pf-schedule-note">
        {basis === "schedule"
          ? "Schedule dates: actual where recorded, otherwise remaining / early / planned."
          : basis === "planned"
            ? "Planned dates from this export. They are not a verified approved baseline."
            : "Actual dates only. An unfinished activity can have a start without a finish."}{" "}
        <span>Hours follow source values. No schedule recalculation.</span>
      </div>
      {schedule.warnings.length > 0 && (
        <details className="pf-warnings">
          <summary>{schedule.warnings.length} source warnings</summary>
          {schedule.warnings.map((warning, i) => (
            <p key={i}>{warning}</p>
          ))}
        </details>
      )}
      <div className="pf-schedule-panes">
        <div
          className="pf-activity-grid"
          ref={gridRef}
          style={{ width: `${split}%` }}
          onScroll={(event) =>
            syncScroll(event.currentTarget, chartRef.current)
          }
          aria-label="Activity table"
        >
          <div
            className="pf-grid-header"
            style={{ gridTemplateColumns: columns, width: gridWidth }}
            role="row"
          >
            {[
              "Activity ID / WBS",
              "Activity name",
              "Start",
              "Finish",
              "Float (h)",
              "Status",
            ].map((label, index) => (
              <div key={label} role="columnheader">
                {label}
                <span
                  role="separator"
                  aria-label={`Resize ${label} column`}
                  aria-orientation="vertical"
                  tabIndex={0}
                  aria-valuenow={widths[index]}
                  aria-valuemin={70}
                  aria-valuemax={650}
                  onKeyDown={(event) => {
                    if (
                      event.key === "ArrowLeft" ||
                      event.key === "ArrowRight"
                    ) {
                      event.preventDefault();
                      setWidths((previous) =>
                        previous.map((value, i) =>
                          i === index
                            ? Math.max(
                                70,
                                Math.min(
                                  650,
                                  value +
                                    (event.key === "ArrowRight" ? 20 : -20),
                                ),
                              )
                            : value,
                        ),
                      );
                    }
                  }}
                  onPointerDown={(event) => {
                    drag.current = {
                      index,
                      start: event.clientX,
                      width: widths[index],
                    };
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }}
                  onPointerMove={(event) => {
                    if (drag.current?.index === index) {
                      const next = Math.max(
                        70,
                        Math.min(
                          650,
                          drag.current.width +
                            event.clientX -
                            drag.current.start,
                        ),
                      );
                      setWidths((previous) =>
                        previous.map((value, i) =>
                          i === index ? next : value,
                        ),
                      );
                    }
                  }}
                  onPointerUp={() => {
                    drag.current = null;
                  }}
                  onPointerCancel={() => {
                    drag.current = null;
                  }}
                />
              </div>
            ))}
          </div>
          <div
            style={{
              height: rows.length * ROW,
              width: gridWidth,
              position: "relative",
            }}
          >
            {visibleRows.map((row, index) => (
              <div
                key={row.id}
                className={`pf-grid-row ${row.wbs ? "pf-wbs-row" : ""} ${row.activity?.id === selectedId ? "selected" : ""}`}
                style={{
                  top: (firstRow + index) * ROW,
                  gridTemplateColumns: columns,
                }}
              >
                <div>
                  <button
                    className="pf-row-button"
                    style={{ paddingLeft: Math.min(row.depth * 12, 72) + 8 }}
                    title={row.activity?.code ?? row.wbs?.code}
                    aria-expanded={
                      row.wbs
                        ? expanded.has(row.id) || Boolean(query)
                        : undefined
                    }
                    onClick={() => {
                      if (row.activity) select(row.activity);
                      else
                        setExpanded((previous) => {
                          const next = new Set(previous);
                          if (next.has(row.id)) next.delete(row.id);
                          else next.add(row.id);
                          return next;
                        });
                    }}
                  >
                    {row.wbs ? (
                      expanded.has(row.id) || query ? (
                        <ChevronDown size={12} />
                      ) : (
                        <ChevronRight size={12} />
                      )
                    ) : (
                      <span
                        className={`pf-status-dot ${row.activity?.status}`}
                      />
                    )}
                    <span>{row.activity?.code ?? row.wbs?.code}</span>
                  </button>
                </div>
                <div title={row.activity?.name ?? row.wbs?.name}>
                  {row.activity ? (
                    <button
                      className="pf-row-button"
                      onClick={() => select(row.activity!)}
                    >
                      {row.activity.name}
                    </button>
                  ) : (
                    row.wbs?.name
                  )}
                </div>
                <div>
                  {row.start === null
                    ? "—"
                    : new Date(row.start).toISOString().slice(0, 10)}
                </div>
                <div>
                  {row.end === null
                    ? "—"
                    : new Date(row.end).toISOString().slice(0, 10)}
                </div>
                <div
                  className={
                    row.activity?.floatHours !== null &&
                    row.activity?.floatHours !== undefined &&
                    row.activity.floatHours <= 0
                      ? "pf-low-float"
                      : ""
                  }
                >
                  {row.activity ? numberText(row.activity.floatHours) : ""}
                </div>
                <div>
                  {row.activity ? statusLabel(row.activity.status) : ""}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div
          className="pf-timeline"
          ref={chartRef}
          onScroll={(event) => syncScroll(event.currentTarget, gridRef.current)}
          aria-label="Schedule Gantt chart"
        >
          <div className="pf-timeline-header" style={{ width: timelineWidth }}>
            {ticks.map((tick) => (
              <span key={tick.x} style={{ left: tick.x }}>
                {tick.label}
              </span>
            ))}
          </div>
          <div
            style={{
              height: rows.length * ROW,
              width: timelineWidth,
              position: "relative",
            }}
          >
            {ticks.map((tick) => (
              <div
                key={tick.x}
                className="pf-tick-line"
                style={{ left: tick.x }}
              />
            ))}
            {visibleRows.map((row, index) => {
              const valid =
                row.start !== null && row.end !== null && row.end >= row.start;
              const left =
                row.start === null
                  ? 0
                  : ((row.start - bounds.start) / DAY) * pixels;
              const width = valid
                ? Math.max(4, ((row.end! - row.start!) / DAY) * pixels)
                : 0;
              const milestone =
                row.activity?.type === "TT_Mile" ||
                row.activity?.type === "TT_FinMile";
              return (
                <div
                  className={`pf-gantt-row ${row.activity?.id === selectedId ? "selected" : ""}`}
                  style={{ top: (firstRow + index) * ROW }}
                  key={row.id}
                >
                  {valid ? (
                    <button
                      tabIndex={-1}
                      title={`${row.activity?.code ?? row.wbs?.code}: ${row.activity?.name ?? row.wbs?.name}`}
                      aria-label={`Select ${row.activity?.code ?? row.wbs?.code}`}
                      className={`pf-gantt-bar ${row.wbs ? "summary" : row.activity?.status === "TK_Complete" ? "complete" : row.activity?.longestPath ? "longest" : ""} ${milestone ? "milestone" : ""}`}
                      style={{ left, width: milestone ? 10 : width }}
                      onClick={() => {
                        if (row.activity) select(row.activity);
                      }}
                    />
                  ) : row.start !== null ? (
                    <span
                      className="pf-open-start"
                      title="Start recorded; finish unavailable"
                      style={{ left }}
                    >
                      │
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
        {!matching.length && (
          <div className="pf-no-activities">
            No activities match.{" "}
            <button
              onClick={() => {
                setQuery("");
                setStatus("all");
              }}
            >
              Clear filters
            </button>
          </div>
        )}
      </div>
      <div className="pf-grid-footer">
        <span>
          {matching.length.toLocaleString()} activities in view ·{" "}
          {basis === "actual" ? "actual" : basis} dates
        </span>
        <span>
          <i className="pf-legend complete" />
          Complete <i className="pf-legend" />
          Scheduled <i className="pf-legend longest" />
          Source longest path
        </span>
      </div>
      {selected ? (
        <ActivityDetails
          key={selected.id}
          activity={selected}
          schedule={schedule}
          activityMap={activityMap}
          onSelect={(activity) => select(activity, true)}
          onClose={() => updateLocation({ activity: null })}
        />
      ) : (
        <div className="pf-detail-empty">
          {selectedId ? "Activity not found in this source version. " : ""}
          Select an activity to inspect its dates, calendar, and relationships.
        </div>
      )}
    </div>
  );
}
function ActivityDetails({
  activity,
  schedule,
  activityMap,
  onSelect,
  onClose,
}: {
  activity: Activity;
  schedule: Schedule;
  activityMap: Map<string, Activity>;
  onSelect: (activity: Activity) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState("general");
  const predecessors = schedule.relationships.filter(
      (link) => link.successor === activity.id,
    ),
    successors = schedule.relationships.filter(
      (link) => link.predecessor === activity.id,
    );
  return (
    <section className="pf-details" aria-label="Activity details">
      <div className="pf-details-heading">
        <div>
          <strong>{activity.code}</strong>
          <span>{activity.name}</span>
        </div>
        <button
          className="pf-icon-button"
          onClick={onClose}
          aria-label="Close activity details"
        >
          <X size={16} />
        </button>
      </div>
      <div
        className="pf-tabs"
        role="tablist"
        aria-label="Activity detail sections"
      >
        {[
          ["general", "General"],
          ["dates", "Dates"],
          [
            "relationships",
            `Relationships (${predecessors.length + successors.length})`,
          ],
        ].map(([key, label]) => (
          <button
            role="tab"
            aria-selected={tab === key}
            key={key}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
        <span>XER · TASK · line {activity.sourceLine}</span>
      </div>
      <div className="pf-detail-content" role="tabpanel">
        {tab === "general" ? (
          <dl className="pf-facts">
            {[
              ["Status", statusLabel(activity.status)],
              ["Activity type", activity.type],
              ["Calendar", activity.calendar],
              ["Original duration", `${numberText(activity.originalHours)} h`],
              [
                "Remaining duration",
                `${numberText(activity.remainingHours)} h`,
              ],
              ["Total float", `${numberText(activity.floatHours)} h`],
              [
                "Complete",
                activity.percent === null
                  ? "Not available"
                  : `${numberText(activity.percent)}%`,
              ],
              [
                "Percent basis",
                (
                  {
                    CP_Drtn: "Duration",
                    CP_Phys: "Physical",
                    CP_Units: "Units (not computed)",
                  } as Record<string, string>
                )[activity.percentType] ?? activity.percentType,
              ],
              ["Source longest path", activity.longestPath ? "Yes" : "No"],
              [
                "Constraints",
                activity.constraints.join(" · ") || "None recorded",
              ],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        ) : tab === "dates" ? (
          <>
            <p className="pf-note">
              Original P6 wall-clock values. Planned dates are not an
              approved-baseline comparison.
            </p>
            <dl className="pf-facts">
              {Object.entries(activity.dates)
                .filter(([, value]) => value)
                .map(([field, value]) => (
                  <div key={field}>
                    <dt>{field}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
            </dl>
          </>
        ) : (
          <div className="pf-relationships">
            {[
              ["Predecessors", predecessors],
              ["Successors", successors],
            ].map(([label, links]) => (
              <div key={String(label)}>
                <h3>{String(label)}</h3>
                <table>
                  <thead>
                    <tr>
                      <th>Activity</th>
                      <th>Type</th>
                      <th>Lag (h)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(links as typeof predecessors).map((link) => {
                      const otherId =
                        label === "Predecessors"
                          ? link.predecessor
                          : link.successor;
                      const other = activityMap.get(otherId);
                      return (
                        <tr key={link.id}>
                          <td>
                            {other ? (
                              <button
                                title={other.name}
                                onClick={() => onSelect(other)}
                              >
                                {other.code}
                                <small>{other.name}</small>
                              </button>
                            ) : (
                              `${otherId} (outside export)`
                            )}
                          </td>
                          <td>{link.type}</td>
                          <td>{numberText(link.lagHours)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {!(links as typeof predecessors).length && (
                  <p className="pf-note">None recorded.</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
