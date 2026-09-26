"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { SchedulePath } from "@/lib/tomok/schedule-path";
import type { SelectedSource } from "@/lib/tomok/source-selection";

export function SelectedSourceContext({ source }: { source: SelectedSource }) {
  return (
    <section className="tk-selected-source" aria-labelledby="selected-source-heading">
      <h3 id="selected-source-heading">Source attached to the question</h3>
      <Link href={source.href} prefetch={false}><ArrowUpRight size={13} aria-hidden="true" />{source.label}</Link>
      <p className="tk-source-version">Source version · SHA-256 <code>{source.sha256}</code></p>
      <p>{source.coverageNote}</p>
    </section>
  );
}

export function MilestoneContext({ context }: { context: SchedulePath }) {
  return (
    <section className="tk-milestone-context" aria-labelledby="milestone-context-heading">
      <p className="tk-eyebrow">SELECTED TARGET · IMPORTED DEPENDENCIES</p>
      <h3 id="milestone-context-heading"><Link href={context.target.href} prefetch={false}>{context.target.code} · {context.target.name}</Link></h3>
      <p className="tk-scope">Selected for this investigation. Project-team acceptance and a governing path have not been established.</p>
      <p>{context.status === "found"
        ? `${context.relationships.length} imported relationships connect ${context.source.code} to this target in the displayed path.`
        : context.status === "truncated"
          ? "No path was found within the bounded, incomplete graph. This does not establish that the work and milestone are independent."
          : "No directed successor path was found in this imported snapshot. This does not establish independence in the current project schedule."}</p>
      <p className="tk-scope">Inspected {context.coverage.inspectedNodes.toLocaleString("en-US")} activities and {context.coverage.inspectedRelationships.toLocaleString("en-US")} relationships{context.coverage.truncated ? " · coverage incomplete" : ""}. P6 data date {context.basis.dataDate || "not recorded"}; exported {context.basis.exportDate || "not recorded"}.</p>
      {context.nodes.length > 0 && (
        <details className="tk-dependency-details">
          <summary>Inspect the imported path, dates, calendars, and constraints</summary>
          <div className="tk-dependency-table" role="region" tabIndex={0} aria-label="Imported dependency path">
            <table>
              <caption>Shortest by relationship count in the inspected graph. This is not a driving path or CPM recalculation.</caption>
              <thead><tr><th scope="col">Activity</th><th scope="col">Link to next activity</th><th scope="col">Snapshot dates and flags</th><th scope="col">Calendar and constraints</th></tr></thead>
              <tbody>{context.nodes.map((node, index) => {
                const edge = context.relationships[index];
                return <tr key={node.id}>
                  <th scope="row"><Link href={node.href} prefetch={false}>{node.code}</Link><span>{node.name}</span></th>
                  <td>{edge ? <><Link href={edge.citation.href} prefetch={false}>{edge.type} · {edge.lagHours === null ? "lag not recorded" : `${edge.lagHours} h lag`}</Link><span>XER line {edge.sourceLine}</span></> : "Selected target"}</td>
                  <td><span>Planned {node.dates.target_start_date || "—"} → {node.dates.target_end_date || "—"}</span><span>Status {node.status}</span><span>Float {node.floatHours === null ? "not recorded" : `${node.floatHours} h`} · longest path {node.longestPath ? "Yes" : "No"}</span></td>
                  <td><span>{node.calendar || "Unnamed calendar"} · {node.calendarId}</span><span>{node.constraints.length ? node.constraints.join("; ") : "No exported constraint"}</span></td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        </details>
      )}
      <details className="tk-dependency-details"><summary>What this path can and cannot establish</summary><ul>{context.limitations.map(item => <li key={item}>{item}</li>)}</ul></details>
    </section>
  );
}
