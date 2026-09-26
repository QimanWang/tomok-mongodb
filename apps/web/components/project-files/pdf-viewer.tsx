"use client";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";
import type { ProjectFile } from "@/lib/project-files/types";
import { Failure, Loading, updateLocation } from "./shared";
export default function PdfViewer({ file }: { file: ProjectFile }) {
  const params = useSearchParams();
  const requested = Number(params.get("page") || "1");
  const [document, setDocument] = useState<PDFDocumentProxy>();
  const [error, setError] = useState("");
  const [rendering, setRendering] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [text, setText] = useState("");
  const [showText, setShowText] = useState(false);
  const page = Math.max(
    1,
    Math.min(
      document?.numPages ?? file.pages ?? 1,
      Number.isFinite(requested) ? Math.floor(requested) : 1,
    ),
  );
  const canvasRef = useRef<HTMLCanvasElement>(null),
    containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    let active = true,
      task: ReturnType<typeof import("pdfjs-dist").getDocument> | undefined;
    import("pdfjs-dist")
      .then((pdfjs) => {
        if (!active) return;
        pdfjs.GlobalWorkerOptions.workerSrc = `/api/pdf-worker?v=${pdfjs.version}`;
        task = pdfjs.getDocument({
          url: `/api/project-files/${file.id}/content`,
          withCredentials: true,
          disableAutoFetch: true,
          disableStream: true,
          enableXfa: false,
        });
        return task.promise.then((document) => {
          if (active) setDocument(document);
        });
      })
      .catch((error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
      if (task) void task.destroy();
    };
  }, [file.id]);
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) =>
      setWidth(Math.max(240, entries[0].contentRect.width - 48)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!document) return;
    let active = true,
      task: RenderTask | undefined;
    setRendering(true);
    setText("");
    setError("");
    async function render() {
      const pdfPage = await document!.getPage(page);
      const canvas = canvasRef.current;
      if (!active || !canvas) return;
      const original = pdfPage.getViewport({ scale: 1 });
      const scale = Math.min(width / original.width, 1.5) * zoom;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = pdfPage.getViewport({ scale: scale * ratio });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = `${viewport.width / ratio}px`;
      canvas.style.height = `${viewport.height / ratio}px`;
      task = pdfPage.render({ canvas, viewport });
      await task.promise;
      if (active) setRendering(false);
      const content = await pdfPage.getTextContent();
      if (active)
        setText(
          content.items
            .map((item) =>
              "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
            )
            .join(""),
        );
    }
    render().catch((error) => {
      if (active && error.name !== "RenderingCancelledException") {
        setRendering(false);
        setError(error.message);
      }
    });
    return () => {
      active = false;
      task?.cancel();
    };
  }, [document, page, zoom, width]);
  function go(page: number) {
    updateLocation({ file: file.id, page: String(page) });
  }
  return (
    <div className="pf-pdf">
      <div className="pf-toolbar">
        <button
          className="pf-icon-button"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => go(page - 1)}
        >
          <ChevronLeft size={17} />
        </button>
        <label className="pf-control">
          Page
          <input
            className="pf-page-input"
            aria-label="PDF page"
            type="number"
            min={1}
            max={document?.numPages ?? file.pages}
            value={page}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (value >= 1) go(value);
            }}
          />
        </label>
        <span className="pf-muted">
          of {document?.numPages ?? file.pages ?? "—"}
        </span>
        <button
          className="pf-icon-button"
          aria-label="Next page"
          disabled={page >= (document?.numPages ?? file.pages ?? 1)}
          onClick={() => go(page + 1)}
        >
          <ChevronRight size={17} />
        </button>
        <span className="pf-toolbar-divider" />
        <button
          className="pf-icon-button"
          aria-label="Zoom out"
          disabled={zoom <= 0.5}
          onClick={() => setZoom((value) => value - 0.25)}
        >
          <Minus size={16} />
        </button>
        <button className="pf-button" onClick={() => setZoom(1)}>
          {Math.round(zoom * 100)}% fit
        </button>
        <button
          className="pf-icon-button"
          aria-label="Zoom in"
          disabled={zoom >= 2}
          onClick={() => setZoom((value) => value + 0.25)}
        >
          <Plus size={16} />
        </button>
        <button
          className="pf-button"
          aria-pressed={showText}
          onClick={() => setShowText((value) => !value)}
        >
          Page text
        </button>
      </div>
      <div className="pf-pdf-scroll" ref={containerRef}>
        {error ? (
          <Failure message={error} />
        ) : (
          <>
            {rendering && (
              <div className="pf-render-status" role="status">
                Rendering page {page}…
              </div>
            )}
            <canvas
              ref={canvasRef}
              aria-label={`Original PDF, page ${page}`}
              style={{ visibility: rendering ? "hidden" : "visible" }}
            />
            {showText && (
              <pre className="pf-pdf-text">
                {text ||
                  (rendering
                    ? "Loading page text…"
                    : "No embedded text on this page.")}
              </pre>
            )}
          </>
        )}
      </div>
      {!document && !error && <Loading>Loading PDF pages…</Loading>}
    </div>
  );
}
