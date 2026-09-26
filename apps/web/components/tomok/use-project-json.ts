"use client";

import { useEffect, useState } from "react";

export function useProjectJson<T>(url: string, viewerId: string) {
  const [attempt, setAttempt] = useState(0);
  const key = `${url}:${viewerId}:${attempt}`;
  const [state, setState] = useState<{
    key: string;
    data?: T;
    error?: string;
  }>();

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(url, {
          cache: "no-store",
          signal: controller.signal,
        });
        const body = await response.json().catch(() => null);
        if (!response.ok)
          throw new Error(
            body?.error ?? "Unable to load project evidence. Please try again.",
          );
        if (!body)
          throw new Error(
            "The project evidence response was empty. Please try again.",
          );
        if (!controller.signal.aborted) setState({ key, data: body });
      } catch (cause) {
        if (!controller.signal.aborted) {
          setState({
            key,
            error:
              cause instanceof Error
                ? cause.message
                : "Unable to load project evidence.",
          });
        }
      }
    }
    void load();
    return () => controller.abort();
  }, [url, key]);

  return {
    data: state?.key === key ? state.data : undefined,
    error: state?.key === key ? state.error : undefined,
    retry: () => setAttempt((value) => value + 1),
  };
}
