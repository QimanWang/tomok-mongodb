"use client";

import Link from "next/link";
import { ArrowUpRight, FileCheck2, TriangleAlert } from "lucide-react";
import type { ValidatedFact } from "@/lib/tomok/missions/source-units";
import type { MissionDetail, MissionConnection, MissionOutput } from "@/lib/tomok/missions/types";
import { missionDate } from "./mission-shared";

function factValue(fact: ValidatedFact) {
  if (fact.kind === "quantity") {
    const operation = fact.value.operation === "unclassified" ? "operation not classified" : fact.value.operation;
    return `${fact.value.completed}/${fact.value.total} ${fact.value.unit} · ${operation}`;
  }
  return String(fact.value);
}

function citationLabel(fact: ValidatedFact, mission: MissionDetail) {
  const source = mission.manifest.sources.find(source => source.id === fact.sourceId);
  return `${source?.title ?? "Source"} · ${fact.citation.locator}`;
}

function FactCitation({ fact, mission }: { fact: ValidatedFact; mission: MissionDetail }) {
  return <Link className="tmi-citation" href={fact.href} prefetch={false}>{citationLabel(fact, mission)}<ArrowUpRight size={11} aria-hidden="true" /></Link>;
}

function FactCard({ fact, mission, prefix = "fact" }: { fact: ValidatedFact; mission: MissionDetail; prefix?: string }) {
  return (
    <article className="tmi-fact" id={`${prefix}-${fact.id}`}>
      <div className="tmi-fact-heading"><h5>{fact.label}</h5>{fact.kind === "date" ? <span className="tmi-badge">{fact.dateSemantics === "unknown" ? "Date meaning unconfirmed" : `${fact.dateSemantics.charAt(0).toUpperCase()}${fact.dateSemantics.slice(1)} date`}</span> : null}</div>
      <p className="tmi-fact-value">{factValue(fact)}</p>
      <FactCitation fact={fact} mission={mission} />
      <details className="tmi-fact-evidence"><summary>Inspect exact excerpt</summary><blockquote>{fact.citation.quote}</blockquote><p>Value and citation checked against the saved source. Label and interpretation remain unreviewed.</p></details>
    </article>
  );
}

const relationLabels: Record<MissionConnection["relation"], string> = {
  "same-identifier": "Shared identifier", "candidate-mapping": "Candidate mapping",
  "progress-comparison": "Progress comparison", "possible-conflict": "Possible conflict",
};

