import { z } from "zod";
import type { ProjectMemory } from "./memory-types";

export type MemoryExclusionCounts = {
  unreviewed: number;
  otherImport: number;
  otherActivity: number;
  outsideValidity: number;
  futureEvidence: number;
};

export type MemorySelection = {
  applicable: ProjectMemory[];
  excluded: MemoryExclusionCounts;
};

/**
 * Select current reviewed knowledge applicable to a reporting date. Review time
 * is not an as-known-at cutoff; only validity and cited observation dates apply.
 * Callers must project latest metadata/content, not full revision history, when
 * sending applicable records to a model.
 */
export function selectApplicableMemory(
  memories: readonly ProjectMemory[],
  { releaseId, activityCode, cutoff }: {
    releaseId: string;
    activityCode: string;
    cutoff: string;
  },
): MemorySelection {
  if (!z.iso.date().safeParse(cutoff).success) {
    throw new Error("Memory retrieval requires a valid reporting date.");
  }

  const applicable: ProjectMemory[] = [];
  const excluded: MemoryExclusionCounts = {
    unreviewed: 0,
    otherImport: 0,
    otherActivity: 0,
    outsideValidity: 0,
    futureEvidence: 0,
  };

  for (const memory of memories) {
    // Count the first exclusion only, so counters sum to excluded records.
    // In particular, never fall back to an older reviewed revision.
    const { latest } = memory;
    if (latest.status !== "reviewed") {
      excluded.unreviewed += 1;
      continue;
    }
    if (memory.releaseId !== releaseId) {
      excluded.otherImport += 1;
      continue;
    }
    if (memory.activityCode !== activityCode) {
      excluded.otherActivity += 1;
      continue;
    }
    if (
      !z.iso.date().safeParse(latest.validFrom).success ||
      latest.validFrom > cutoff ||
      (latest.validThrough !== null && (
        !z.iso.date().safeParse(latest.validThrough).success ||
        latest.validThrough < latest.validFrom ||
        latest.validThrough < cutoff
      ))
    ) {
      excluded.outsideValidity += 1;
      continue;
    }
    if (latest.citations.some(({ observedDate }) =>
      observedDate !== null && (
        !z.iso.date().safeParse(observedDate).success || observedDate > cutoff
      ),
    )) {
      excluded.futureEvidence += 1;
      continue;
    }
    applicable.push(memory);
  }

  return { applicable, excluded };
}
