import { z } from "zod";
import type { ProjectPrincipal } from "../auth";
import type { SourceManifest, SourceUnit, ValidatedFact } from "./source-units";
import { proposedFactSchema } from "./source-units";

export const startMissionSchema = z.strictObject({
  requestId: z.uuid(), goal: z.string().trim().min(10).max(2_000),
  cutoff: z.iso.date().default("2026-07-16"),
  preset: z.literal("south-portal-three-source").default("south-portal-three-source"),
});
export const missionActionSchema = z.strictObject({ action: z.enum(["pause", "resume", "retry"]), requestId: z.uuid() });
export const claimMissionJobSchema = z.strictObject({ jobId: z.string().regex(/^[a-f0-9]{32}$/), reason: z.string().trim().min(5).max(500) });
export const readMissionUnitSchema = z.strictObject({ jobId: z.string().regex(/^[a-f0-9]{32}$/), leaseToken: z.uuid() });
export const commitMissionJobSchema = readMissionUnitSchema.extend({ facts: z.array(proposedFactSchema).max(24) });
const factReferences = z.array(z.string().min(1).max(180)).min(1).max(10);
const reportStatement = z.strictObject({ text: z.string().trim().min(1).max(1_000), factIds: factReferences });
export const completeMissionSchema = z.strictObject({
  summary: z.string().trim().min(10).max(2_000),
  connections: z.array(z.strictObject({ leftFactId: z.string().max(180), rightFactId: z.string().max(180),
    relation: z.enum(["same-identifier", "candidate-mapping", "progress-comparison", "possible-conflict"]), reason: z.string().trim().min(5).max(600) })).max(20),
  questions: z.array(z.string().trim().min(5).max(600)).max(20),
  lessons: z.array(reportStatement).max(10),
});
export type MissionState = "queued" | "running" | "paused" | "completed" | "completed_with_gaps" | "failed";
export type MissionJob = {
  id: string; unitId: string; status: "pending" | "running" | "completed" | "failed";
  attempt: number; policyVersion: string; reason?: string; outputId?: string;
  lastError?: string; startedAt?: string; completedAt?: string;
};
export type MissionLease = { jobId: string; token: string; generation: number; expiresAt: string };
export type MissionDispatch = { id: string; status: "pending" | "sending" | "accepted" | "failed";
  attempts: number; leaseUntil?: string; acceptedAt?: string; error?: string; checkpointCount?: number; noProgress?: number; inspectionFailures?: number };
export type MissionPolicy = { id: string; version: number; label: string; rowWindow: number; headerRows: number; omitEmptyCells: boolean; inspectFormulas: true; createdAt: string };
export type PolicyEvaluation = { id: string; candidateId: string; baselineId: string; evaluatedAt: string;
  decision: "promoted" | "rejected"; baselineCells: number; candidateCells: number;
  baselineBytes: number; candidateBytes: number; requiredFactsPreserved: boolean;
  reasons: string[]; dataset: string; scopeNote: string };
export type MissionConnection = z.infer<typeof completeMissionSchema>["connections"][number] & { status: "documented-identifier" | "proposed" };
export type MissionReport = Omit<z.infer<typeof completeMissionSchema>, "connections"> & {
  connections: MissionConnection[]; createdAt: string; reviewStatus: "unreviewed"; scopeNotes: string[];
};
export type MissionReportRevision = {
  id: string; recordedAt: string; reason: string; report: MissionReport;
};
export type MissionDocument = {
  _id: string; id: string; projectId: string; owner: string; principal: NonNullable<ProjectPrincipal>;
  releaseId: string; importVersion: string; goal: string; cutoff: string; requestHash: string;
  createdAt: string; updatedAt: string; status: MissionState; generation: number; revision: number;
  manifest: SourceManifest; jobs: MissionJob[]; activeLease: MissionLease | null;
  currentSessionId: string | null; dispatch: MissionDispatch;
  budget: { maxJobs: number; maxAttempts: number; maxToolCalls: number; toolCalls: number; attempts: number;
    modelSteps?: number; inputTokens?: number; outputTokens?: number;
    maxModelSteps?: number; maxInputTokens?: number; maxOutputTokens?: number };
  modelStepIds?: string[];
  pauseReason: string | null; lastCheckpoint: string | null;
  report: MissionReport | null; reportRevisions?: MissionReportRevision[]; policies: MissionPolicy[]; activePolicyId: string;
  policyEvaluations: PolicyEvaluation[]; actionIds: string[];
};
export type MissionSessionBinding = { _id: string; sessionId: string; missionId: string; owner: string;
  releaseId: string; generation: number; createdAt: string };
export type MissionOutput = {
  _id: string; missionId: string; jobId: string; unitId: string; releaseId: string;
  policyVersion: string; generation: number; attempt: number; createdAt: string;
  status: "processed" | "outside-cutoff"; facts: ValidatedFact[];
  metrics: { inputBytes: number; records: number; facts: number }; warnings: string[];
};
export type MissionSummary = Pick<MissionDocument, "id" | "goal" | "cutoff" | "createdAt" | "updatedAt" | "status" | "pauseReason" | "lastCheckpoint"> & {
  href: string; completedJobs: number; totalJobs: number; failedJobs: number;
};
export type MissionDetail = MissionSummary & {
  releaseId: string; generation: number; manifest: SourceManifest;
  jobs: (MissionJob & { unit: SourceUnit })[];
  outputs: MissionOutput[]; report: MissionReport | null;
  budget: MissionDocument["budget"]; dispatch: Pick<MissionDispatch, "status" | "attempts" | "error">;
  policies: MissionPolicy[]; activePolicyId: string; policyEvaluations: PolicyEvaluation[];
  capabilities: { canPause: boolean; canResume: boolean; canRetry: boolean };
};
export type MissionSession = { readonly id: string; readonly auth: { readonly current: ProjectPrincipal; readonly initiator?: ProjectPrincipal } };
export type MissionDispatchDescriptor = { missionId: string; owner: string; releaseId: string;
  principal: NonNullable<ProjectPrincipal>; generation: number; dispatchId: string; sessionId?: string };
