"use client";

import { LoaderCircle, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useChatShell } from "@/app/_components/chat-shell-context";
import "./investigation.css";
import "./mission-workspace.css";

export function MissionFrame({ children }: { children: ReactNode }) {
  return (
    <section className="tk-investigation tmi-workspace" aria-label="Tomok archive missions">
      <header className="tk-project-header">
        <span className="tk-project-mark" aria-hidden="true">T</span>
        <div>
          <p className="tk-eyebrow">TOMOK / ARCHIVE MISSIONS</p>
          <h1>Frederick Douglass Tunnel</h1>
        </div>
      </header>
      <div className="tk-investigation-body">
        <div className="tk-content tmi-content">{children}</div>
      </div>
    </section>
  );
}

export function MissionPending({ children }: { children: ReactNode }) {
  return (
    <p className="tk-status" role="status">
      <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
      {children}
    </p>
  );
}

export function MissionError({ message, retry }: { message: string; retry?: () => void }) {
  const { viewer, requestSignIn } = useChatShell();
  return (
    <div className="tk-error" role="alert">
      <TriangleAlert size={18} aria-hidden="true" />
      <div>
        <p>{message}</p>
        <div className="tk-error-actions">
          {retry ? <button type="button" className="tk-button" onClick={retry}>Try again</button> : null}
          {!viewer ? <button type="button" className="tk-button" onClick={() => requestSignIn()}>Sign in</button> : null}
        </div>
      </div>
    </div>
  );
}

export function missionDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(date);
}
