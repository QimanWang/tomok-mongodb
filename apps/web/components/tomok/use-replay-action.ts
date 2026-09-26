"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export function useReplayAction(endpoint: string, viewerId: string) {
  const router = useRouter();
  const request = useRef<AbortController | null>(null);
  const replayRequestId = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    request.current?.abort();
    request.current = null;
    replayRequestId.current = null;
    setBusy(false);
    setError(undefined);
    return () => {
      const pending = request.current;
      request.current = null;
      replayRequestId.current = null;
      pending?.abort();
    };
  }, [endpoint, viewerId]);

  async function run() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      if (endpoint === "/api/tomok/replays" && !replayRequestId.current) {
        replayRequestId.current = crypto.randomUUID();
      }
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(endpoint === "/api/tomok/replays" ? { requestId: replayRequestId.current } : {}),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? "Unable to save this replay. Please try again.");
      if (typeof body?.investigation?.id !== "string" || !/^[a-f0-9]{32}$/.test(body.investigation.id))
        throw new Error("The replay was not returned. Please try again.");
      if (controller.signal.aborted || request.current !== controller) return;
      router.push(`/replays/${body.investigation.id}`);
    } catch (cause) {
      if (controller.signal.aborted || request.current !== controller) return;
      request.current = null;
      setBusy(false);
      setError(cause instanceof Error ? cause.message : "Unable to complete this replay.");
    }
  }

  return { busy, error, run };
}
