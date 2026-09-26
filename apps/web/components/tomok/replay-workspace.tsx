"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  LoaderCircle,
  Play,
  TriangleAlert,
} from "lucide-react";
import { useChatShell } from "@/app/_components/chat-shell-context";
import type { CaseReplay, ReplayChatHistory, ReplayHistory, ReplayStageSummary } from "@/lib/tomok/replay-types";
import { useProjectJson } from "./use-project-json";
import { ReplayResult } from "./replay-result";
import { StartReplayChat } from "./replay-chat-workspace";
import { useReplayAction } from "./use-replay-action";
import "./investigation.css";
import "./replay.css";

function ReplayFrame({ children }: { children: ReactNode }) {
  return (
    <section
      className="tk-investigation tr-replay"
      aria-label="Tomok case replay"
    >
      <header className="tk-project-header">
        <span className="tk-project-mark" aria-hidden="true">
          T
        </span>
        <div>
          <p className="tk-eyebrow">TOMOK / CASE REPLAY</p>
          <h1>Frederick Douglass Tunnel</h1>
        </div>
        <span className="tr-header-label">Reporting replay</span>
      </header>
      <div className="tk-investigation-body">
        <div className="tk-content tr-content">{children}</div>
      </div>
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

function ReplayError({
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
          {retry ? (
            <button type="button" className="tk-button" onClick={retry}>
              Try again
            </button>
          ) : null}
          {!viewer ? (
            <button
              type="button"
              className="tk-button"
              onClick={() => requestSignIn()}
            >
              Sign in
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function savedAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit",
  }).format(date);
}

function StageLink({ stage }: { stage: ReplayStageSummary }) {
  return (
    <Link href={stage.href} className="tr-history-stage" prefetch={false}>
      <strong>{stage.label}<ArrowRight size={14} aria-hidden="true" /></strong>
      <span>{stage.reviewedMemoryCount} reviewed {stage.reviewedMemoryCount === 1 ? "note" : "notes"} saved · reports through {stage.cutoff}</span>
    </Link>
  );
}

function SavedReplayHistory() {
  const { viewer } = useChatShell();
  const { data, error, retry } = useProjectJson<ReplayHistory>("/api/tomok/replays", viewer?.id ?? "");
  return (
    <section className="tr-history" aria-labelledby="saved-replays-heading">
      <div className="tr-history-heading">
        <h2 id="saved-replays-heading">Your saved cases</h2>
        <button type="button" className="tk-text-button" onClick={retry}>Refresh</button>
      </div>
      <p className="tk-group-description">Open either saved stage to inspect its evidence or resume one of its conversations.</p>
      {error ? <ReplayError message={error} retry={retry} /> : !data ? <Pending>Loading saved cases…</Pending> : !data.cases.length ? (
        <p className="tk-scope">Your first replay will appear here after you start it.</p>
      ) : (
        <ol className="tr-history-list">
          {data.cases.map(item => (
            <li key={item.initial.id}>
              <p className="tr-history-date">Started <time dateTime={item.initial.createdAt}>{savedAt(item.initial.createdAt)}</time></p>
              <div className="tr-history-stages">
                <StageLink stage={item.initial} />
                {item.later ? <StageLink stage={item.later} /> : <p className="tr-history-unrevealed">Later reports have not been revealed in this case.</p>}
              </div>
            </li>
          ))}
        </ol>
      )}
      {data?.hasMore ? <p className="tk-scope">Showing your 20 most recently started cases. Earlier saved URLs still work.</p> : null}
    </section>
  );
}

function SavedReplayChats({ replayId }: { replayId: string }) {
  const { viewer } = useChatShell();
  const { data, error, retry } = useProjectJson<ReplayChatHistory>(
    `/api/tomok/replays/${encodeURIComponent(replayId)}/chats`, viewer?.id ?? "",
  );
  return (
    <details className="tr-chat-history">
      <summary>Your conversations with this stage{data?.chats.length ? ` (${data.chats.length}${data.hasMore ? "+" : ""})` : ""}</summary>
      {error ? <ReplayError message={error} retry={retry} /> : !data ? <Pending>Loading conversations…</Pending> : !data.chats.length ? (
        <p className="tk-scope">Open a fresh chat above. It will be saved here for you to resume.</p>
      ) : (
        <ul>
          {data.chats.map(chat => (
            <li key={chat.sessionId}>
              <span>Started <time dateTime={chat.createdAt}>{savedAt(chat.createdAt)}</time></span>
              <Link href={chat.href} className="tk-button" prefetch={false}>Resume chat<ArrowRight size={13} aria-hidden="true" /></Link>
            </li>
          ))}
        </ul>
      )}
      {data?.hasMore ? <p className="tk-scope">Showing the 20 most recently opened conversations for this stage.</p> : null}
    </details>
  );
}

export function ReplayWorkspace() {
  const { viewer } = useChatShell();
  const {
    data: status,
    error,
    retry,
  } = useProjectJson<{ imported: boolean }>(
    "/api/tomok/status",
    viewer?.id ?? "",
  );
  const action = useReplayAction("/api/tomok/replays", viewer?.id ?? "");
  return (
    <ReplayFrame>
      <Link href="/investigations" className="tk-back-link" prefetch={false}>
        <ArrowLeft size={13} aria-hidden="true" />
        Leave replay for investigations
      </Link>
      <div className="tk-title-row">
        <Play size={22} aria-hidden="true" />
        <div>
          <p className="tk-eyebrow">TWO REPORTING STAGES</p>
          <h2>South Portal jet grouting</h2>
        </div>
      </div>
      <p className="tk-lead">
        Review the case through July 14, then reveal the next reports to see
        what changed and which interpretations need another look.
      </p>
      <ol className="tr-stages" aria-label="Replay stages">
        <li>
          <span className="tr-stage-number">1</span>
          <div>
            <h3>Evidence through July 14</h3>
            <p>
              Inspect the initial findings, selected source excerpts, and any
              applicable reviewed notes.
            </p>
          </div>
        </li>
        <li>
          <span className="tr-stage-number">2</span>
          <div>
            <h3>Reveal July 15–16</h3>
            <p>
              Save a new assessment, compare later observations, and preserve
              the initial result.
            </p>
          </div>
        </li>
      </ol>
      <div className="tr-context-note">
        <h3>Reporting replay, not historical availability</h3>
        <p>
          Report dates control the observations shown at each stage. The
          imported P6 snapshot, undated plans, and current reviewed knowledge do
          not establish what was known on that day.
        </p>
        <p>
          Source citations stay within this replay’s selected excerpts. Opening
          full project files or live memory leaves the replay.
        </p>
        <p>
          Each new replay captures the current applicable reviewed notes.
          Retrying a start keeps the same saved result.
        </p>
      </div>
      <div className="tr-action-row" aria-busy={action.busy}>
        <button
          type="button"
          className="tk-button tk-primary"
          onClick={() => void action.run()}
          disabled={action.busy || !status?.imported}
        >
          {action.busy ? (
            <LoaderCircle
              size={15}
              className="animate-spin"
              aria-hidden="true"
            />
          ) : (
            <Play size={15} aria-hidden="true" />
          )}
          {action.busy ? "Saving initial replay…" : "Start with July 14"}
        </button>
        <span className="tk-scope">
          The next reports are revealed only when you advance.
        </span>
      </div>
      {action.error ? <ReplayError message={action.error} /> : null}
      {error ? (
        <ReplayError message={error} retry={retry} />
      ) : !status ? (
        <Pending>Checking project evidence…</Pending>
      ) : !status.imported ? (
        <div className="tk-evidence-state">
          <BookOpen size={18} aria-hidden="true" />
          <div>
            <h3>Project evidence is not available yet</h3>
            <p>
              An administrator needs to connect and import the project data.
            </p>
            <button type="button" className="tk-text-button" onClick={retry}>
              Check again
            </button>
          </div>
        </div>
      ) : null}
      <SavedReplayHistory />
    </ReplayFrame>
  );
}

export function SavedReplay({ id }: { id: string }) {
  const { viewer } = useChatShell();
  const { data, error, retry } = useProjectJson<{ investigation: CaseReplay }>(
    `/api/tomok/replays/${encodeURIComponent(id)}`,
    viewer?.id ?? "",
  );
  const action = useReplayAction(
    `/api/tomok/replays/${encodeURIComponent(id)}/advance`,
    viewer?.id ?? "",
  );
  const result = data?.investigation;
  return (
    <ReplayFrame>
      <Link href="/replays" className="tk-back-link">
        <ArrowLeft size={13} aria-hidden="true" />
        Case replay
      </Link>
      {action.error ? <ReplayError message={action.error} /> : null}
      {error ? (
        <ReplayError message={error} retry={retry} />
      ) : !result ? (
        <Pending>Opening saved replay…</Pending>
      ) : (
        <>
          <StartReplayChat replayId={result.id} />
          <SavedReplayChats replayId={result.id} />
          <ReplayResult
            result={result}
            advance={
              result.replay.stage === "initial" ? (
                <div className="tr-advance" aria-busy={action.busy}>
                  <div>
                    <h3>Ready for the next reports?</h3>
                    <p>
                      This result stays saved. Advancing creates a separate
                      reassessment with the later evidence.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="tk-button tk-primary"
                    disabled={action.busy}
                    onClick={() => void action.run()}
                  >
                    {action.busy ? (
                      <LoaderCircle
                        size={15}
                        className="animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <ArrowRight size={15} aria-hidden="true" />
                    )}
                    {action.busy
                      ? "Reassessing…"
                      : "Reveal July 15–16 and reassess"}
                  </button>
                </div>
              ) : null
            }
          />
        </>
      )}
    </ReplayFrame>
  );
}
