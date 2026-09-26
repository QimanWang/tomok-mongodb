"use client";

import { useEveAgent } from "eve/react";
import { Client, type SessionSnapshot } from "eve/client";
import { ArrowLeft, LoaderCircle, MessageSquare, Square, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useChatShell } from "@/app/_components/chat-shell-context";
import { ChatComposer } from "@/components/chat/composer";
import { ChatConversation, ChatConversationContent, ChatScrollButton } from "@/components/chat/conversation";
import { AgentMessage, type AgentInputResponse } from "@/components/chat/message";
import { useProjectJson } from "./use-project-json";
import type { ReplayChatDescriptor } from "@/lib/tomok/replay-types";
import "./investigation.css";
import "./replay.css";

type ReplayChat = ReplayChatDescriptor;

export function StartReplayChat({ replayId }: { replayId: string }) {
  const { viewer } = useChatShell();
  const router = useRouter();
  const requestId = useRef<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    requestId.current = null;
    setBusy(false);
    setError(undefined);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [replayId, viewer?.id]);

  async function start() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    requestId.current ??= crypto.randomUUID();
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/tomok/replays/${encodeURIComponent(replayId)}/chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: requestId.current }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? "Unable to start this replay chat. Please try again.");
      if (typeof body?.sessionId !== "string" || body.replayId !== replayId)
        throw new Error("The replay chat was not returned. Please try again.");
      if (controller.signal.aborted || request.current !== controller) return;
      router.push(`/replays/${encodeURIComponent(replayId)}/chat/${encodeURIComponent(body.sessionId)}`);
    } catch (cause) {
      if (controller.signal.aborted || request.current !== controller) return;
      request.current = null;
      setBusy(false);
      setError(cause instanceof Error ? cause.message : "Unable to start this replay chat.");
    }
  }

  return (
    <div className="tr-chat-start">
      <div className="tr-action-row" aria-busy={busy}>
        <button type="button" className="tk-button" disabled={busy} onClick={() => void start()}>
          {busy ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> : <MessageSquare size={15} aria-hidden="true" />}
          {busy ? "Opening replay chat…" : "Discuss this stage in a fresh chat"}
        </button>
        <span className="tk-scope">Uses this saved stage’s excerpts and reviewed notes.</span>
      </div>
      {error ? <p className="tk-error" role="alert">{error}</p> : null}
    </div>
  );
}

export function ReplayChatWorkspace({ replayId, sessionId }: { replayId: string; sessionId: string }) {
  const { viewer, requestSignIn } = useChatShell();
  const { data, error, retry } = useProjectJson<ReplayChat>(
    `/api/tomok/replays/${encodeURIComponent(replayId)}/chats/${encodeURIComponent(sessionId)}`,
    viewer?.id ?? "",
  );
  const verified = data?.sessionId === sessionId && data.replayId === replayId;

  return (
    <section className="tk-investigation tr-replay tr-chat" aria-label="Replay chat">
      <header className="tk-project-header">
        <span className="tk-project-mark" aria-hidden="true">T</span>
        <div>
          <p className="tk-eyebrow">TOMOK / REPLAY CHAT</p>
          <h1>{verified ? data.label : "Saved stage conversation"}</h1>
        </div>
        <Link href={`/replays/${encodeURIComponent(replayId)}`} className="tk-back-link tr-chat-back">
          <ArrowLeft size={13} aria-hidden="true" />
          Saved excerpts
        </Link>
      </header>
      {error || (data && !verified) ? (
        <div className="tr-chat-load-error tk-error" role="alert">
          <TriangleAlert size={18} aria-hidden="true" />
          <div>
            <p>{error ?? "This chat does not belong to the saved replay."}</p>
            <div className="tk-error-actions">
              <button type="button" className="tk-button" onClick={retry}>Try again</button>
              {!viewer ? <button type="button" className="tk-button" onClick={() => requestSignIn()}>Sign in</button> : null}
            </div>
          </div>
        </div>
      ) : verified ? (
        <RestoreReplayConversation key={`${viewer?.id ?? ""}:${sessionId}`} chat={data} />
      ) : (
        <p className="tk-status tr-chat-load-error" role="status">
          <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
          Opening replay chat…
        </p>
      )}
    </section>
  );
}

function RestoreReplayConversation({ chat }: { chat: ReplayChat }) {
  const [snapshot, setSnapshot] = useState<SessionSnapshot>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setError(undefined);
    const session = new Client({ host: "" }).sessions.attach(chat.sessionId);
    void session.snapshot({ signal: controller.signal }).then(
      saved => { if (!controller.signal.aborted) setSnapshot(saved); },
      cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to restore this conversation."); },
    );
    return () => controller.abort();
  }, [chat.sessionId, attempt]);

  function reconnect() {
    setSnapshot(undefined);
    setAttempt(value => value + 1);
  }
  if (snapshot) return <ReplayConversation chat={chat} snapshot={snapshot} draft={draft} setDraft={setDraft} reconnect={reconnect} />;
  return <div className="tr-chat-load-error" role={error ? "alert" : "status"}>
    <p>{error ?? "Restoring saved messages…"}</p>
    {error ? <button className="tk-button" type="button" onClick={() => setAttempt(value => value + 1)}>Try again</button> : null}
  </div>;
}

