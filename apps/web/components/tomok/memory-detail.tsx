"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Check,
  Flag,
  History,
  LoaderCircle,
  Pencil,
  TriangleAlert,
  X,
} from "lucide-react";
import { useChatShell } from "@/app/_components/chat-shell-context";
import type {
  MemoryContent,
  MemoryRevision,
  ProjectMemory,
} from "@/lib/tomok/memory-types";
import { useProjectJson } from "./use-project-json";
import {
  MemoryContentFields,
  memoryContentIssue,
} from "./memory-content-fields";
import {
  MemoryCitations,
  MemoryError,
  MemoryFrame,
  MemoryPending,
  MemoryStatusBadge,
  memoryDate,
  memoryTimestamp,
  useMemoryMutation,
  type MemoryDetailResponse,
  type MemoryEvidence,
} from "./memory-shared";

export function MemoryDetail({ id }: { id: string }) {
  const { viewer } = useChatShell();
  const { data, error, retry } = useProjectJson<MemoryDetailResponse>(
    `/api/tomok/memory/${encodeURIComponent(id)}`,
    viewer?.id ?? "",
  );
  return (
    <MemoryFrame>
      <Link href="/memory" className="tk-back-link">
        <ArrowLeft size={13} aria-hidden="true" />
        Project memory
      </Link>
      {error ? (
        <MemoryError message={error} retry={retry} />
      ) : !data ? (
        <MemoryPending>Opening project note…</MemoryPending>
      ) : (
        <MemoryRecord
          key={`${data.viewer.id}:${data.memory.id}:${data.memory.latest.revision}`}
          data={data}
          reload={retry}
        />
      )}
    </MemoryFrame>
  );
}

function revisionLabel(revision: MemoryRevision) {
  return revision.status === "reviewed"
    ? "Reviewed"
    : revision.status === "needs_review"
      ? "Flagged"
      : revision.status === "withdrawn"
        ? "Withdrawn"
        : "Drafted";
}

