import type { InvestigationFinding } from "./investigation";
import type { Investigation } from "./service";

export type ReplayExhibit = {
  id: string;
  sourceId: string;
  evidenceIds: string[];
  label: string;
  observedDate: string | null;
  kind: "schedule" | "field-observation" | "field-plan" | "mapping";
  text: string;
  cells: { address: string; display: string; formula: string | null }[];
  href: string;
};

export type ReplayProgress = {
  observedDate: string;
  evidenceId: string;
  jetGrouted: { completed: number; total: number };
  predrilled: { completed: number; total: number };
  lineM: { completed: number; total: number };
  lineL: { completed: number; total: number };
};

export type ReplayReassessment = {
  previousId: string;
  previousCutoff: string;
  findings: InvestigationFinding[];
  memoryChecks: {
    memoryId: string;
    revision: number;
    disposition: "mapping-retained" | "review-suggested" | "no-specific-conflict";
    reason: string;
    citations: { label: string; href: string }[];
  }[];
};

/** Frozen server-prepared exhibits; never a whole workbook or live memory history. */
export type CaseReplay = Investigation & {
  replay: {
    version: string;
    stage: "initial" | "later";
    label: string;
    availabilityNote: string;
    exhibits: ReplayExhibit[];
    progress: ReplayProgress[];
    reassessment: ReplayReassessment | null;
  };
};

export type ReplayStageSummary = {
  id: string;
  href: string;
  cutoff: string;
  label: string;
  createdAt: string;
  reviewedMemoryCount: number;
};

export type ReplayHistory = {
  cases: { initial: ReplayStageSummary; later: ReplayStageSummary | null }[];
  hasMore: boolean;
};

export type ReplayChatDescriptor = {
  href: string;
  sessionId: string;
  replayId: string;
  cutoff: string;
  label: string;
  createdAt: string;
};

export type ReplayChatHistory = {
  chats: ReplayChatDescriptor[];
  hasMore: boolean;
};
