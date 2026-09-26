"use client";

import type { MissionDetail } from "@/lib/tomok/missions/types";
import { missionDate } from "./mission-shared";

export function MissionPolicies({ mission }: { mission: MissionDetail }) {
  return (
    <section className="tmi-section" id="mission-policies" aria-labelledby="mission-policies-heading">
      <div className="tmi-section-heading"><div><h3 id="mission-policies-heading">Processing policies</h3><p>Policy versions and measured comparisons are saved with this mission. Changes apply at job boundaries.</p></div></div>
      <details className="tmi-policy-history">
        <summary>Inspect {mission.policies.length} {mission.policies.length === 1 ? "version" : "versions"} and {mission.policyEvaluations.length} {mission.policyEvaluations.length === 1 ? "evaluation" : "evaluations"}</summary>
        <ul className="tmi-policies">{mission.policies.map(policy => (
          <li key={policy.id}>
            <div className="tmi-section-heading"><h4>Version {policy.version} · {policy.label}</h4><span className="tmi-badge" data-tone={policy.id === mission.activePolicyId ? "active" : undefined}>{policy.id === mission.activePolicyId ? "Active policy" : "Saved version"}</span></div>
            <dl><div><dt>Row window</dt><dd>{policy.rowWindow}</dd></div><div><dt>Header rows</dt><dd>{policy.headerRows}</dd></div><div><dt>Empty cells</dt><dd>{policy.omitEmptyCells ? "Omitted" : "Included"}</dd></div><div><dt>Formula inspection</dt><dd>{policy.inspectFormulas ? "Included" : "Not included"}</dd></div></dl>
            <p className="tmi-caption">Saved <time dateTime={policy.createdAt}>{missionDate(policy.createdAt)}</time></p>
          </li>
        ))}</ul>
        {mission.policyEvaluations.length ? (
          <ul className="tmi-evaluations">{mission.policyEvaluations.map(evaluation => {
            const candidate = mission.policies.find(policy => policy.id === evaluation.candidateId);
            const baseline = mission.policies.find(policy => policy.id === evaluation.baselineId);
            return (
              <li key={evaluation.id}>
                <div className="tmi-section-heading"><h4>{candidate ? `Version ${candidate.version}` : "Candidate"} compared with {baseline ? `version ${baseline.version}` : "baseline"}</h4><span className="tmi-badge" data-tone={evaluation.decision === "promoted" ? "complete" : "attention"}>{evaluation.decision === "promoted" ? "Promoted" : "Rejected"}</span></div>
                <div className="tmi-table-scroll"><table><caption>Measured processing comparison</caption><thead><tr><th scope="col">Metric</th><th scope="col">Baseline</th><th scope="col">Candidate</th></tr></thead><tbody><tr><th scope="row">Cells</th><td>{evaluation.baselineCells.toLocaleString()}</td><td>{evaluation.candidateCells.toLocaleString()}</td></tr><tr><th scope="row">Bytes</th><td>{evaluation.baselineBytes.toLocaleString()}</td><td>{evaluation.candidateBytes.toLocaleString()}</td></tr></tbody></table></div>
                <p className="tmi-caption">Required source records preserved: {evaluation.requiredFactsPreserved ? "Yes" : "No"} · Dataset: {evaluation.dataset}</p>
                <ul className="tmi-evaluation-reasons">{evaluation.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
                <p className="tmi-caption">{evaluation.scopeNote}</p>
                <p className="tmi-caption">Evaluated <time dateTime={evaluation.evaluatedAt}>{missionDate(evaluation.evaluatedAt)}</time></p>
              </li>
            );
          })}</ul>
        ) : <p className="tmi-empty">No processing-policy comparison has been completed. No improvement is claimed.</p>}
      </details>
    </section>
  );
}