function MemoryRecord({
  data,
  reload,
}: {
  data: MemoryDetailResponse;
  reload: () => void;
}) {
  const [memory, setMemory] = useState<ProjectMemory>(data.memory);
  const [editing, setEditing] = useState(
    data.memory.latest.status === "proposed" ||
      data.memory.latest.status === "needs_review",
  );
  const [notice, setNotice] = useState<string>();
  const mutation = useMemoryMutation();
  const latest = memory.latest;
  const currentImport = memory.releaseId === data.activeReleaseId;
  const lastReview = [...memory.revisions]
    .reverse()
    .find((revision) => revision.status === "reviewed");

  async function revise(
    action: "review" | "flag" | "withdraw",
    reason: string | null,
    content?: MemoryContent,
  ) {
    setNotice(undefined);
    const result = await mutation.submit(
      `/api/tomok/memory/${encodeURIComponent(memory.id)}/revisions`,
      {
        expectedRevision: latest.revision,
        action,
        reason,
        ...(content ? { content } : {}),
      },
    );
    if (result) {
      setMemory(result.memory);
      setEditing(false);
      setNotice(
        `Revision ${result.memory.latest.revision} saved. ${result.memory.latest.status === "reviewed" ? "This reviewed note is available to matching future investigations." : "This note is excluded from future answers."}`,
      );
    }
  }

  return (
    <>
      <div className="tk-title-row">
        <BookOpen size={22} aria-hidden="true" />
        <div>
          <p className="tk-eyebrow">
            PROJECT NOTE · REVISION {latest.revision}
          </p>
          <h2>{latest.title}</h2>
        </div>
      </div>
      <div className="tm-detail-meta">
        <MemoryStatusBadge status={latest.status} />
        <span>
          {memory.visibility === "private"
            ? "Private draft"
            : "Visible to project members"}
        </span>
        <span>
          {latest.kind === "mapping"
            ? "Field-to-schedule mapping"
            : "Evidence interpretation"}
        </span>
      </div>
      <p className="tm-statement">{latest.statement}</p>
      <dl className="tm-note-basis">
        <div>
          <dt>Activity</dt>
          <dd>{memory.activityCode}</dd>
        </div>
        <div>
          <dt>Applies from</dt>
          <dd>{memoryDate(latest.validFrom)}</dd>
        </div>
        <div>
          <dt>Applies through</dt>
          <dd>{memoryDate(latest.validThrough)}</dd>
        </div>
      </dl>
      <MemoryCitations citations={latest.citations} />
      <p className="tm-review-attribution">
        {revisionLabel(latest)} by <strong>{latest.actor.name}</strong> ·{" "}
        {memoryTimestamp(latest.recordedAt)}
      </p>
      {lastReview && latest.status !== "reviewed" && (
        <p className="tm-help">
          Last reviewed by {lastReview.actor.name} on{" "}
          {memoryTimestamp(lastReview.recordedAt)}. That review is no longer
          active.
        </p>
      )}
      {latest.reason && (
        <p className="tm-revision-reason">
          <strong>Reason:</strong> {latest.reason}
        </p>
      )}
      {memory.createdBy.id === data.viewer.id && (
        <Link
          className="tm-origin-link"
          href={`/investigations/${encodeURIComponent(memory.originInvestigationId)}`}
        >
          Originating investigation
          <ArrowUpRight size={13} aria-hidden="true" />
        </Link>
      )}
      {!currentImport && (
        <div className="tm-scope-warning" role="status">
          <TriangleAlert size={18} aria-hidden="true" />
          <p>
            This note belongs to an earlier project import. It is excluded from
            current investigations and cannot be marked reviewed for the current
            data. Start a new note from a current investigation; you can still
            flag or withdraw this note.
          </p>
        </div>
      )}
      {latest.status === "proposed" && (
        <p className="tm-review-guidance">
          This draft is private and is not used in answers. Review its wording,
          reporting dates, and sources before saving it as reviewed.
        </p>
      )}
      {notice && (
        <p className="tm-save-notice" role="status">
          <Check size={16} aria-hidden="true" />
          {notice}
        </p>
      )}
      {!editing ? (
        <div className="tm-form-actions">
          <button
            className="tk-button"
            type="button"
            onClick={() => setEditing(true)}
            disabled={mutation.busy || !currentImport}
          >
            <Pencil size={14} aria-hidden="true" />
            {latest.status === "reviewed"
              ? "Correct reviewed note"
              : latest.status === "withdrawn"
                ? "Review for restoration"
                : "Review note"}
          </button>
        </div>
      ) : (
        <ReviewForm
          key={`review:${latest.revision}`}
          latest={latest}
          evidence={data.evidence}
          reviewer={data.viewer.name}
          requiresReason={latest.status !== "proposed"}
          disabled={mutation.busy || !currentImport}
          busy={mutation.busy}
          onSave={(content, reason) => revise("review", reason, content)}
          onCancel={() => setEditing(false)}
        />
      )}
      {mutation.error && <MemoryError message={mutation.error} />}
      {mutation.errorStatus === 409 && (
        <button
          className="tk-button tm-reload-button"
          type="button"
          onClick={reload}
        >
          Reload latest revision
        </button>
      )}
      <NoteStateActions
        key={`status:${latest.revision}`}
        status={latest.status}
        busy={mutation.busy}
        onAction={revise}
      />
      <RevisionHistory revisions={memory.revisions} />
    </>
  );
}

