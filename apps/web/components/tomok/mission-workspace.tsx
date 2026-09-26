"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, ClipboardList, LoaderCircle, Pause, Play, RefreshCw } from "lucide-react";
import { useChatShell } from "@/app/_components/chat-shell-context";
import type { MissionDetail, MissionState, MissionSummary } from "@/lib/tomok/missions/types";
import { MissionCoverage, type MissionUnitProgress } from "./mission-coverage";
import { MissionPolicies } from "./mission-policies";
import { MissionReport } from "./mission-report";
import { MissionError, MissionFrame, MissionPending, missionDate } from "./mission-shared";
import { useMissionAction, useMissionResource } from "./use-mission-resource";

type MissionListResponse = { missions: MissionSummary[]; hasMore: boolean };
type MissionResponse = { mission: MissionDetail; href?: string };
type MissionAction = "pause" | "resume" | "retry";

const initialGoal = "Reconstruct South Portal jet-grout progress for July 13–16, 2026. Connect daily observations to the SOE field plan and imported P6 activities, cite supporting records, and name unresolved questions.";
const statusLabels: Record<MissionState, string> = {
  queued: "Queued", running: "Running", paused: "Paused", completed: "Completed",
  completed_with_gaps: "Completed with gaps", failed: "Needs attention",
};
const needsUpdates = (value: MissionResponse) => value.mission.status === "running" || value.mission.status === "queued";
const listNeedsUpdates = (value: MissionListResponse) => value.missions.some(mission => mission.status === "running" || mission.status === "queued");

function StatusBadge({ status }: { status: MissionState }) {
  const tone = status === "running" || status === "queued" ? "active" : status === "completed" ? "complete" : "attention";
  return <span className="tmi-badge" data-tone={tone}>{status === "running" ? <LoaderCircle size={11} className="animate-spin" aria-hidden="true" /> : null}{statusLabels[status]}</span>;
}

export function MissionWorkspace() {
  const { viewer, requestSignIn } = useChatShell();
  const router = useRouter();
  const [goal, setGoal] = useState(initialGoal);
  const [navigationPending, setNavigationPending] = useState(false);
  const startRequest = useRef<{ owner: string; goal: string; id: string } | undefined>(undefined);
  const action = useMissionAction(viewer?.id ?? "");
  const history = useMissionResource<MissionListResponse>("/api/tomok/missions", viewer?.id ?? "", listNeedsUpdates);
  const trimmedGoal = goal.trim();
  const busy = action.busy || navigationPending;

  useEffect(() => { setNavigationPending(false); }, []);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!viewer) { requestSignIn(); return; }
    if (trimmedGoal.length < 10 || trimmedGoal.length > 2_000 || busy) return;
    if (startRequest.current?.goal !== trimmedGoal || startRequest.current.owner !== viewer.id) {
      startRequest.current = { owner: viewer.id, goal: trimmedGoal, id: crypto.randomUUID() };
    }
    const result = await action.run<MissionResponse>("/api/tomok/missions", {
      requestId: startRequest.current.id, goal: trimmedGoal,
      cutoff: "2026-07-16", preset: "south-portal-three-source",
    });
    if (result?.mission.id) {
      startRequest.current = undefined;
      setNavigationPending(true);
      router.push(`/missions/${encodeURIComponent(result.mission.id)}`);
    }
  }

  return (
    <MissionFrame>
      <div className="tk-title-row">
        <ClipboardList size={22} aria-hidden="true" />
        <div><p className="tk-eyebrow">ARCHIVE MISSIONS</p><h2>Build a source-backed project account</h2></div>
      </div>
      <p className="tk-lead">Give Tomok a bounded question. Follow the source ranges it processes, inspect the evidence it connects, and return to saved progress.</p>
      <form className="tmi-start" onSubmit={start}>
        <label htmlFor="mission-goal">Mission goal</label>
        <textarea id="mission-goal" value={goal} onChange={event => setGoal(event.target.value)} minLength={10} maxLength={2_000} rows={4} disabled={busy} required aria-describedby="mission-goal-help" />
        <div className="tmi-input-footer"><p id="mission-goal-help">Keep the question within the source scope below.</p><span>{goal.length}/2,000</span></div>
        <fieldset className="tmi-preset">
          <legend>Source scope</legend>
          <div className="tmi-preset-heading"><strong>South Portal · July 13–16, 2026</strong><span className="tmi-badge">Three-source preset</span></div>
          <ul>
            <li><strong>Imported P6 schedule</strong><span>South Portal activity and its direct schedule neighbors</span></li>
            <li><strong>SOE master workbook</strong><span>Four selected field-plan rows with their headers</span></li>
            <li><strong>Daily construction reports</strong><span>Four report rows through July 16 with their headers</span></li>
          </ul>
          <p className="tmi-caption">All eight registered files are inventoried. This preset assigns nine bounded ranges across these three sources; the remaining files stay unprocessed.</p>
        </fieldset>
        {action.error ? <MissionError message={action.error} /> : null}
        <div className="tmi-start-footer">
          <p>Findings and lessons remain unreviewed until a person assesses them.</p>
          <button type="submit" className="tk-button tk-primary" disabled={busy || trimmedGoal.length < 10 || trimmedGoal.length > 2_000}>
            {busy ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
            {busy ? "Starting mission…" : viewer ? "Start mission" : "Sign in to start"}
          </button>
        </div>
      </form>
      <section className="tmi-section" aria-labelledby="mission-history-heading">
        <div className="tmi-section-heading"><div><h3 id="mission-history-heading">Your missions</h3><p>Open a saved mission to follow its progress or inspect its report.</p></div><button className="tk-text-button" type="button" onClick={history.refresh} disabled={history.refreshing}>Refresh</button></div>
        {history.error ? <MissionError message={history.error} retry={history.refresh} /> : null}
        {!history.data && !history.error ? <MissionPending>Loading saved missions…</MissionPending> : history.data?.missions.length === 0 ? <p className="tmi-empty">Your first mission will appear here when you start it.</p> : history.data ? (
          <ul className="tmi-history">{history.data.missions.map(mission => (
            <li key={mission.id}>
              <div className="tmi-history-heading"><StatusBadge status={mission.status} /><time dateTime={mission.createdAt}>{missionDate(mission.createdAt)}</time></div>
              <Link href={mission.href} prefetch={false}><h4>{mission.goal}</h4><ArrowRight size={15} aria-hidden="true" /></Link>
              <p>{mission.completedJobs}/{mission.totalJobs} source jobs committed{mission.failedJobs ? ` · ${mission.failedJobs} unresolved failures` : ""} · through {mission.cutoff}</p>
              {mission.pauseReason ? <p>{mission.pauseReason}</p> : null}
            </li>
          ))}</ul>
        ) : null}
        {history.data?.hasMore ? <p className="tmi-caption">Showing your most recent missions. Earlier saved links remain available.</p> : null}
      </section>
    </MissionFrame>
  );
}

