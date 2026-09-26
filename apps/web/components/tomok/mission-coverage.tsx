"use client";

import Link from "next/link";
import { ArrowUpRight, Check, Circle, FileText } from "lucide-react";
import type { SourceManifest } from "@/lib/tomok/missions/source-units";

export type MissionUnitProgress = {
  unitId: string;
  status: "pending" | "running" | "committed" | "failed" | "excluded";
  detail?: string;
};

const unitStatusLabels = {
  pending: "Not processed",
  running: "Processing",
  committed: "Committed",
  failed: "Failed · unresolved",
  excluded: "Outside reporting cutoff",
};

export function MissionCoverage({ manifest, progress }: { manifest: SourceManifest; progress: MissionUnitProgress[] }) {
  const unitsById = new Map(progress.map(unit => [unit.unitId, unit]));
  const committed = manifest.units.filter(unit => unitsById.get(unit.id)?.status === "committed").length;
  const inScope = manifest.sources.filter(source => source.extraction === "in-scope").length;
  return (
    <section className="tmi-section" aria-labelledby="mission-coverage-heading">
      <div className="tmi-section-heading">
        <div>
          <h3 id="mission-coverage-heading">Source coverage</h3>
          <p>{manifest.sources.length} registered sources · {inScope} in this mission · {committed} of {manifest.units.length} ranges committed</p>
        </div>
        <span className="tmi-badge">Reports through {manifest.cutoff}</span>
      </div>
      <progress className="tmi-progress" value={committed} max={Math.max(manifest.units.length, 1)} aria-label="Source ranges committed" />
      <p className="tmi-caption">Coverage refers to the exact ranges below. Opening a file does not mark it as processed.</p>
      <ul className="tmi-sources">
        {manifest.sources.map(source => {
          const units = manifest.units.filter(unit => unit.sourceId === source.id);
          const completed = units.filter(unit => unitsById.get(unit.id)?.status === "committed").length;
          return (
            <li key={source.id}>
              <div className="tmi-source-heading">
                <FileText size={16} aria-hidden="true" />
                <div>
                  <Link href={source.href} prefetch={false}>{source.title}<ArrowUpRight size={12} aria-hidden="true" /></Link>
                  <p>{source.name}</p>
                </div>
                <span className="tmi-badge" data-tone={units.length && completed === units.length ? "complete" : undefined}>
                  {source.extraction === "inventory-only" ? "Inventory only · unprocessed" : `${completed}/${units.length} ranges committed`}
                </span>
              </div>
              {units.length ? (
                <details className="tmi-source-ranges">
                  <summary>Inspect {units.length} scoped {units.length === 1 ? "range" : "ranges"}</summary>
                  <ul>
                    {units.map(unit => {
                      const result = unitsById.get(unit.id);
                      const status = result?.status ?? "pending";
                      return (
                        <li key={unit.id}>
                          {status === "committed" ? <Check size={13} aria-hidden="true" /> : <Circle size={12} aria-hidden="true" />}
                          <div>
                            <Link href={unit.href} prefetch={false}>{unit.label}<ArrowUpRight size={11} aria-hidden="true" /></Link>
                            <p>{unitStatusLabels[status]}{unit.kind === "workbook-range" && unit.headerRows.length ? ` · Header rows ${unit.headerRows.join(", ")}` : ""}{result?.detail ? ` · ${result.detail}` : ""}</p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="tmi-source-hash">Source SHA-256: <code>{source.sha256}</code></p>
                </details>
              ) : <p className="tmi-unprocessed">No extraction ranges are assigned to this source.</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
