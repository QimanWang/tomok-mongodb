"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { MemoryContent } from "@/lib/tomok/memory-types";
import { memoryDate, type MemoryEvidence } from "./memory-shared";

export function memoryContentIssue(content: MemoryContent) {
  if (!content.title.trim()) return "Add a title for this note.";
  if (!content.statement.trim())
    return "Write the mapping or explanation you want to save.";
  if (!content.validFrom)
    return "Choose the first reporting date this note applies to.";
  if (content.validThrough && content.validThrough < content.validFrom)
    return "The end date must be on or after the start date.";
  if (!content.evidenceIds.length)
    return "Select at least one supporting evidence record.";
  if (content.evidenceIds.length > 10)
    return "Select no more than ten supporting evidence records.";
}

export function MemoryContentFields({
  value,
  onChange,
  evidence,
  disabled,
  prefix,
}: {
  value: MemoryContent;
  onChange: (content: MemoryContent) => void;
  evidence: MemoryEvidence[];
  disabled?: boolean;
  prefix: string;
}) {
  function update<K extends keyof MemoryContent>(
    key: K,
    next: MemoryContent[K],
  ) {
    onChange({ ...value, [key]: next });
  }
  return (
    <fieldset className="tm-content-fields" disabled={disabled}>
      <div className="tm-field">
        <label htmlFor={`${prefix}-kind`}>Note type</label>
        <select
          id={`${prefix}-kind`}
          value={value.kind}
          onChange={(event) =>
            update("kind", event.target.value as MemoryContent["kind"])
          }
        >
          <option value="mapping">Field-to-schedule mapping</option>
          <option value="interpretation">Evidence interpretation</option>
        </select>
      </div>
      <div className="tm-field">
        <label htmlFor={`${prefix}-title`}>Title</label>
        <input
          id={`${prefix}-title`}
          required
          maxLength={120}
          value={value.title}
          onChange={(event) => update("title", event.target.value)}
          placeholder="A short description of this project note"
          autoComplete="off"
        />
      </div>
      <div className="tm-field">
        <label htmlFor={`${prefix}-statement`}>Your note</label>
        <textarea
          id={`${prefix}-statement`}
          required
          maxLength={2000}
          rows={5}
          value={value.statement}
          onChange={(event) => update("statement", event.target.value)}
          placeholder="Describe the mapping or explanation for review."
          aria-describedby={`${prefix}-statement-help`}
        />
        <p id={`${prefix}-statement-help`}>
          Write what the evidence supports and include any conditions.{" "}
          {value.statement.length.toLocaleString("en-US")} / 2,000 characters.
        </p>
      </div>
      <div className="tm-date-fields">
        <div className="tm-field">
          <label htmlFor={`${prefix}-from`}>Applies from</label>
          <input
            id={`${prefix}-from`}
            type="date"
            required
            value={value.validFrom}
            onChange={(event) => update("validFrom", event.target.value)}
          />
        </div>
        <div className="tm-field">
          <label htmlFor={`${prefix}-through`}>
            Applies through <span>Optional</span>
          </label>
          <input
            id={`${prefix}-through`}
            type="date"
            min={value.validFrom || undefined}
            value={value.validThrough ?? ""}
            onChange={(event) =>
              update("validThrough", event.target.value || null)
            }
          />
          <p>Leave empty if ongoing.</p>
        </div>
      </div>
      <fieldset className="tm-evidence-picker">
        <legend>
          Supporting evidence{" "}
          <span>{value.evidenceIds.length} / 10 selected</span>
        </legend>
        <p className="tm-help">
          Select the exact records that support this note. Their links will be
          saved with this revision. Sources are limited to the original
          investigation’s reporting date. For later evidence, create a note from
          a new investigation.
        </p>
        {evidence.length === 0 ? (
          <p className="tm-help">
            No supporting records are available for this note.
          </p>
        ) : (
          evidence.map((item) => {
            const checked = value.evidenceIds.includes(item.id);
            return (
              <div className="tm-evidence-option" key={item.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={
                      disabled || (!checked && value.evidenceIds.length >= 10)
                    }
                    onChange={(event) =>
                      update(
                        "evidenceIds",
                        event.target.checked
                          ? [...value.evidenceIds, item.id]
                          : value.evidenceIds.filter((id) => id !== item.id),
                      )
                    }
                  />
                  <span>
                    <strong>{item.label}</strong>
                    <small>
                      {item.observedDate
                        ? memoryDate(item.observedDate)
                        : "Undated context"}
                    </small>
                  </span>
                </label>
                <Link
                  href={item.href}
                  prefetch={false}
                  className="tm-source-link"
                  aria-label={`Open source: ${item.label}`}
                >
                  <ArrowUpRight size={14} aria-hidden="true" />
                  Source
                </Link>
                <details>
                  <summary>Read extracted text</summary>
                  <p>{item.text}</p>
                </details>
              </div>
            );
          })
        )}
      </fieldset>
    </fieldset>
  );
}
