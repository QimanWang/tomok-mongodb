"use client";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
export function Loading({
  children = "Opening source file…",
}: {
  children?: React.ReactNode;
}) {
  return (
    <div className="pf-state" role="status">
      <LoaderCircle size={22} className="animate-spin" />
      <span>{children}</span>
    </div>
  );
}
export function Failure({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <div className="pf-state" role="alert">
      <TriangleAlert size={22} />
      <p>{message}</p>
      {retry && (
        <button className="pf-button" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}
export async function checkedFetch(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(
      body?.error ?? `Unable to open this file (${response.status}).`,
    );
  }
  return response;
}
export function useJson<T>(url: string, reload = "") {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({});
    checkedFetch(url, controller.signal)
      .then((response) => response.json())
      .then((data) => {
        if (!controller.signal.aborted) setState({ data });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setState({ error: error.message });
      });
    return () => controller.abort();
  }, [url, reload, attempt]);
  return { ...state, retry: () => setAttempt((value) => value + 1) };
}
export function updateLocation(values: Record<string, string | null>) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(values)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  window.history.replaceState(null, "", url);
}
