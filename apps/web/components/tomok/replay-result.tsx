"use client";

import Link from "next/link";
import { ArrowLeft, ArrowUpRight, ClipboardCheck } from "lucide-react";
import type { ReactNode } from "react";
import type { InvestigationFinding } from "@/lib/tomok/investigation";
import type { CaseReplay } from "@/lib/tomok/replay-types";

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

function Citations({
  citations,
  exhibits,
}: {
  citations: { label: string; href: string }[];
  exhibits: CaseReplay["replay"]["exhibits"];
}) {
  if (!citations.length) return null;
  return (
    <ul className="tk-citations" aria-label="Supporting replay excerpts">
      {citations.map((citation, index) => (
        <li key={`${citation.href}:${index}`}>
          {exhibits.some((exhibit) => exhibit.href === citation.href) ? (
            <a href={citation.href}>
              <ArrowUpRight size={13} aria-hidden="true" />
              <span>{citation.label}</span>
            </a>
          ) : (
            <span className="tr-citation-unavailable">
              {citation.label} · excerpt unavailable
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Findings({
  findings,
  result,
  prefix,
}: {
  findings: InvestigationFinding[];
  result: CaseReplay;
  prefix: string;
}) {
  const groups = [
    { kind: "documented", title: "Documented in the sources" },
    { kind: "inferred", title: "Assessment" },
    { kind: "unresolved", title: "Needs confirmation" },
  ] as const;
  return (
    <div className="tk-findings">
      {groups.map((group) => {
        const entries = findings.filter(
          (finding) => finding.kind === group.kind,
        );
        if (!entries.length) return null;
        return (
          <section
            className={`tk-finding-group tk-${group.kind}`}
            key={group.kind}
            aria-labelledby={`${prefix}-${group.kind}`}
          >
            <div className="tk-group-heading">
              <h3 id={`${prefix}-${group.kind}`}>{group.title}</h3>
              <span>{entries.length}</span>
            </div>
            <ol>
              {entries.map((finding) => (
                <li key={finding.id}>
                  <p>{finding.text}</p>
                  <Citations
                    citations={finding.citations}
                    exhibits={result.replay.exhibits}
                  />
                </li>
              ))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

export function ReplayResult({
  result,
  advance,
}: {
  result: CaseReplay;
  advance: ReactNode;
}) {
  const { replay } = result;
  const notes = result.reviewedMemory ?? [];
  const reassessment = replay.reassessment;
  return (
    <>
      <div className="tk-title-row">
        <ClipboardCheck size={22} aria-hidden="true" />
        <div>
          <p className="tk-eyebrow">
            SAVED CASE REPLAY · STAGE{" "}
            {replay.stage === "initial" ? "1 OF 2" : "2 OF 2"}
          </p>
          <h2>{result.title}</h2>
        </div>
      </div>
      <p className="tr-stage-label">{replay.label}</p>
      <p className="tk-result-question">{result.question}</p>
      <div className="tk-result-meta">
        <span>
          Evidence through <strong>{dateLabel(result.cutoff)}</strong>
        </span>
        <span>Saved {dateLabel(result.createdAt)}</span>
      </div>
      <div className="tr-context-note">
        <h3>Reporting replay, not historical availability</h3>
        <p>{replay.availabilityNote}</p>
        <p>
          These selected excerpts belong to this saved stage. Full project files
          and live memory are outside the replay.
        </p>
      </div>
      {advance}
      {reassessment ? (
        <section
          className="tr-reassessment"
          aria-labelledby="reassessment-heading"
        >
          <div className="tr-section-heading">
            <h2 id="reassessment-heading">
              What changed after {dateLabel(reassessment.previousCutoff)}
            </h2>
            <Link
              className="tk-back-link"
              href={`/replays/${encodeURIComponent(reassessment.previousId)}`}
              prefetch={false}
            >
              <ArrowLeft size={13} aria-hidden="true" />
              Open preserved initial result
            </Link>
          </div>
          <Findings
            findings={reassessment.findings}
            result={result}
            prefix="change"
          />
          <section
            className="tr-memory-checks"
            aria-labelledby="memory-checks-heading"
          >
            <h3 id="memory-checks-heading">Reviewed knowledge reassessment</h3>
            <p className="tk-group-description">
              These suggestions do not change a reviewed note. A person must
              review any update in project memory.
            </p>
            {reassessment.memoryChecks.length ? (
              <ul>
                {reassessment.memoryChecks.map((check) => {
                  const note = notes.find(
                    (item) =>
                      item.id === check.memoryId &&
                      item.revision === check.revision,
                  );
                  return (
                    <li key={`${check.memoryId}:${check.revision}`}>
                      <div className="tr-note-heading">
                        <h4>
                          {note?.title ?? "Reviewed project note"} · revision{" "}
                          {check.revision}
                        </h4>
                        <span
                          className={`tr-disposition tr-${check.disposition}`}
                        >
                          {check.disposition === "mapping-retained"
                            ? "Mapping retained"
                            : check.disposition === "review-suggested"
                              ? "Review suggested"
                              : "No specific conflict"}
                        </span>
                      </div>
                      <p>{check.reason}</p>
                      <Citations
                        citations={check.citations}
                        exhibits={replay.exhibits}
                      />
                      <Link
                        className="tr-leave-link"
                        href={`/memory/${encodeURIComponent(check.memoryId)}`}
                        prefetch={false}
                      >
                        Leave replay to review project memory{" "}
                        <ArrowUpRight size={12} aria-hidden="true" />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="tk-scope">
                No applicable reviewed notes were available for this
                reassessment.
              </p>
            )}
          </section>
        </section>
      ) : null}
      {replay.progress.length ? (
        <section className="tr-progress" aria-labelledby="progress-heading">
          <h3 id="progress-heading">Recorded field progress</h3>
          <div
            className="tr-table-scroll"
            role="region"
            aria-label="Field progress by report date"
            tabIndex={0}
          >
            <table>
              <caption>
                Completed / total columns from the reports shown in this stage
              </caption>
              <thead>
                <tr>
                  <th scope="col">Report date</th>
                  <th scope="col">Jet grouted</th>
                  <th scope="col">Predrilled</th>
                  <th scope="col">Line M</th>
                  <th scope="col">Line L</th>
                </tr>
              </thead>
              <tbody>
                {replay.progress.map((row) => {
                  const exhibit = replay.exhibits.find((item) =>
                    item.evidenceIds.includes(row.evidenceId),
                  );
                  return (
                    <tr key={row.evidenceId}>
                      <th scope="row">
                        {exhibit ? (
                          <a href={exhibit.href}>
                            {dateLabel(row.observedDate)}
                          </a>
                        ) : (
                          dateLabel(row.observedDate)
                        )}
                      </th>
                      {[
                        row.jetGrouted,
                        row.predrilled,
                        row.lineM,
                        row.lineL,
                      ].map((quantity, index) => (
                        <td key={index}>
                          {quantity.completed} / {quantity.total}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      <section
        className="tk-basis tr-basis"
        aria-labelledby="replay-basis-heading"
      >
        <h3 id="replay-basis-heading">Schedule basis</h3>
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
      <p className="tk-scope tr-scope">{result.scopeNote}</p>
      <Findings findings={result.findings} result={result} prefix="finding" />
      <section
        className="tr-reviewed-notes"
        aria-labelledby="replay-reviewed-notes-heading"
      >
        <h3 id="replay-reviewed-notes-heading">
          Reviewed notes saved with this stage
        </h3>
        <p className="tk-group-description">
          The statements and revisions below are preserved with this result.
        </p>
        {notes.length ? (
          <ul>
            {notes.map((note) => (
              <li key={`${note.id}:${note.revision}`} id={`memory-${note.id}`}>
                <h4>{note.title}</h4>
                <p>{note.statement}</p>
                <div className="tr-note-meta">
                  <span>
                    {note.kind === "mapping"
                      ? "Field-to-schedule mapping"
                      : "Evidence interpretation"}
                  </span>
                  <span>
                    Valid from {dateLabel(note.validFrom)}
                    {note.validThrough
                      ? ` through ${dateLabel(note.validThrough)}`
                      : " · no end date"}
                  </span>
                  <span>
                    Reviewed by {note.reviewedBy.name} ·{" "}
                    {dateLabel(note.reviewedAt)} · revision {note.revision}
                  </span>
                </div>
                <Citations
                  citations={note.citations}
                  exhibits={replay.exhibits}
                />
                <Link
                  className="tr-leave-link"
                  href={`/memory/${encodeURIComponent(note.id)}`}
                  prefetch={false}
                >
                  Leave replay to review project memory{" "}
                  <ArrowUpRight size={12} aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="tk-scope">
            No reviewed notes qualified for this stage. Findings are based on
            the source records and still need project review.
          </p>
        )}
        <Link
          className="tk-button tr-review-action"
          href={`/memory?investigation=${encodeURIComponent(result.id)}`}
          prefetch={false}
        >
          Leave replay to review &amp; remember{" "}
          <ArrowUpRight size={13} aria-hidden="true" />
        </Link>
      </section>
      <section className="tr-exhibits" aria-labelledby="exhibits-heading">
        <h2 id="exhibits-heading">Source excerpts in this stage</h2>
        <p className="tk-group-description">
          Citations above lead to these selected records. Original workbooks may
          contain observations beyond this reporting cutoff.
        </p>
        {replay.exhibits.map((exhibit) => {
          const anchor = exhibit.href.split("#")[1];
          const hasFormula = exhibit.cells.some((cell) => cell.formula);
          return (
            <article
              className="tr-exhibit"
              id={anchor}
              key={exhibit.id}
              tabIndex={-1}
              aria-labelledby={`${anchor}-heading`}
            >
              <div className="tr-exhibit-heading">
                <h3 id={`${anchor}-heading`}>{exhibit.label}</h3>
                <span>
                  {exhibit.observedDate
                    ? dateLabel(exhibit.observedDate)
                    : "Context · no observation date"}
                </span>
              </div>
              <p>{exhibit.text}</p>
              {exhibit.cells.length ? (
                <div
                  className="tr-table-scroll"
                  role="region"
                  aria-label={`${exhibit.label} selected cells`}
                  tabIndex={0}
                >
                  <table>
                    <caption>Selected source cells</caption>
                    <thead>
                      <tr>
                        <th scope="col">Cell</th>
                        <th scope="col">Recorded value</th>
                        {hasFormula ? <th scope="col">Formula</th> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {exhibit.cells.map((cell) => (
                        <tr key={cell.address}>
                          <th scope="row">{cell.address}</th>
                          <td>{cell.display || "—"}</td>
                          {hasFormula ? (
                            <td>
                              <code>{cell.formula || "—"}</code>
                            </td>
                          ) : null}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </article>
          );
        })}
        <Link href="/files" className="tr-leave-link" prefetch={false}>
          Leave replay to browse full project files{" "}
          <ArrowUpRight size={13} aria-hidden="true" />
        </Link>
      </section>
      {result.limitations.length ? (
        <section
          className="tk-limitations"
          aria-labelledby="replay-limitations-heading"
        >
          <h3 id="replay-limitations-heading">Limits of this replay</h3>
          <ul>
            {result.limitations.map((limitation, index) => (
              <li key={index}>{limitation}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
