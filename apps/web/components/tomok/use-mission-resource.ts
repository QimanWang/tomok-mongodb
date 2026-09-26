"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type ResourceState<T> = { key: string; data?: T; error?: string; refreshing: boolean };

export function useMissionResource<T>(
  url: string,
  viewerId: string,
  shouldPoll?: (data: T) => boolean,
) {
  const key = `${viewerId}:${url}`;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ResourceState<T>>();
  const latest = useRef<{ key: string; data: T } | undefined>(undefined);
  const refresh = useCallback(() => setAttempt(value => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let data = latest.current?.key === key ? latest.current.data : undefined;

    async function load() {
      setState({ key, data, refreshing: true });
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        const body = await response.json().catch(() => null);
        if (controller.signal.aborted) return;
        if (!response.ok) {
          if ([401, 403, 404].includes(response.status)) {
            data = undefined;
            latest.current = undefined;
          }
          throw new Error(body?.error ?? "Unable to load this mission. Please try again.");
        }
        if (!body) throw new Error("The mission response was empty. Please try again.");
        if (controller.signal.aborted) return;
        data = body as T;
        latest.current = { key, data };
        failures = 0;
        setState({ key, data, refreshing: false });
      } catch (cause) {
        if (controller.signal.aborted) return;
        failures += 1;
        setState({
          key, data, refreshing: false,
          error: cause instanceof Error ? cause.message : "Unable to load this mission.",
        });
      }
      if (!controller.signal.aborted && data && shouldPoll?.(data)) {
        timer = setTimeout(() => void load(), Math.min(30_000, 4_000 * (failures + 1)));
      }
    }

    void load();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [attempt, key, shouldPoll, url]);

  return {
    data: state?.key === key ? state.data : undefined,
    error: state?.key === key ? state.error : undefined,
    refreshing: state?.key === key ? state.refreshing : true,
    refresh,
  };
}

export function useMissionAction(viewerId: string) {
  const pending = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setBusy(false);
    setError(undefined);
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [viewerId]);

  async function run<T>(url: string, body: unknown): Promise<T | undefined> {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: controller.signal,
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error ?? "Unable to update this mission. Please try again.");
      if (!result) throw new Error("The mission response was empty. Please try again.");
      if (controller.signal.aborted || pending.current !== controller) return;
      return result as T;
    } catch (cause) {
      if (controller.signal.aborted || pending.current !== controller) return;
      setError(cause instanceof Error ? cause.message : "Unable to update this mission.");
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  return { busy, error, run };
}