export function MissionReport({ mission }: { mission: MissionDetail }) {
  const latestByUnit = new Map<string, MissionOutput>();
  for (const output of mission.outputs) {
    const previous = latestByUnit.get(output.unitId);
    if (!previous || output.createdAt >= previous.createdAt) latestByUnit.set(output.unitId, output);
  }
  const earlierOutputs = mission.outputs.filter(output => latestByUnit.get(output.unitId)?._id !== output._id);
  const facts = [...latestByUnit.values()].flatMap(output => output.facts);
  const factsById = new Map(mission.outputs.flatMap(output => output.facts).map(fact => [fact.id, fact]));
  const byDate = new Map<string, ValidatedFact[]>();
  for (const fact of facts) {
    const date = fact.kind === "date" && fact.dateSemantics !== "observed" ? "context" :
      fact.observedDate ?? (fact.kind === "date" && fact.dateSemantics === "observed" ? fact.value : "context");
    const group = byDate.get(date) ?? [];
    group.push(fact);
    byDate.set(date, group);
  }
  const groups = [...byDate.entries()].sort(([a], [b]) => a === "context" ? 1 : b === "context" ? -1 : a.localeCompare(b));
  const warnings = [...new Set([...(mission.report?.scopeNotes ?? []), ...mission.outputs.flatMap(output => output.warnings)])];
  const report = mission.report;
  const provenanceIssues = report?.questions.filter(question => question.startsWith("Provenance check at ")).length ?? 0;
  const scopedSources = new Set(mission.manifest.units.map(unit => unit.sourceId)).size;
  const inventoryOnly = mission.manifest.sources.filter(source => source.extraction === "inventory-only").length;

  return (
    <section className="tmi-section" id="mission-report" aria-labelledby="mission-report-heading">
      <div className="tmi-section-heading"><div><h3 id="mission-report-heading">Report &amp; findings</h3><p>{mission.manifest.units.length} bounded ranges in {scopedSources} source {scopedSources === 1 ? "file" : "files"} · {inventoryOnly} other registered {inventoryOnly === 1 ? "file remains" : "files remain"} inventory-only.</p><p>Value and citation checks verify source fidelity. The account, labels, and explanations remain unreviewed model interpretations.</p></div><span className="tmi-badge" data-tone="attention">Unreviewed</span></div>
      {provenanceIssues ? <aside className="tmi-provenance-notice" role="note"><TriangleAlert size={16} aria-hidden="true" /><p>{provenanceIssues} saved fact {provenanceIssues === 1 ? "label has" : "labels have"} source provenance issues. <a href="#mission-questions-heading">See Open questions.</a></p></aside> : null}
      {report ? <div className="tmi-report-summary"><p className="tk-eyebrow">DRAFT ACCOUNT</p><p>{report.summary}</p></div> : <div className="tmi-empty"><FileCheck2 size={18} aria-hidden="true" /><p>{facts.length ? "Committed findings are available below. The worker has not published a report yet." : "No findings have been committed yet. The mission will publish source-backed results as jobs finish."}</p></div>}
      {report?.connections.length ? (
        <section className="tmi-report-part" aria-labelledby="mission-connections-heading">
          <h4 id="mission-connections-heading">Connections to inspect</h4>
          <ul className="tmi-connections">{report.connections.map((connection, index) => {
            const left = factsById.get(connection.leftFactId);
            const right = factsById.get(connection.rightFactId);
            return <li key={`${connection.leftFactId}:${connection.rightFactId}:${index}`}>
              <div className="tmi-section-heading"><h5>{relationLabels[connection.relation]}</h5><span className="tmi-badge" data-tone={connection.status === "proposed" ? "attention" : undefined}>{connection.status === "proposed" ? "Proposed · needs review" : "Identifier documented"}</span></div>
              <p>{connection.reason}</p>
              <div className="tmi-connection-sources">{[left, right].map((fact, side) => fact ? <div key={`${fact.id}:${side}`}><strong>{fact.label}</strong><p>{factValue(fact)}</p><FactCitation fact={fact} mission={mission} /></div> : <p key={side} className="tmi-caption">The referenced finding is unavailable in this saved result.</p>)}</div>
            </li>;
          })}</ul>
        </section>
      ) : null}
      <section className="tmi-report-part" aria-labelledby="mission-chronology-heading">
        <h4 id="mission-chronology-heading">Chronology &amp; source evidence <span>{facts.length} {facts.length === 1 ? "finding" : "findings"}</span></h4>
        <p className="tmi-caption">Latest committed evidence for each range. Dated observations are grouped by their source date; planning dates, forecasts, and undated records are shown as source context.</p>
        {groups.length ? groups.map(([date, entries]) => (
          <details className="tmi-chronology-group" key={date} open={groups.length === 1}>
            <summary><span>{date === "context" ? "Planning & undated source context" : <time dateTime={date}>{date}</time>}</span><span>{entries.length} {entries.length === 1 ? "finding" : "findings"}</span></summary>
            <div>{entries.map(fact => <FactCard key={fact.id} fact={fact} mission={mission} />)}</div>
          </details>
        )) : <p className="tmi-caption">No committed source values yet.</p>}
        {earlierOutputs.length ? <details className="tmi-earlier-evidence"><summary>Earlier committed evidence ({earlierOutputs.length} {earlierOutputs.length === 1 ? "attempt" : "attempts"})</summary><p className="tmi-caption">Preserved evidence from before this range was reprocessed. The chronology above uses its latest committed output.</p>{earlierOutputs.map(output => {
          const unit = mission.manifest.units.find(unit => unit.id === output.unitId);
          const policy = mission.policies.find(policy => policy.id === output.policyVersion);
          return <details className="tmi-chronology-group" key={output._id}><summary><span>{unit?.label ?? "Source range"} · {policy ? `policy version ${policy.version}` : "earlier policy"}</span><span>{output.facts.length} findings</span></summary><p className="tmi-caption">Committed <time dateTime={output.createdAt}>{missionDate(output.createdAt)}</time></p><div>{output.facts.map(fact => <FactCard key={fact.id} fact={fact} mission={mission} prefix={`attempt-${output._id}`} />)}</div></details>;
        })}</details> : null}
      </section>
      {report ? (
        <div className="tmi-report-bottom">
          <section className="tmi-report-part" aria-labelledby="mission-questions-heading"><h4 id="mission-questions-heading">Open questions</h4>{report.questions.length ? <ul className="tmi-questions">{report.questions.map((question, index) => <li key={index}>{question}</li>)}</ul> : <p className="tmi-caption">The worker recorded no open questions. This does not establish that the archive is complete or the interpretations are accepted.</p>}</section>
          <section className="tmi-report-part" aria-labelledby="mission-lessons-heading"><h4 id="mission-lessons-heading">Draft lessons</h4>{report.lessons.length ? <ul className="tmi-lessons">{report.lessons.map((lesson, index) => <li key={index}><p>{lesson.text}</p><div>{lesson.factIds.map(id => { const fact = factsById.get(id); return fact ? <FactCitation key={id} fact={fact} mission={mission} /> : null; })}</div></li>)}</ul> : <p className="tmi-caption">No lessons were drafted from this mission.</p>}<p className="tmi-caption">These drafts have not been approved or added to reviewed project memory.</p></section>
        </div>
      ) : null}
      {warnings.length ? <details className="tmi-scope-notes"><summary>Source scope notes ({warnings.length})</summary><ul>{warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></details> : null}
    </section>
  );
}
