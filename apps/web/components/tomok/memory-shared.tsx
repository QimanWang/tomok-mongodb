"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Files, LoaderCircle, Search, TriangleAlert } from "lucide-react";
import { useChatShell } from "@/app/_components/chat-shell-context";
import type {
  MemoryActor,
  MemoryCitation,
  MemoryOrigin,
  MemoryStatus,
  ProjectMemory,
} from "@/lib/tomok/memory-types";
import "./investigation.css";
import "./memory-workspace.css";

export type MemoryEvidence = {
  id: string;
  label: string;
  text: string;
  href: string;
  observedDate: string | null;
  kind: string;
};

export type MemoryContext = {
  investigation: MemoryOrigin;
  activity: { code: string; name: string; href: string };
  evidence: MemoryEvidence[];
  viewer: MemoryActor;
  activeReleaseId: string;
};

export type MemoryDetailResponse = {
  memory: ProjectMemory;
  evidence: MemoryEvidence[];
  viewer: MemoryActor;
  activeReleaseId: string;
  origin: MemoryOrigin | null;
};

export function memoryDate(value: string | null) {
  if (!value) return "Ongoing";
  const date = new Date(`${value.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }).format(date);
}

export function memoryTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(date);
}

export const memoryStatusLabels: Record<MemoryStatus, string> = {
  proposed: "Draft",
  reviewed: "Reviewed",
  needs_review: "Needs review",
  withdrawn: "Withdrawn",
};

export function MemoryStatusBadge({ status }: { status: MemoryStatus }) {
  return (
    <span className={`tm-status-badge tm-status-${status}`}>
      {memoryStatusLabels[status]}
    </span>
  );
}

export function MemoryCitations({
  citations,
}: {
  citations: MemoryCitation[];
}) {
  return (
    <ul className="tk-citations" aria-label="Supporting sources">
      {citations.map((citation) => (
        <li key={citation.evidenceId}>
          <Link href={citation.href} prefetch={false}>
            {citation.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function MemoryFrame({ children }: { children: ReactNode }) {
  return (
    <section
      className="tk-investigation tm-workspace"
      aria-label="Tomok project memory"
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
          <Link href="/investigations" className="tk-button">
            <Search size={14} aria-hidden="true" />
            Investigate
          </Link>
          <Link href="/files" className="tk-button">
            <Files size={14} aria-hidden="true" />
            Files
          </Link>
        </nav>
      </header>
      <div className="tk-investigation-body">
        <div className="tk-content tm-content">{children}</div>
      </div>
    </section>
  );
}

export function MemoryPending({ children }: { children: ReactNode }) {
  return (
    <p className="tk-status" role="status">
      <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
      {children}
    </p>
  );
}

export function MemoryError({
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
            <button type="button" className="tk-button" onClick={retry}>
              Try again
            </button>
          )}
          {!viewer && (
            <button
              type="button"
              className="tk-button"
              onClick={() => requestSignIn()}
            >
              Sign in
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Mutations belong to their mounted editor, including its authenticated identity. */
export function useMemoryMutation() {
  const request = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [errorStatus, setErrorStatus] = useState<number>();
  useEffect(() => {
    // Next.js Activity restores this editor with its previous state and refs.
    request.current?.abort();
    request.current = null;
    setBusy(false);
    return () => {
      const pending = request.current;
      request.current = null;
      pending?.abort();
    };
  }, []);

  async function submit(
    url: string,
    body: unknown,
  ): Promise<{ memory: ProjectMemory; href?: string } | undefined> {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(undefined);
    setErrorStatus(undefined);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        if (!controller.signal.aborted && request.current === controller)
          setErrorStatus(response.status);
        throw new Error(
          result?.error ??
            "Unable to save this project note. Please try again.",
        );
      }
      if (!result?.memory?.id || !result.memory.latest)
        throw new Error(
          "The saved project note was not returned. Please reload to check its status.",
        );
      if (!controller.signal.aborted && request.current === controller)
        return result;
    } catch (cause) {
      if (!controller.signal.aborted && request.current === controller)
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to save this project note.",
        );
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  return { submit, busy, error, errorStatus };
}
