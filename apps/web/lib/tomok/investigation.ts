import { z } from "zod";
import type {
  ActivityRecord,
  EvidenceRecord,
  JsonValue,
  Quantity,
  SnapshotRecord,
} from "./import-types";

const JET_GROUT_ACTIVITY = "2A-SP01-GRND-710C-XP";
const requestSchema = z.strictObject({
  cutoff: z.iso.date(),
  question: z.string().trim().min(1).max(2_000),
});

export type InvestigationFinding = {
  id: string;
  kind: "documented" | "inferred" | "unresolved";
  text: string;
  citations: { label: string; href: string }[];
};

export type Investigation = {
  title: string;
  question: string;
  cutoff: string;
  basis: {
    snapshotId: string;
    scheduleName: string;
    dataDate: string;
    exportDate: string;
    approvalStatus: SnapshotRecord["approvalStatus"];
  };
  findings: InvestigationFinding[];
  limitations: string[];
  scopeNote: string;
};

function object(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function quantity(value: JsonValue | undefined): Quantity {
  const record = object(value);
  const completed = record?.completed;
  const total = record?.total;
  if (
    typeof completed !== "number" ||
    typeof total !== "number" ||
    !Number.isInteger(completed) ||
    !Number.isInteger(total) ||
    completed < 0 ||
    total <= 0 ||
    completed > total
  ) {
    throw new Error("The imported daily evidence contains an invalid column count.");
  }
  return { completed, total };
}

function lineQuantity(record: EvidenceRecord, line: "M" | "L") {
  return quantity(object(object(record.facts.lines)?.[line])?.jetGrouted);
}

function amount(value: Quantity) {
  return `${value.completed}/${value.total}`;
}

function citation(record: EvidenceRecord, column?: string) {
  const row = /^[A-Z]+([1-9]\d*)$/.exec(record.locator.cell)?.[1];
  const address = column && row ? `${column}${row}` : record.locator.cell;
  if (address !== record.locator.cell) {
    if (!record.rawCells[address]) {
      throw new Error("The imported evidence is missing the cell required for its citation.");
    }
    const link = new URL(record.href, "https://tomok.invalid");
    link.searchParams.set("cell", address);
    return {
      label: `${record.locator.sheet}!${address}`,
      href: `${link.pathname}${link.search}`,
    };
  }
  return {
    label: `${record.locator.sheet}!${record.locator.cell}`,
    href: record.href,
  };
}

function planDate(value: JsonValue | undefined) {
  const result = z.iso.date().safeParse(value);
  return result.success ? result.data : null;
}

/** Compare a bounded evidence set without network, model calls, or schedule recalculation. */
export function buildInvestigation(input: {
  cutoff: string;
  question: string;
  snapshot: SnapshotRecord;
  activity: ActivityRecord;
  evidence: EvidenceRecord[];
}): Investigation {
  const { cutoff, question } = requestSchema.parse({
    cutoff: input.cutoff,
    question: input.question,
  });
  const { snapshot, activity } = input;
  const project = snapshot.projects.find((item) => item.id === activity.p6ProjectId);
  if (
    activity.code !== JET_GROUT_ACTIVITY ||
    activity.snapshotId !== snapshot.snapshotId ||
    activity.sourceId !== snapshot.sourceId ||
    activity.projectId !== snapshot.projectId ||
    activity.importVersion !== snapshot.importVersion ||
    !project
  ) {
    throw new Error("The South Portal investigation requires its matching schedule snapshot and activity.");
  }

  const evidence = input.evidence.filter((record) =>
    record.projectId === snapshot.projectId &&
    record.importVersion === snapshot.importVersion &&
    (record.activityCode === JET_GROUT_ACTIVITY || record.facts.candidateActivityCode === JET_GROUT_ACTIVITY),
  );
  const daily = evidence
    .filter((record) =>
      record.kind === "field-observation" &&
      record.facts.published === true &&
      z.iso.date().safeParse(record.observedDate).success &&
      record.observedDate! <= cutoff,
    )
    .sort((left, right) => left.observedDate!.localeCompare(right.observedDate!) || left._id.localeCompare(right._id));
  const latest = daily.at(-1);
  if (!latest) {
    throw new Error("No eligible dated daily-report evidence is available on or before the requested cutoff.");
  }
  const previous = daily.findLast((record) => record.observedDate! < latest.observedDate!);
  const grouted = quantity(latest.facts.jetGrouted);
  const predrilled = quantity(latest.facts.predrilled);
  const lineM = lineQuantity(latest, "M");
  const lineL = lineQuantity(latest, "L");
  const source = citation(latest);
  const findings: InvestigationFinding[] = [
    {
      id: "reported-production",
      kind: "documented",
      text: `The daily report dated ${latest.observedDate} records ${amount(grouted)} jet-grouted columns and ${amount(predrilled)} predrilled columns. These are separate reported column counts, not P6 percent complete or labor productivity.`,
      citations: [source],
    },
    {
      id: "reported-lines",
      kind: "documented",
      text: `That report records Line M at ${amount(lineM)} jet-grouted columns and Line L at ${amount(lineL)}. A full reported column count does not establish testing or acceptance completion; zero reported grouted columns does not prove an activity never started.`,
      citations: [source],
    },
  ];

  if (previous) {
    const earlier = quantity(previous.facts.jetGrouted);
    const earlierM = lineQuantity(previous, "M");
    const sameBasis = earlier.total === grouted.total && earlierM.total === lineM.total;
    findings.push({
      id: "observed-change",
      kind: "documented",
      text: sameBasis
        ? `From the ${previous.observedDate} report to the ${latest.observedDate} report, cumulative jet-grouted columns changed from ${amount(earlier)} to ${amount(grouted)}; Line M changed from ${amount(earlierM)} to ${amount(lineM)}. This compares reported counts, not a production-rate forecast.`
        : `The ${previous.observedDate} and ${latest.observedDate} reports use different column-count denominators. Confirm the quantity basis before comparing progress.`,
      citations: [citation(previous), source],
    });
  }

  findings.push({
    id: "schedule-basis",
    kind: "documented",
    text: `P6 activity ${activity.code} (${activity.name}) has planned start ${activity.dates.target_start_date || "not recorded"} and planned finish ${activity.dates.target_end_date || "not recorded"}. Its snapshot data date is ${project.dataDate || "not recorded"}; the export date is ${snapshot.exportDate || "not recorded"}. Baseline approval is unconfirmed. The export date does not establish updated field status.`,
    citations: [{ label: `P6 ${activity.code}`, href: activity.href }],
  });
  if (activity.floatHours !== null || activity.longestPath) {
    findings.push({
      id: "imported-schedule-flags",
      kind: "documented",
      text: `The imported activity has total float ${activity.floatHours === null ? "not recorded" : `${activity.floatHours} hours`} and longest-path flag ${activity.longestPath ? "Yes" : "No"}. These are snapshot results, not a critical-path calculation at ${cutoff}.`,
      citations: [{ label: `P6 ${activity.code}`, href: activity.href }],
    });
  }

  const plans = evidence.filter((record) => record.kind === "field-plan" && record.observedDate === null);
  const mPlan = plans.find((record) => record.facts.line === "M");
  const lPlan = plans.find((record) => record.facts.line === "L");
  const mFinish = planDate(mPlan?.facts.currentFinish);
  const lStart = planDate(lPlan?.facts.currentStart);
  if (mPlan && mFinish) {
    findings.push({
      id: "line-m-plan-review",
      kind: "inferred",
      text: `The undated SOE row identified as Line M lists current finish ${mFinish}; the daily report dated ${latest.observedDate} records ${amount(lineM)} grouted columns. If Jae confirms the row-to-line mapping, reporting cutoff, and that this plan applied at the time, compare the reported production with that finish commitment. This is a conditional review item, not a confirmed schedule variance.`,
      citations: [citation(mPlan, "L"), source],
    });
  }
  if (lPlan && lStart) {
    findings.push({
      id: "line-l-plan-review",
      kind: "inferred",
      text: `The undated SOE row identified as Line L lists current start ${lStart}; the daily report dated ${latest.observedDate} records ${amount(lineL)} grouted columns. If Jae confirms the mapping and that this plan applied at the time, check what work the planned start represents. Reported grouted-column counts alone do not establish a missed start.`,
      citations: [citation(lPlan, "K"), source],
    });
  }

  const summaryPlan = plans.find((record) => record.activityCode === activity.code);
  const summaryStart = planDate(summaryPlan?.facts.currentStart);
  const summaryFinish = planDate(summaryPlan?.facts.currentFinish);
  if (summaryPlan && summaryStart && summaryFinish) {
    findings.push({
      id: "summary-field-plan",
      kind: "documented",
      text: `The undated SOE summary row explicitly identifies ${activity.code} and lists current field-plan start ${summaryStart} and finish ${summaryFinish}. These are planning dates whose applicability at ${cutoff} is unconfirmed, not dated field observations or an approved P6 update.`,
      citations: [citation(summaryPlan, "E"), citation(summaryPlan, "K"), citation(summaryPlan, "L")],
    });
  }
  if (summaryPlan?.facts.actualFinishIsForecast === true && typeof summaryPlan.facts.actualFinishRaw === "string") {
    findings.push({
      id: "forecast-marker",
      kind: "documented",
      text: `The undated SOE summary row's Actual Finish field displays ${summaryPlan.facts.actualFinishRaw}, a formula-generated forecast marker. It is not an observed actual finish; its finish-variance display is not proof of completed work.`,
      citations: [citation(summaryPlan, "O")],
    });
  }

  findings.push({
    id: "cause-and-impact",
    kind: "unresolved",
    text: "These selected records do not establish the cause of a production difference or its effect on the project finish. Jae needs to confirm the field-to-P6 mappings, applicable plan version, reporting cutoffs, and any accepted explanation; current schedule logic and calendar analysis are needed to assess downstream impact.",
    citations: [source, { label: `P6 ${activity.code}`, href: activity.href }],
  });

  return {
    title: `South Portal jet grouting · as of ${cutoff}`,
    question,
    cutoff,
    basis: {
      snapshotId: snapshot.snapshotId,
      scheduleName: project.name,
      dataDate: project.dataDate,
      exportDate: snapshot.exportDate,
      approvalStatus: snapshot.approvalStatus,
    },
    findings,
    limitations: [
      `The latest eligible imported daily observation is ${latest.observedDate}. A reporting date does not establish its precise shift cutoff or complete coverage through ${cutoff}.`,
      "The SOE workbook has no established issue date. Its planning fields are undated context; a date in a quantity description does not date the entire workbook.",
      "Field-to-P6 and detailed row-to-line mappings are unreviewed. An explicit activity code in a source row does not confirm every child row's scope or mapping.",
      "Reported column counts keep predrilling separate from grouting; they do not establish volume-weighted completion, P6 percent complete, acceptance, or labor productivity.",
      "Only one P6 snapshot is imported and its approved-baseline status is unconfirmed. No schedule recalculation, new finish forecast, or CPM delay conclusion has been performed.",
    ],
    scopeNote: "Selected South Portal jet-grouting records only. The reporting cutoff filters dated daily observations; undated SOE plans remain explicitly qualified context. The investigation reports evidence and review questions without changing the schedule.",
  };
}
