"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  ClipboardCheck,
  Files,
  LoaderCircle,
  Play,
  Search,
  TriangleAlert,
} from "lucide-react";
import { useChatShell } from "@/app/_components/chat-shell-context";
import type { Investigation } from "@/lib/tomok/service";
import { useProjectJson } from "./use-project-json";
import { ReviewedMemoryNotes } from "./memory-notes";
import { milestoneOptions, type TargetMilestoneCode } from "@/lib/tomok/investigation-options";
import type { SelectedSourceInput } from "@/lib/tomok/source-selection";
import { MilestoneContext, SelectedSourceContext } from "./investigation-context";
import "./investigation.css";

type EvidenceStatus = {
  configured: boolean;
  imported: boolean;
  storage: "atlas" | "mongodb" | null;
  counts?: {
    activities: number;
    relationships: number;
    wbs: number;
    calendars: number;
    evidence: number;
    sources: number;
  };
  semanticSearch?: { status: string; queryable: boolean; model?: string; dimensions?: number };
  error?: string;
};

const reportDates = ["2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16"];

function dateLabel(value: string | null) {
  if (!value) return "Not recorded";
  const date = new Date(value.length === 10 ? `${value}T12:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <section
      className="tk-investigation"
      aria-label="Tomok project investigation"
    >
      <header className="tk-project-header">
        <span className="tk-project-mark" aria-hidden="true">
          T
        </span>
        <div>
          <p className="tk-eyebrow">TOMOK / PROJECT CONTROLS</p>
          <h1>Frederick Douglass Tunnel</h1>
        </div>
        <nav className="tm-header-nav" aria-label="Project navigation">
          <Link href="/memory" className="tk-button">
            <BookOpen size={14} aria-hidden="true" />
            Project memory
          </Link>
          <Link href="/files" className="tk-button">
            <Files size={14} aria-hidden="true" />
            Files
          </Link>
        </nav>
      </header>
      <div className="tk-investigation-body">{children}</div>
    </section>
  );
}

function Pending({ children }: { children: ReactNode }) {
  return (
    <p className="tk-status" role="status">
      <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
      {children}
    </p>
  );
}

function ErrorState({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  const { viewer, requestSignIn } = useChatShell();
  return (
    <div className="tk-error" role="alert">
      <TriangleAlert size={18} aria-hidden="true" />
      <div>
        <p>{message}</p>
        <div className="tk-error-actions">
          {retry && (
            <button className="tk-button" onClick={retry}>
              Try again
            </button>
          )}
          {!viewer && (
            <button className="tk-button" onClick={() => requestSignIn()}>
              Sign in
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function InvestigationWorkspace() {
  const params = useSearchParams();
  const source = params.get("source");
  const selectedSource: SelectedSourceInput | undefined = source ? {
    sourceId: source, sha256: params.get("sha256") ?? "",
    ...(params.has("activity") ? { activity: params.get("activity")! } : {}),
    ...(params.has("sheet") ? { sheet: params.get("sheet")! } : {}),
    ...(params.has("cell") ? { cell: params.get("cell")! } : {}),
    ...(params.has("page") ? { page: Number(params.get("page")) } : {}),
  } : undefined;
  // Recreate the form when navigation supplies a different reporting cutoff.
  return (
    <InvestigationForm
      key={params.toString()}
      initialCutoff={params.get("cutoff") ?? "2026-07-16"}
      initialSource={selectedSource}
      sourceName={params.get("sourceName")}
    />
  );
}

function InvestigationForm({
  initialCutoff,
  initialSource,
  sourceName,
}: {
  initialCutoff: string;
  initialSource?: SelectedSourceInput;
  sourceName: string | null;
}) {
  const router = useRouter();
  const { viewer } = useChatShell();
  const {
    data: status,
    error: statusError,
    retry,
  } = useProjectJson<EvidenceStatus>("/api/tomok/status", viewer?.id ?? "");
  const [cutoff, setCutoff] = useState(initialCutoff);
  const [selectedSource, setSelectedSource] = useState(initialSource);
  const [targetMilestoneCode, setTargetMilestoneCode] = useState<TargetMilestoneCode | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    request.current?.abort();
    request.current = null;
    setBusy(false);
    return () => {
      const pending = request.current;
      request.current = null;
      pending?.abort();
    };
  }, []);
  const validDate = reportDates.includes(cutoff);
  const question = `As of ${dateLabel(cutoff)}, how is South Portal jet grouting progressing against the field plan and P6? What needs attention?${targetMilestoneCode ? ` Inspect the imported dependencies toward ${targetMilestoneCode}; do not recalculate milestone dates.` : ""}`;
  const sourceParams = new URLSearchParams();
  if (selectedSource) {
    sourceParams.set("file", selectedSource.sourceId);
    for (const key of ["activity", "sheet", "cell", "page"] as const) {
      if (selectedSource[key] !== undefined) sourceParams.set(key, String(selectedSource[key]));
    }
  }
  const sourceVersionMissing = Boolean(selectedSource && !/^[a-f0-9]{64}$/.test(selectedSource.sha256));

  async function investigate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.current || !status?.imported || !validDate || sourceVersionMissing) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/tomok/investigations", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cutoff, question, ...(selectedSource ? { selectedSource } : {}), ...(targetMilestoneCode ? { targetMilestoneCode } : {}) }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(body?.error ?? "Unable to save this investigation.");
      if (!body?.investigation?.id)
        throw new Error(
          "The investigation was not returned. Please try again.",
        );
      if (controller.signal.aborted || request.current !== controller) return;
      router.push(
        `/investigations/${encodeURIComponent(body.investigation.id)}`,
      );
    } catch (cause) {
      if (controller.signal.aborted || request.current !== controller) return;
      request.current = null;
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to complete this investigation.",
      );
      setBusy(false);
    }
  }

  return (
    <Frame>
      <div className="tk-content">
        {selectedSource && (
          <Link
            className="tk-back-link"
            href={`/files?${sourceParams.toString()}`}
          >
            <ArrowLeft size={13} aria-hidden="true" />
            Return to source
          </Link>
        )}
        <div className="tk-title-row">
          <Search size={21} aria-hidden="true" />
          <div>
            <p className="tk-eyebrow">PROJECT INVESTIGATION</p>
            <h2>South Portal jet grouting</h2>
          </div>
        </div>
        <p className="tk-lead">
          Compare recorded field progress with the field plan and the imported
          P6 schedule. Open the sources behind each finding.
        </p>
        <Link href="/replays" className="tk-button mb-5">
          <Play size={14} aria-hidden="true" />
          Open the staged case replay
        </Link>
        <form
          className="tk-investigation-form"
          onSubmit={investigate}
          aria-busy={busy}
        >
          <div className="tk-date-control">
            <label htmlFor="investigation-cutoff">Evidence through</label>
            <select
              id="investigation-cutoff"
              value={cutoff}
              onChange={(event) => {
                setCutoff(event.target.value);
                setError(undefined);
              }}
              disabled={busy}
              aria-invalid={!validDate}
              aria-describedby={!validDate ? "invalid-cutoff" : "cutoff-note"}
            >
              {!validDate && (
                <option value={cutoff}>Choose a report date</option>
              )}
              {reportDates.map((date) => (
                <option key={date} value={date}>
                  {dateLabel(date)}
                </option>
              ))}
            </select>
            <p id="cutoff-note">Filter dated daily observations.</p>
          </div>
          {!validDate && (
            <p id="invalid-cutoff" className="tk-validation" role="alert">
              Choose an available report date from July 13–16, 2026.
            </p>
          )}
          <div className="tk-date-control tk-milestone-control">
            <label htmlFor="investigation-milestone">Target milestone</label>
            <select id="investigation-milestone" value={targetMilestoneCode} disabled={busy}
              aria-describedby="milestone-note" onChange={event => setTargetMilestoneCode(event.target.value as TargetMilestoneCode | "")}>
              <option value="">Not selected</option>
              {milestoneOptions.map(item => <option key={item.code} value={item.code}>{item.label}</option>)}
            </select>
            <p id="milestone-note">Optional dependency context. Selection does not establish acceptance or a driving path.</p>
          </div>
          {selectedSource && <div className="tk-selected-source tk-form-source">
            <h3>Source attached to this question</h3>
            <Link href={`/files?${sourceParams}`} prefetch={false}>{sourceName || selectedSource.sourceId}{selectedSource.activity ? ` · activity ${selectedSource.activity}` : selectedSource.sheet ? ` · ${selectedSource.sheet}${selectedSource.cell ? `!${selectedSource.cell}` : ""}` : selectedSource.page ? ` · page ${selectedSource.page}` : ""}</Link>
            <p className="tk-source-version">Version {selectedSource.sha256.slice(0, 12) || "missing"}</p>
            <p>The exact location will be saved. Only imported, eligible evidence supports findings; a selection does not ingest or approve the source.</p>
            {sourceVersionMissing && <p className="tk-validation" role="alert">Open the source and select “Investigate with this source” again to attach its version.</p>}
            <button type="button" className="tk-text-button" disabled={busy} onClick={() => setSelectedSource(undefined)}>Remove source context</button>
          </div>}
          <div className="tk-question">
            <span className="tk-eyebrow">QUESTION</span>
            <p>
              {validDate
                ? question
                : "How is South Portal jet grouting progressing against the field plan and P6? What needs attention?"}
            </p>
          </div>
          <p className="tk-scope">
            This investigation covers South Portal jet grouting. Undated plans
            remain context. Findings distinguish source records, assessments,
            and items that need confirmation.
          </p>
          <div className="tk-form-footer">
            <button
              className="tk-button tk-primary"
              type="submit"
              disabled={busy || !validDate || !status?.imported || sourceVersionMissing}
            >
              {busy ? (
                <LoaderCircle
                  size={15}
                  className="animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <Search size={15} aria-hidden="true" />
              )}
              {busy ? "Investigating…" : "Investigate"}
            </button>
            <span>Saved with its evidence and report date.</span>
          </div>
        </form>
        {error && <ErrorState message={error} />}
        {statusError ? (
          <ErrorState message={statusError} retry={retry} />
        ) : !status ? (
          <Pending>Checking project evidence…</Pending>
        ) : !status.imported ? (
          <div className="tk-evidence-state">
            <Files size={18} aria-hidden="true" />
            <div>
              <h3>Project evidence is not available yet</h3>
              <p>
                An administrator needs to connect and import the project data
                before you can investigate.
              </p>
              <button className="tk-text-button" onClick={retry}>
                Check again
              </button>
            </div>
          </div>
        ) : (
          <div className="tk-evidence-state">
            <ClipboardCheck size={18} aria-hidden="true" />
            <div>
              <h3>Project evidence ready</h3>
              {status.counts && (
                <p>
                  {status.counts.activities.toLocaleString("en-US")} schedule
                  activities · {status.counts.evidence.toLocaleString("en-US")}{" "}
                  evidence records ·{" "}
                  {status.counts.sources.toLocaleString("en-US")} sources
                </p>
              )}
              {status.semanticSearch && <p className="tk-scope">
                {status.semanticSearch.queryable ? "Semantic source search ready."
                  : ["BUILDING", "PENDING", "INITIAL_SYNC"].includes(status.semanticSearch.status) ? "Semantic search is indexing; exact source retrieval remains available."
                    : "Semantic search is unavailable; exact source retrieval remains available."}
              </p>}
            </div>
          </div>
        )}
      </div>
    </Frame>
  );
}

const findingGroups = [
  {
    kind: "documented",
    title: "Documented in the sources",
    description: "Facts reported in the imported records.",
  },
  {
    kind: "inferred",
    title: "Assessment",
    description: "Comparisons and interpretations of the available evidence.",
  },
  {
    kind: "unresolved",
    title: "Needs confirmation",
    description: "Questions the available records do not settle.",
  },
] as const;

export function SavedInvestigation({ id }: { id: string }) {
  const { viewer } = useChatShell();
  const { data, error, retry } = useProjectJson<{
    investigation: Investigation;
  }>(`/api/tomok/investigations/${encodeURIComponent(id)}`, viewer?.id ?? "");
  const result = data?.investigation;
  return (
    <Frame>
      <div className="tk-content tk-result">
        <Link href="/investigations" className="tk-back-link">
          <ArrowLeft size={13} aria-hidden="true" />
          New investigation
        </Link>
        {error ? (
          <ErrorState message={error} retry={retry} />
        ) : !result ? (
          <Pending>Opening saved investigation…</Pending>
        ) : (
          <>
            <div className="tk-title-row">
              <ClipboardCheck size={22} aria-hidden="true" />
              <div>
                <p className="tk-eyebrow">SAVED INVESTIGATION</p>
                <h2>{result.title}</h2>
              </div>
            </div>
            <p className="tk-result-question">{result.question}</p>
            <div className="tk-result-meta">
              <span>
                Evidence through <strong>{dateLabel(result.cutoff)}</strong>
              </span>
              <span>Saved {dateLabel(result.createdAt)}</span>
            </div>
            <Link
              href={`/memory?investigation=${encodeURIComponent(result.id)}`}
              className="tk-button"
            >
              <BookOpen size={14} aria-hidden="true" />
              Review &amp; remember
            </Link>
            <p className="tk-scope tk-result-scope">{result.scopeNote}</p>
            <section
              className="tk-basis"
              aria-labelledby="schedule-basis-heading"
            >
              <h3 id="schedule-basis-heading">Schedule basis</h3>
              <dl>
                <div>
                  <dt>Imported schedule</dt>
                  <dd>{result.basis.scheduleName}</dd>
                </div>
                <div>
                  <dt>P6 data date</dt>
                  <dd>{dateLabel(result.basis.dataDate)}</dd>
                </div>
                <div>
                  <dt>Export date</dt>
                  <dd>{dateLabel(result.basis.exportDate)}</dd>
                </div>
                <div>
                  <dt>Approval status</dt>
                  <dd>
                    {result.basis.approvalStatus === "unconfirmed"
                      ? "Unconfirmed"
                      : result.basis.approvalStatus || "Not established"}
                  </dd>
                </div>
              </dl>
            </section>
            {result.selectedSource && <SelectedSourceContext source={result.selectedSource} />}
            {result.milestoneContext ? <MilestoneContext context={result.milestoneContext} /> : <p className="tk-scope tk-milestone-unselected">No target milestone was selected for this saved investigation. Completion impact remains unresolved.</p>}
            <div className="tk-findings">
              {findingGroups.map((group) => {
                const findings = result.findings.filter(
                  (finding) => finding.kind === group.kind,
                );
                if (!findings.length) return null;
                return (
                  <section
                    className={`tk-finding-group tk-${group.kind}`}
                    key={group.kind}
                    aria-labelledby={`group-${group.kind}`}
                  >
                    <div className="tk-group-heading">
                      <h3 id={`group-${group.kind}`}>{group.title}</h3>
                      <span>{findings.length}</span>
                    </div>
                    <p className="tk-group-description">{group.description}</p>
                    <ol>
                      {findings.map((finding) => (
                        <li key={finding.id}>
                          <p>{finding.text}</p>
                          {finding.citations.length > 0 && (
                            <ul
                              className="tk-citations"
                              aria-label="Supporting sources"
                            >
                              {finding.citations.map((citation, index) => (
                                <li key={`${citation.href}-${index}`}>
                                  <Link href={citation.href} prefetch={false}>
                                    <ArrowUpRight
                                      size={13}
                                      aria-hidden="true"
                                    />
                                    <span>{citation.label}</span>
                                  </Link>
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      ))}
                    </ol>
                  </section>
                );
              })}
            </div>
            <ReviewedMemoryNotes notes={result.reviewedMemory ?? []} />
            {result.limitations.length > 0 && (
              <section
                className="tk-limitations"
                aria-labelledby="limitations-heading"
              >
                <h3 id="limitations-heading">
                  <TriangleAlert size={16} aria-hidden="true" />
                  Limits of this investigation
                </h3>
                <ul>
                  {result.limitations.map((limitation, index) => (
                    <li key={index}>{limitation}</li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </Frame>
  );
}
