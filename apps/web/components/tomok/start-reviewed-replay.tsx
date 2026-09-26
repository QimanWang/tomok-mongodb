"use client";

import { LoaderCircle, Play } from "lucide-react";
import { useChatShell } from "@/app/_components/chat-shell-context";
import { useReplayAction } from "./use-replay-action";

export function StartReviewedReplay({ originCutoff }: { originCutoff?: string }) {
  const { viewer } = useChatShell();
  const action = useReplayAction("/api/tomok/replays", viewer?.id ?? "");
  return (
    <section className="tm-replay-handoff" aria-label="Use reviewed notes in a new replay">
      <h3>Use the current review in a fresh conversation</h3>
      <p>
        Start a new July 14 stage to capture the notes that apply to it, then open its fresh chat.
        Existing stages and conversations keep their saved revisions.
      </p>
      {originCutoff && originCutoff > "2026-07-14" ? (
        <p>This note comes from later evidence. Reveal July 15–16 in the new replay to include it if its scope and dates apply.</p>
      ) : null}
      <button className="tk-button tk-primary" type="button" disabled={action.busy} onClick={() => void action.run()}>
        {action.busy ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
        {action.busy ? "Saving new replay…" : "Start a new replay with current reviewed notes"}
      </button>
      {action.error ? <p className="tm-validation" role="alert">{action.error}</p> : null}
    </section>
  );
}
