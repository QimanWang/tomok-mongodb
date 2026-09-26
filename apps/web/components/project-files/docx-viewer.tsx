"use client";
import { useEffect, useRef, useState } from "react";
import type { ProjectFile } from "@/lib/project-files/types";
import { checkedFetch, Failure, Loading } from "./shared";
export default function DocxViewer({ file }: { file: ProjectFile }) {
  const container = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(true);
  const [scale, setScale] = useState(1);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    const element = container.current;
    async function render() {
      const [response, { renderAsync }] = await Promise.all([
        checkedFetch(
          `/api/project-files/${file.id}/content`,
          controller.signal,
        ),
        import("docx-preview"),
      ]);
      const bytes = await response.arrayBuffer();
      if (!element || controller.signal.aborted) return;
      await renderAsync(bytes, element, element, {
        className: "tomok-docx",
        breakPages: true,
        ignoreLastRenderedPageBreak: false,
        renderAltChunks: false,
        renderComments: false,
        renderEndnotes: true,
        renderFootnotes: true,
        renderHeaders: true,
        renderFooters: true,
        useBase64URL: true,
      });
      if (controller.signal.aborted) return;
      element
        .querySelectorAll<HTMLAnchorElement>("a[href]")
        .forEach((anchor) => {
          const href = anchor.getAttribute("href") ?? "";
          if (!/^(https?:|mailto:|tel:|#)/i.test(href.trim()))
            anchor.removeAttribute("href");
          else {
            anchor.target = "_blank";
            anchor.rel = "noopener noreferrer";
          }
        });
      setLoading(false);
    }
    render().catch((error) => {
      if (!controller.signal.aborted) {
        setError(error.message);
        setLoading(false);
      }
    });
    return () => {
      controller.abort();
      element?.replaceChildren();
    };
  }, [file.id]);
  useEffect(() => {
    const element = frame.current;
    if (!element || loading) return;
    const resize = () => {
      const page =
        container.current?.querySelector<HTMLElement>("section.tomok-docx");
      if (page)
        setScale(
          fit
            ? Math.min(1, (element.clientWidth - 24) / (page.offsetWidth + 48))
            : 1,
        );
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    return () => observer.disconnect();
  }, [loading, fit]);
  return (
    <div className="pf-docx">
      <div className="pf-toolbar">
        <button
          className="pf-button"
          aria-pressed={fit}
          onClick={() => setFit(true)}
        >
          Fit width
        </button>
        <button
          className="pf-button"
          aria-pressed={!fit}
          onClick={() => setFit(false)}
        >
          Original size
        </button>
        <span className="pf-muted">{Math.round(scale * 100)}%</span>
      </div>
      <div className="pf-docx-scroll" ref={frame}>
        {loading && <Loading>Rendering document…</Loading>}
        {error && <Failure message={error} />}
        <div
          className="pf-docx-pages"
          ref={container}
          style={{ zoom: scale }}
        />
        <div className="pf-note">
          Document preview. Download the original for Word’s exact pagination.
        </div>
      </div>
    </div>
  );
}
