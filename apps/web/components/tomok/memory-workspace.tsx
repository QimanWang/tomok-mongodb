"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  LoaderCircle,
  Save,
} from "lucide-react";
import { useChatShell } from "@/app/_components/chat-shell-context";
import type {
  MemoryActor,
  MemoryContent,
  ProjectMemory,
} from "@/lib/tomok/memory-types";
import { useProjectJson } from "./use-project-json";
import {
  MemoryContentFields,
  memoryContentIssue,
} from "./memory-content-fields";
import {
  MemoryError,
  MemoryFrame,
  MemoryPending,
  MemoryStatusBadge,
  memoryDate,
  memoryTimestamp,
  useMemoryMutation,
  type MemoryContext,
} from "./memory-shared";

export function MemoryWorkspace() {
  const params = useSearchParams();
  const investigation = params.get("investigation");
  return investigation ? (
    <NewMemory investigationId={investigation} key={investigation} />
  ) : (
    <MemoryList />
  );
}

function MemoryList() {
  const { viewer } = useChatShell();
  const { data, error, retry } = useProjectJson<{
    memories: ProjectMemory[];
    viewer: MemoryActor;
    activeReleaseId: string;
  }>("/api/tomok/memory", viewer?.id ?? "");
  const [filter, setFilter] = useState("all");
  const memories =
    data?.memories.filter(
      (memory) => filter === "all" || memory.latest.status === filter,
    ) ?? [];
  return (
    <MemoryFrame>
      <div className="tk-title-row">
        <BookOpen size={22} aria-hidden="true" />
        <div>
          <p className="tk-eyebrow">PROJECT MEMORY</p>
          <h2>Reviewed project notes</h2>
        </div>
      </div>
      <p className="tk-lead">
        Keep mappings and explanations with their evidence. Tomok uses reviewed
        notes that match the activity, imported data, and reporting date.
      </p>
      <div className="tm-list-toolbar">
        <label htmlFor="memory-status-filter">
          Show
          <select
            id="memory-status-filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="all">All accessible notes</option>
            <option value="reviewed">Reviewed</option>
            <option value="proposed">My drafts</option>
            <option value="needs_review">Needs review</option>
            <option value="withdrawn">Withdrawn</option>
          </select>
        </label>
        <Link href="/investigations" className="tk-button">
          Start from an investigation
          <ArrowUpRight size={13} aria-hidden="true" />
        </Link>
      </div>
      {error ? (
        <MemoryError message={error} retry={retry} />
      ) : !data ? (
        <MemoryPending>Loading project notes…</MemoryPending>
      ) : !memories.length ? (
        <div className="tm-empty">
          <BookOpen size={22} aria-hidden="true" />
          <h3>
            {data.memories.length
              ? "No notes match this filter"
              : "No project notes yet"}
          </h3>
          <p>
            Open a saved investigation and choose Review &amp; remember to draft
            a note with its sources.
          </p>
        </div>
      ) : (
        <ul className="tm-memory-list">
          {memories.map((memory) => (
            <li key={memory.id}>
              <div className="tm-note-heading">
                <Link href={`/memory/${encodeURIComponent(memory.id)}`}>
                  <h3>{memory.latest.title}</h3>
                </Link>
                <MemoryStatusBadge status={memory.latest.status} />
              </div>
              <p className="tm-note-preview">{memory.latest.statement}</p>
              <div className="tm-note-meta">
                <span>
                  {memory.latest.kind === "mapping"
                    ? "Field-to-schedule mapping"
                    : "Evidence interpretation"}
                </span>
                <span>{memory.activityCode}</span>
                <span>
                  {memoryDate(memory.latest.validFrom)} –{" "}
                  {memoryDate(memory.latest.validThrough)}
                </span>
              </div>
              <div className="tm-note-footer">
                <span>
                  {memory.latest.status === "reviewed" ? "Reviewed" : "Updated"}{" "}
                  by {memory.latest.actor.name} ·{" "}
                  {memoryTimestamp(memory.latest.recordedAt)}
                </span>
                <span>
                  Revision {memory.latest.revision} ·{" "}
                  {memory.visibility === "private"
                    ? "Private draft"
                    : "Project members"}
                </span>
              </div>
              {memory.releaseId !== data.activeReleaseId && (
                <p className="tm-stale">
                  Earlier project import · excluded from current investigations
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="tm-footer-help">
        Drafts are private until first review. Flagged and withdrawn notes are
        excluded from future answers; their history remains available.
      </p>
    </MemoryFrame>
  );
}

function NewMemory({ investigationId }: { investigationId: string }) {
  const { viewer } = useChatShell();
  const { data, error, retry } = useProjectJson<MemoryContext>(
    `/api/tomok/investigations/${encodeURIComponent(investigationId)}/memory-context`,
    viewer?.id ?? "",
  );
  return (
    <MemoryFrame>
      <Link
        href={data?.investigation.href ?? "/memory"}
        className="tk-back-link"
      >
        <ArrowLeft size={13} aria-hidden="true" />
        {data?.investigation.kind === "replay" ? "Back to saved replay" : data ? "Back to investigation" : "Project memory"}
      </Link>
      <div className="tk-title-row">
        <BookOpen size={22} aria-hidden="true" />
        <div>
          <p className="tk-eyebrow">PROJECT MEMORY</p>
          <h2>Draft a project note</h2>
        </div>
      </div>
      <p className="tk-lead">
        Capture a mapping or explanation for review. Saving a draft does not
        make it available to Tomok or other project members.
      </p>
      {error ? (
        <MemoryError message={error} retry={retry} />
      ) : !data ? (
        <MemoryPending>Loading investigation evidence…</MemoryPending>
      ) : (
        <DraftForm
          key={`${data.viewer.id}:${data.investigation.id}`}
          context={data}
        />
      )}
    </MemoryFrame>
  );
}

function DraftForm({ context }: { context: MemoryContext }) {
  const router = useRouter();
  const mutation = useMemoryMutation();
  const [validation, setValidation] = useState<string>();
  const [content, setContent] = useState<MemoryContent>({
    kind: "mapping",
    title: "",
    statement: "",
    validFrom: context.investigation.cutoff,
    validThrough: null,
    evidenceIds: [],
  });
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const issue = memoryContentIssue(content);
    setValidation(issue);
    if (issue) return;
    const result = await mutation.submit("/api/tomok/memory", {
      investigationId: context.investigation.id,
      ...content,
    });
    if (result) router.push(`/memory/${encodeURIComponent(result.memory.id)}`);
  }
  return (
    <>
      <div className="tm-scope">
        <p className="tk-eyebrow">FIXED ACTIVITY SCOPE</p>
        <Link href={context.activity.href} prefetch={false}>
          {context.activity.code}
          <ArrowUpRight size={13} aria-hidden="true" />
        </Link>
        <p>{context.activity.name}</p>
        <small>From {context.investigation.title}</small>
      </div>
      <form onSubmit={save} aria-busy={mutation.busy}>
        <MemoryContentFields
          value={content}
          onChange={(next) => {
            setContent(next);
            setValidation(undefined);
          }}
          evidence={context.evidence}
          disabled={mutation.busy}
          prefix="draft-memory"
        />
        {validation && (
          <p className="tm-validation" role="alert">
            {validation}
          </p>
        )}
        {mutation.error && <MemoryError message={mutation.error} />}
        <div className="tm-form-actions">
          <button
            type="submit"
            className="tk-button tk-primary"
            disabled={mutation.busy}
          >
            {mutation.busy ? (
              <LoaderCircle
                size={15}
                className="animate-spin"
                aria-hidden="true"
              />
            ) : (
              <Save size={15} aria-hidden="true" />
            )}
            {mutation.busy ? "Saving…" : "Save draft"}
          </button>
          <span>
            Private to {context.viewer.name}. Review is a separate step.
          </span>
        </div>
      </form>
    </>
  );
}