function ReviewForm({
  latest,
  evidence,
  reviewer,
  requiresReason,
  disabled,
  busy,
  onSave,
  onCancel,
}: {
  latest: MemoryRevision;
  evidence: MemoryEvidence[];
  reviewer: string;
  requiresReason: boolean;
  disabled: boolean;
  busy: boolean;
  onSave: (content: MemoryContent, reason: string | null) => Promise<void>;
  onCancel: () => void;
}) {
  const [content, setContent] = useState<MemoryContent>({
    kind: latest.kind,
    title: latest.title,
    statement: latest.statement,
    validFrom: latest.validFrom,
    validThrough: latest.validThrough,
    evidenceIds: latest.evidenceIds,
  });
  const [reason, setReason] = useState("");
  const [validation, setValidation] = useState<string>();
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const issue =
      memoryContentIssue(content) ??
      (requiresReason && !reason.trim()
        ? "Explain why this note is being revised or restored."
        : undefined);
    setValidation(issue);
    if (issue) return;
    await onSave(content, reason.trim() || null);
  }
  return (
    <section className="tm-review-editor" aria-labelledby="review-note-heading">
      <h3 id="review-note-heading">Review this note</h3>
      <p className="tm-help">
        Saving as reviewed records your review as <strong>{reviewer}</strong>{" "}
        and makes this note available to project members and matching future
        investigations.
      </p>
      <form onSubmit={save} aria-busy={busy}>
        <MemoryContentFields
          value={content}
          onChange={(next) => {
            setContent(next);
            setValidation(undefined);
          }}
          evidence={evidence}
          disabled={disabled}
          prefix="review-memory"
        />
        <div className="tm-field">
          <label htmlFor="review-memory-reason">
            {requiresReason ? "Reason for this revision" : "Review comment"}
            {!requiresReason && <span>Optional</span>}
          </label>
          <textarea
            id="review-memory-reason"
            rows={2}
            maxLength={1000}
            required={requiresReason}
            disabled={disabled}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              setValidation(undefined);
            }}
            placeholder={
              requiresReason
                ? "Explain what changed and why."
                : "Add any context for your review."
            }
          />
        </div>
        {validation && (
          <p className="tm-validation" role="alert">
            {validation}
          </p>
        )}
        <div className="tm-form-actions">
          <button
            className="tk-button tk-primary"
            type="submit"
            disabled={disabled}
          >
            {busy ? (
              <LoaderCircle
                size={15}
                className="animate-spin"
                aria-hidden="true"
              />
            ) : (
              <Check size={15} aria-hidden="true" />
            )}
            {busy ? "Saving…" : "Save as reviewed"}
          </button>
          <button
            className="tk-button"
            type="button"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <span>A new revision preserves the earlier record.</span>
        </div>
      </form>
    </section>
  );
}

function NoteStateActions({
  status,
  busy,
  onAction,
}: {
  status: MemoryRevision["status"];
  busy: boolean;
  onAction: (
    action: "flag" | "withdraw",
    reason: string | null,
  ) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [validation, setValidation] = useState<string>();
  async function update(action: "flag" | "withdraw") {
    if (!reason.trim()) {
      setValidation("Add a reason before changing the note's status.");
      return;
    }
    setValidation(undefined);
    await onAction(action, reason.trim());
  }
  return (
    <details className="tm-state-actions">
      <summary>Flag or withdraw this note</summary>
      <p className="tm-help">
        Both actions exclude the note from future answers and keep its revision
        history.
      </p>
      <div className="tm-field">
        <label htmlFor="memory-status-reason">Reason</label>
        <textarea
          id="memory-status-reason"
          rows={2}
          maxLength={1000}
          value={reason}
          disabled={busy}
          onChange={(event) => {
            setReason(event.target.value);
            setValidation(undefined);
          }}
          placeholder="Explain what needs checking or why the note should be withdrawn."
        />
      </div>
      {validation && (
        <p className="tm-validation" role="alert">
          {validation}
        </p>
      )}
      <div className="tm-form-actions">
        <button
          type="button"
          className="tk-button"
          disabled={busy || status === "needs_review"}
          onClick={() => void update("flag")}
        >
          <Flag size={14} aria-hidden="true" />
          Flag for review
        </button>
        <button
          type="button"
          className="tk-button"
          disabled={busy || status === "withdrawn"}
          onClick={() => void update("withdraw")}
        >
          <X size={14} aria-hidden="true" />
          Withdraw note
        </button>
      </div>
    </details>
  );
}

function RevisionHistory({ revisions }: { revisions: MemoryRevision[] }) {
  return (
    <details className="tm-history">
      <summary>
        <History size={16} aria-hidden="true" />
        Revision history <span>{revisions.length}</span>
      </summary>
      <ol>
        {[...revisions].reverse().map((revision) => (
          <li key={revision.revision}>
            <div className="tm-history-heading">
              <h3>Revision {revision.revision}</h3>
              <MemoryStatusBadge status={revision.status} />
            </div>
            <p className="tm-review-attribution">
              {revisionLabel(revision)} by {revision.actor.name} ·{" "}
              {memoryTimestamp(revision.recordedAt)}
            </p>
            <h4>{revision.title}</h4>
            <p className="tm-history-statement">{revision.statement}</p>
            <p className="tm-help">
              {revision.kind === "mapping" ? "Mapping" : "Interpretation"} ·{" "}
              {memoryDate(revision.validFrom)} –{" "}
              {memoryDate(revision.validThrough)}
            </p>
            {revision.reason && (
              <p className="tm-revision-reason">
                <strong>Reason:</strong> {revision.reason}
              </p>
            )}
            <MemoryCitations citations={revision.citations} />
          </li>
        ))}
      </ol>
    </details>
  );
}