export function SavedMission({ id }: { id: string }) {
  const { viewer } = useChatShell();
  const resource = useMissionResource<MissionResponse>(`/api/tomok/missions/${encodeURIComponent(id)}`, viewer?.id ?? "", needsUpdates);
  return (
    <MissionFrame>
      <Link href="/missions" className="tk-back-link"><ArrowLeft size={13} aria-hidden="true" />All missions</Link>
      {resource.error ? <><MissionError message={resource.error} retry={resource.refresh} />{resource.data ? <p className="tmi-caption">Showing the last saved update. Connection will be retried while the mission is active.</p> : null}</> : null}
      {!resource.data && !resource.error ? <MissionPending>Loading archive mission…</MissionPending> : resource.data ? (
        <MissionDetailView key={`${viewer?.id ?? ""}:${id}`} mission={resource.data.mission} refresh={resource.refresh} refreshing={resource.refreshing} />
      ) : null}
    </MissionFrame>
  );
}

function MissionDetailView({ mission, refresh, refreshing }: { mission: MissionDetail; refresh: () => void; refreshing: boolean }) {
  const { viewer } = useChatShell();
  const action = useMissionAction(viewer?.id ?? "");
  const actionRequest = useRef<{ action: MissionAction; id: string } | undefined>(undefined);
  const currentJob = mission.status === "running" || mission.status === "queued" ? mission.jobs.find(job => job.status === "running") : undefined;
  const progress: MissionUnitProgress[] = mission.manifest.units.map(unit => {
    const job = mission.jobs.filter(job => job.unitId === unit.id).at(-1);
    const output = mission.outputs.filter(output => output.unitId === unit.id).sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1);
    if (output) return {
      unitId: unit.id, status: output.status === "outside-cutoff" ? "excluded" : "committed",
      detail: job && job.status !== "completed" ? `${job.status === "failed" ? "Reprocessing failed" : mission.status === "paused" ? "Reprocessing paused" : job.status === "running" ? "Reprocessing" : "Reprocessing pending"}; earlier committed evidence is preserved.` : undefined,
    };
    return {
      unitId: unit.id, status: !job || job.status === "completed" ? "pending" : job.status === "running" && mission.status === "paused" ? "pending" : job.status,
      detail: job?.status === "running" && mission.status === "paused" ? "Paused before committing" : job?.lastError,
    };
  });

  async function act(kind: MissionAction) {
    if (actionRequest.current?.action !== kind) actionRequest.current = { action: kind, id: crypto.randomUUID() };
    const result = await action.run<MissionResponse>(`/api/tomok/missions/${encodeURIComponent(mission.id)}/actions`, { action: kind, requestId: actionRequest.current.id });
    if (result) { actionRequest.current = undefined; refresh(); }
  }

  return (
    <>
      <div className="tmi-detail-heading"><div><p className="tk-eyebrow">ARCHIVE MISSION</p><h2>South Portal archive mission</h2></div><StatusBadge status={mission.status} /></div>
      <p className="tmi-mission-goal">{mission.goal}</p>
      <div className="tmi-mission-meta"><span>Started <time dateTime={mission.createdAt}>{missionDate(mission.createdAt)}</time></span><span>Reports through {mission.cutoff}</span></div>
      <div className="tmi-actions tmi-mission-controls">
        {mission.capabilities.canPause ? <button type="button" className="tk-button" disabled={action.busy} onClick={() => void act("pause")}><Pause size={13} aria-hidden="true" />Pause mission</button> : null}
        {mission.capabilities.canResume ? <button type="button" className="tk-button tk-primary" disabled={action.busy} onClick={() => void act("resume")}><Play size={13} aria-hidden="true" />Resume mission</button> : null}
        {mission.capabilities.canRetry ? <button type="button" className="tk-button" disabled={action.busy} onClick={() => void act("retry")}><RefreshCw size={13} aria-hidden="true" />Retry mission</button> : null}
        <button type="button" className="tk-text-button" disabled={refreshing || action.busy} onClick={refresh}>Refresh status</button>
        {action.busy ? <span className="tmi-caption" role="status">Saving action…</span> : null}
      </div>
      {action.error ? <MissionError message={action.error} /> : null}
      {mission.dispatch.error ? <MissionError message={mission.dispatch.error} /> : null}
      <section className="tmi-current" aria-labelledby="mission-current-heading">
        <div><h3 id="mission-current-heading">{currentJob ? "Current work" : mission.status === "paused" ? "Mission paused" : mission.status === "completed" || mission.status === "completed_with_gaps" ? "Processing settled" : mission.status === "failed" ? "Mission needs attention" : "Preparing work"}</h3>
          <p>{currentJob ? currentJob.unit.label : mission.pauseReason ?? (mission.status === "queued" ? "The mission is saved and waiting for the worker to begin." : mission.status === "running" ? "The worker is selecting eligible work or assembling the report." : mission.status === "failed" ? mission.dispatch.error ?? "Open the job history for the recorded failure, then retry when ready." : "Inspect the committed findings and remaining questions below.")}</p>
          {currentJob?.reason ? <p className="tmi-caption">{currentJob.reason}</p> : null}
        </div>
        <div className="tmi-current-count"><strong>{mission.completedJobs}<span>/{mission.totalJobs}</span></strong><span>jobs committed</span></div>
      </section>
      <p className="tmi-caption">Last saved update: <time dateTime={mission.updatedAt}>{missionDate(mission.updatedAt)}</time>{mission.lastCheckpoint ? ` · Checkpoint: ${mission.lastCheckpoint}` : ""}</p>
      <nav className="tmi-page-nav" aria-label="Mission sections"><a href="#mission-report">Report &amp; findings</a><a href="#mission-coverage-heading">Source coverage</a><a href="#mission-jobs">Job history</a><a href="#mission-policies">Processing policies</a></nav>
      <MissionReport mission={mission} />
      <MissionCoverage manifest={mission.manifest} progress={progress} />
      <section className="tmi-section" id="mission-jobs" aria-labelledby="mission-jobs-heading">
        <div className="tmi-section-heading"><div><h3 id="mission-jobs-heading">Job history</h3><p>Only committed results contribute to the report. Each attempt uses a pinned processing policy.</p></div></div>
        <details className="tmi-job-history"><summary>Inspect {mission.jobs.length} source jobs</summary><ol>{mission.jobs.map(job => (
          <li key={job.id}>
            <div className="tmi-job-heading"><Link href={job.unit.href} prefetch={false}>{job.unit.label}</Link><span className="tmi-badge">{job.status === "completed" ? "Committed" : job.status === "running" ? "Running" : job.status === "failed" ? "Failed" : "Pending"}</span></div>
            <p>Attempt {job.attempt} · Policy {job.policyVersion}</p>
            {job.reason ? <p>{job.reason}</p> : null}
            {job.lastError ? <p className="tmi-job-error">{job.lastError}</p> : null}
            {job.completedAt ? <p>Committed <time dateTime={job.completedAt}>{missionDate(job.completedAt)}</time></p> : null}
          </li>
        ))}</ol></details>
        <p className="tmi-caption">Mission budget: {mission.budget.attempts}/{mission.budget.maxAttempts} attempts · {mission.budget.toolCalls}/{mission.budget.maxToolCalls} tool calls{mission.budget.maxModelSteps !== undefined ? ` · ${mission.budget.modelSteps ?? 0}/${mission.budget.maxModelSteps} model steps` : ""}. Reaching a limit parks the mission with its saved progress.</p>
      </section>
      <MissionPolicies mission={mission} />
    </>
  );
}
