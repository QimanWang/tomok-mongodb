"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import {
  Download,
  FileChartColumn,
  FileText,
  Files,
  PanelLeftClose,
  Search,
  Sheet,
  Link as LinkIcon,
} from "lucide-react";
import { useChatShell } from "@/app/_components/chat-shell-context";
import type { ProjectFile } from "@/lib/project-files/types";
import { Failure, Loading, updateLocation, useJson } from "./shared";
import "./workspace.css";
const ScheduleViewer = dynamic(() => import("./schedule-viewer"), {
  loading: () => <Loading>Reading P6 schedule…</Loading>,
  ssr: false,
});
const WorkbookViewer = dynamic(() => import("./workbook-viewer"), {
  loading: () => <Loading>Opening workbook…</Loading>,
  ssr: false,
});
const PdfViewer = dynamic(() => import("./pdf-viewer"), {
  loading: () => <Loading>Opening PDF…</Loading>,
  ssr: false,
});
const DocxViewer = dynamic(() => import("./docx-viewer"), {
  loading: () => <Loading>Opening document…</Loading>,
  ssr: false,
});
const icons = {
  xer: FileChartColumn,
  xlsx: Sheet,
  pdf: FileText,
  docx: FileText,
};
export function FilesWorkspace() {
  const params = useSearchParams();
  const { viewer, requestSignIn } = useChatShell();
  const { data, error, retry } = useJson<{
    project: string;
    files: ProjectFile[];
  }>("/api/project-files", viewer?.id ?? "");
  const [filter, setFilter] = useState("");
  const [listOpen, setListOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const selectedId = params.get("file");
  const file =
    data?.files.find((file) => file.id === selectedId) ??
    (!selectedId ? data?.files[0] : undefined);
  function choose(file: ProjectFile) {
    updateLocation({
      file: file.id,
      activity: null,
      sheet: null,
      cell: null,
      page: null,
    });
    if (window.innerWidth < 700) setListOpen(false);
  }
  return (
    <section className="pf-workspace" aria-label="Tomok project files">
      <header className="pf-project-header">
        <div className="pf-project-mark">T</div>
        <div>
          <div className="pf-eyebrow">TOMOK / PROJECT CONTROLS</div>
          <h1>Frederick Douglass Tunnel</h1>
        </div>
        <span className="pf-badge pf-local">Local project</span>
      </header>
      <div className="pf-workspace-body">
        {listOpen && (
          <aside className="pf-file-list" aria-label="Project files">
            <div className="pf-list-heading">
              <strong>Project files</strong>
              <span className="pf-count">{data?.files.length ?? "—"}</span>
              <button
                className="pf-icon-button"
                aria-label="Hide file list"
                onClick={() => setListOpen(false)}
              >
                <PanelLeftClose size={16} />
              </button>
            </div>
            <label className="pf-search">
              <Search size={15} />
              <input
                aria-label="Search files"
                placeholder="Find a file…"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            </label>
            <div className="pf-file-items">
              {data?.files
                .filter((file) =>
                  `${file.name} ${file.title}`
                    .toLowerCase()
                    .includes(filter.toLowerCase()),
                )
                .map((item) => {
                  const Icon = icons[item.kind];
                  return (
                    <button
                      className={`pf-file-item ${item.id === file?.id ? "selected" : ""}`}
                      key={item.id}
                      onClick={() => choose(item)}
                      aria-current={item.id === file?.id ? "true" : undefined}
                      title={item.name}
                    >
                      <Icon size={19} />
                      <span>
                        <strong>{item.title}</strong>
                        <small>
                          {item.kind.toUpperCase()} <span>·</span>{" "}
                          {size(item.bytes)}
                          {item.pages ? ` · ${item.pages} pages` : ""}
                        </small>
                      </span>
                    </button>
                  );
                })}
              {data &&
                !data.files.some((file) =>
                  `${file.name} ${file.title}`
                    .toLowerCase()
                    .includes(filter.toLowerCase()),
                ) && <p className="pf-note">No matching files.</p>}
            </div>
            <div className="pf-list-footer">
              <span className="pf-dot" /> Eight original project sources
              <small>Read-only · verified when opened</small>
            </div>
          </aside>
        )}
        <main className="pf-file-main">
          {!data ? (
            error ? (
              <div className="pf-state">
                <Failure message={error} retry={retry} />
                {!viewer && (
                  <button className="pf-button" onClick={() => requestSignIn()}>
                    Sign in
                  </button>
                )}
              </div>
            ) : (
              <Loading>Loading project files…</Loading>
            )
          ) : !file ? (
            <Failure message="This source version is not in the project. Select a file from the list." />
          ) : (
            <>
              <div className="pf-document-header">
                {!listOpen && (
                  <button
                    className="pf-icon-button"
                    aria-label="Show file list"
                    onClick={() => setListOpen(true)}
                  >
                    <Files size={18} />
                  </button>
                )}
                <div className="pf-document-title">
                  <h2>{file.title}</h2>
                  <p title={file.name}>{file.name}</p>
                </div>
                <div className="pf-document-actions">
                  <Link
                    className="pf-button"
                    href={`/investigations?${new URLSearchParams({
                      source: file.id,
                      ...(params.get("activity")
                        ? { activity: params.get("activity")! }
                        : {}),
                    }).toString()}`}
                    title="Investigate South Portal jet grouting across the project records"
                  >
                    Jet-grout investigation
                  </Link>
                  <span className="pf-badge">Read-only</span>
                  <button
                    className="pf-icon-button"
                    title={copied ? "Link copied" : "Copy link to this view"}
                    aria-label={
                      copied ? "Link copied" : "Copy link to this view"
                    }
                    onClick={async () => {
                      updateLocation({ file: file.id });
                      try {
                        await navigator.clipboard.writeText(
                          window.location.href,
                        );
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      } catch {
                        setCopied(false);
                      }
                    }}
                  >
                    <LinkIcon size={16} />
                  </button>
                  <a
                    className="pf-icon-button"
                    aria-label="Download original"
                    title="Download original"
                    href={`/api/project-files/${file.id}/content?download`}
                  >
                    <Download size={16} />
                  </a>
                </div>
              </div>
              <div className="pf-viewer" key={file.id}>
                {file.kind === "xer" ? (
                  <ScheduleViewer file={file} />
                ) : file.kind === "xlsx" ? (
                  <WorkbookViewer file={file} />
                ) : file.kind === "pdf" ? (
                  <PdfViewer file={file} />
                ) : (
                  <DocxViewer file={file} />
                )}
              </div>
              <footer className="pf-source-footer">
                <span>
                  Original source · SHA-256 {file.sha256.slice(0, 12)}
                </span>
                <span>No source edits</span>
              </footer>
            </>
          )}
        </main>
      </div>
    </section>
  );
}
function size(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
