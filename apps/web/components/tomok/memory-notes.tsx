"use client";

import Link from "next/link";
import { ArrowUpRight, BookOpen } from "lucide-react";
import type { MemorySummary } from "@/lib/tomok/memory-service";
import { MemoryCitations, memoryDate, memoryTimestamp } from "./memory-shared";

export function ReviewedMemoryNotes({ notes }: { notes: MemorySummary[] }) {
  if (!notes.length) return null;
  return (
    <section
      className="tm-reviewed-notes"
      aria-labelledby="reviewed-notes-heading"
    >
      <div className="tk-group-heading">
        <BookOpen size={16} aria-hidden="true" />
        <h3 id="reviewed-notes-heading">Reviewed project notes</h3>
        <span>{notes.length}</span>
      </div>
      <p className="tk-group-description">
        Human-reviewed notes included when this investigation was saved. They
        complement the source findings and their limitations.
      </p>
      <ul>
        {notes.map((note) => (
          <li key={`${note.id}:${note.revision}`}>
            <h4>
              <Link href={note.href}>
                {note.title}
                <ArrowUpRight size={13} aria-hidden="true" />
              </Link>
            </h4>
            <p className="tm-reviewed-statement">{note.statement}</p>
            <div className="tm-note-meta">
              <span>
                {note.kind === "mapping"
                  ? "Field-to-schedule mapping"
                  : "Evidence interpretation"}
              </span>
              <span>
                {memoryDate(note.validFrom)} – {memoryDate(note.validThrough)}
              </span>
            </div>
            <p className="tm-review-attribution">
              Reviewed by <strong>{note.reviewedBy.name}</strong> ·{" "}
              {memoryTimestamp(note.reviewedAt)} · Revision {note.revision}
            </p>
            <MemoryCitations citations={note.citations} />
          </li>
        ))}
      </ul>
    </section>
  );
}