function ReplayConversation({ chat, snapshot, draft, setDraft, reconnect }: {
  chat: ReplayChat;
  snapshot: SessionSnapshot;
  draft: string;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  reconnect: () => void;
}) {
  const submittedText = useRef<string | null>(null);
  // Reduce the bounded historical snapshot before subscribing React to live
  // events. A long catch-up stream otherwise renders once per historical delta.
  const agent = useEveAgent({
    initialSession: snapshot.session,
    initialEvents: snapshot.events,
    resume: true,
    onError() {
      // eve reports transport failures through onError even when send resolves.
      const text = submittedText.current;
      if (text) setDraft(current => current || text);
    },
  });
  const [actionError, setActionError] = useState<string>();
  const [stopping, setStopping] = useState(false);
  const isBusy = agent.status === "submitted" || agent.status === "streaming";
  const isResuming = agent.status === "resuming";
  const pendingInput = agent.data.messages.some(message => message.parts.some(part => part.type === "dynamic-tool" && part.state === "approval-requested"));
  const pendingAuthorization = agent.data.messages.some(message => message.parts.some(part => part.type === "authorization" && part.state === "required"));
  const error = actionError ?? agent.error?.message;
  const lastMessage = agent.data.messages.at(-1);
  const awaitingAssistant = isBusy && (!lastMessage || lastMessage.role === "user");
  const suggestion = "What can we conclude about jet grouting from this stage, and what remains uncertain?";

  async function run(action: () => Promise<unknown>) {
    setActionError(undefined);
    try {
      await action();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Unable to continue this replay chat.");
    }
  }

  async function send(text: string) {
    if (isBusy || isResuming || pendingInput || pendingAuthorization) return;
    submittedText.current = text;
    setActionError(undefined);
    setDraft("");
    try {
      await agent.send(text);
    } catch (cause) {
      setDraft(current => current || text);
      setActionError(cause instanceof Error ? cause.message : "Unable to send this question.");
    } finally {
      submittedText.current = null;
    }
  }

  async function stop() {
    if (stopping) return;
    setStopping(true);
    await run(() => agent.cancel());
    setStopping(false);
  }

  async function respond(responses: readonly AgentInputResponse[]) {
    await run(() => agent.respond(responses));
  }

  return (
    <>
      <div className="tr-chat-scope">
        <span>Reports through <strong>{chat.cutoff}</strong></span>
        <span>Saved excerpts and reviewed notes stay fixed for this conversation.</span>
      </div>
      <ChatConversation aria-label="Replay conversation">
        <ChatConversationContent className="tr-chat-messages">
          {agent.data.messages.length === 0 && !isResuming ? (
            <div className="tr-chat-empty">
              <h2>Discuss the saved evidence</h2>
              <p>Ask about the findings, their source excerpts, or the questions this stage leaves open.</p>
              <button type="button" className="tr-chat-suggestion" disabled={isBusy} onClick={() => setDraft(suggestion)}>{suggestion}</button>
            </div>
          ) : null}
          {agent.data.messages.map(message => (
            <AgentMessage key={message.id} message={message} isStreaming={isBusy && message.metadata?.status === "streaming"} canRespond={!isBusy && !isResuming} onInputResponses={respond} />
          ))}
          {isResuming || awaitingAssistant ? (
            <p className="tr-chat-status" role="status"><LoaderCircle size={14} className="animate-spin" aria-hidden="true" />{isResuming ? "Resuming conversation…" : "Reviewing this stage…"}</p>
          ) : null}
        </ChatConversationContent>
        <ChatScrollButton />
      </ChatConversation>
      <div className="tr-chat-composer">
        {error ? (
          <div className="tr-chat-error" role="alert">
            <p>{error}</p>
            <button type="button" className="tk-text-button" disabled={isBusy || isResuming} onClick={reconnect}>Resume connection</button>
            <span> Reconnect to check for a saved reply before sending again.</span>
          </div>
        ) : null}
        {pendingAuthorization ? <p className="tr-chat-error" role="alert">External connections are unavailable in this replay. Return to the saved excerpts to start a fresh chat.</p> : null}
        <ChatComposer
          value={draft}
          onChange={setDraft}
          onSubmit={send}
          onStop={() => void stop()}
          disabled={pendingInput || pendingAuthorization}
          disabledReason={pendingInput ? "Answer the pending request to continue." : pendingAuthorization ? "External connections are unavailable in replay chat." : isResuming ? "Restoring the saved conversation." : undefined}
          isBusy={isBusy}
          isPreparing={isResuming}
          placeholder="Ask about this saved stage…"
          footerStart={isBusy ? <button type="button" className="tr-chat-stop" disabled={stopping} onClick={() => void stop()}><Square size={11} aria-hidden="true" />{stopping ? "Stopping…" : "Stop response"}</button> : <span className="tr-chat-footer-note">Replay through {chat.cutoff}</span>}
        />
      </div>
    </>
  );
}
