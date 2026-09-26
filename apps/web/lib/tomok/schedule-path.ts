import type { ActivityRecord, RelationshipRecord, SnapshotRecord } from "./import-types";

export const SCHEDULE_PATH_LIMITS = { maxNodes: 2_500, maxRelationships: 5_000 } as const;

export type SchedulePathNode = Pick<ActivityRecord,
  "id" | "code" | "name" | "calendarId" | "calendar" | "constraints" | "dates" |
  "status" | "floatHours" | "longestPath" | "sourceLine"
> & { href: string };

export type SchedulePathEdge = Pick<RelationshipRecord,
  "id" | "predecessor" | "successor" | "type" | "lagHours" | "sourceLine"
> & { citation: { label: string; href: string } };

export type SchedulePath = {
  status: "found" | "not-found" | "truncated";
  source: SchedulePathNode;
  target: SchedulePathNode;
  nodes: SchedulePathNode[];
  relationships: SchedulePathEdge[];
  basis: {
    snapshotId: string;
    sourceId: string;
    importVersion: string;
    scheduleName: string;
    dataDate: string;
    exportDate: string;
    approvalStatus: SnapshotRecord["approvalStatus"];
  };
  coverage: {
    maxNodes: number;
    maxRelationships: number;
    inspectedNodes: number;
    inspectedRelationships: number;
    excludedScopeNodes: number;
    excludedScopeRelationships: number;
    missingEndpointRelationships: number;
    missingActivityCount: number;
    missingRelationshipCount: number;
    truncated: boolean;
  };
  limitations: string[];
};

const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

function activityHref(activity: ActivityRecord) {
  return `/files?${new URLSearchParams({ file: activity.sourceId, activity: activity.id })}`;
}

function node(activity: ActivityRecord): SchedulePathNode {
  return {
    id: activity.id,
    code: activity.code,
    name: activity.name,
    href: activityHref(activity),
    calendarId: activity.calendarId,
    calendar: activity.calendar,
    constraints: [...activity.constraints],
    dates: { ...activity.dates },
    status: activity.status,
    floatHours: activity.floatHours,
    longestPath: activity.longestPath,
    sourceLine: activity.sourceLine,
  };
}

/** Follow imported successor links without recalculating dates, float, or a driving path. */
export function buildSchedulePath(input: {
  activity: ActivityRecord;
  target: ActivityRecord;
  activities: ActivityRecord[];
  relationships: RelationshipRecord[];
  snapshot: SnapshotRecord;
}): SchedulePath {
  const { activity, target, snapshot } = input;
  const inScope = (record: ActivityRecord | RelationshipRecord) =>
    record.projectId === snapshot.projectId &&
    record.importVersion === snapshot.importVersion &&
    record.sourceId === snapshot.sourceId &&
    record.snapshotId === snapshot.snapshotId;
  const project = snapshot.projects.find((item) => item.id === activity.p6ProjectId);
  if (!inScope(activity) || !inScope(target) || !project ||
      !snapshot.projects.some((item) => item.id === target.p6ProjectId)) {
    throw new Error("The selected activities require their matching imported schedule snapshot.");
  }

  const scopedActivities = input.activities.filter(inScope).sort((left, right) =>
    compare(left.code, right.code) || compare(left.id, right.id));
  const allNodes = new Map<string, ActivityRecord>();
  for (const item of scopedActivities) {
    if (allNodes.has(item.id)) throw new Error("The imported schedule contains duplicate activity IDs.");
    allNodes.set(item.id, item);
  }
  // The two selected records are always inspected, even when the graph exceeds the node limit.
  allNodes.set(activity.id, activity);
  allNodes.set(target.id, target);
  const selectedNodes = new Map<string, ActivityRecord>([[activity.id, activity], [target.id, target]]);
  for (const item of scopedActivities) {
    if (selectedNodes.size >= SCHEDULE_PATH_LIMITS.maxNodes) break;
    selectedNodes.set(item.id, item);
  }

  const scopedRelationships = input.relationships.filter(inScope);
  const missingEndpointRelationships = scopedRelationships.filter((item) =>
    !allNodes.has(item.predecessor) || !allNodes.has(item.successor)).length;
  const eligibleRelationships = scopedRelationships.filter((item) =>
    selectedNodes.has(item.predecessor) && selectedNodes.has(item.successor));
  const compareRelationships = (left: RelationshipRecord, right: RelationshipRecord) =>
    compare(selectedNodes.get(left.successor)!.code, selectedNodes.get(right.successor)!.code) ||
    compare(left.successor, right.successor) || compare(left.type, right.type) ||
    compare(String(left.lagHours), String(right.lagHours)) || compare(left.id, right.id);
  // Sort before limiting so equivalent input orders produce the same inspected graph and path.
  eligibleRelationships.sort((left, right) =>
    compare(left.predecessor, right.predecessor) || compareRelationships(left, right));
  const inspectedRelationships = eligibleRelationships.slice(0, SCHEDULE_PATH_LIMITS.maxRelationships);
  const missingActivityCount = Math.max(0, snapshot.counts.activities - allNodes.size);
  const missingRelationshipCount = Math.max(0, snapshot.counts.relationships - scopedRelationships.length);
  const truncated = allNodes.size > selectedNodes.size ||
    eligibleRelationships.length > inspectedRelationships.length ||
    missingEndpointRelationships > 0 || missingActivityCount > 0 || missingRelationshipCount > 0;

  const successors = new Map<string, RelationshipRecord[]>();
  for (const edge of inspectedRelationships) {
    const outgoing = successors.get(edge.predecessor) ?? [];
    outgoing.push(edge);
    successors.set(edge.predecessor, outgoing);
  }
  for (const outgoing of successors.values()) outgoing.sort(compareRelationships);

  const visited = new Set([activity.id]);
  const previous = new Map<string, RelationshipRecord>();
  const queue = [activity.id];
  for (let index = 0; index < queue.length && !visited.has(target.id); index++) {
    for (const edge of successors.get(queue[index]) ?? []) {
      if (visited.has(edge.successor)) continue;
      visited.add(edge.successor);
      previous.set(edge.successor, edge);
      queue.push(edge.successor);
    }
  }

  const found = visited.has(target.id);
  const path: RelationshipRecord[] = [];
  if (found) {
    let current = target.id;
    while (current !== activity.id) {
      const edge = previous.get(current)!;
      path.push(edge);
      current = edge.predecessor;
    }
    path.reverse();
  }
  const limitations = [
    "This is a shortest path by relationship count in the inspected imported successor graph. It is not a driving or critical path and does not calculate milestone delay or recalculate CPM.",
    "The target was explicitly selected for this investigation; selection does not establish an accepted project milestone or confirm the field-to-P6 mapping.",
    "Relationship types and lags, calendar names/IDs, constraints, dates, float, and longest-path flags are imported snapshot values. Calendar working time and constraint effects have not been evaluated.",
    "The snapshot data date and export date are separate facts. The export date does not establish updated field status; baseline approval remains unconfirmed.",
    "Only relationships present in this imported snapshot are considered. Missing external logic and later schedule updates may change the dependency context.",
  ];
  if (truncated) {
    limitations.push("The inspected graph is incomplete or bounded. A returned path is shortest only within that portion; absence of a path does not establish that the activities are disconnected.");
  } else if (!found) {
    limitations.push("No directed successor path was found in the supplied imported graph. This does not establish independence in the current project schedule.");
  }
  if (snapshot.warnings.length) {
    limitations.push(...snapshot.warnings.map((warning) => `Import warning: ${warning}`));
  }

  return {
    status: found ? "found" : truncated ? "truncated" : "not-found",
    source: node(activity),
    target: node(target),
    nodes: found ? [activity, ...path.map((edge) => selectedNodes.get(edge.successor)!)].map(node) : [],
    relationships: path.map((edge) => ({
      id: edge.id,
      predecessor: edge.predecessor,
      successor: edge.successor,
      type: edge.type,
      lagHours: edge.lagHours,
      sourceLine: edge.sourceLine,
      citation: {
        label: `P6 ${selectedNodes.get(edge.predecessor)!.code} → ${selectedNodes.get(edge.successor)!.code} · ${edge.type} · XER line ${edge.sourceLine}`,
        href: activityHref(selectedNodes.get(edge.successor)!),
      },
    })),
    basis: {
      snapshotId: snapshot.snapshotId,
      sourceId: snapshot.sourceId,
      importVersion: snapshot.importVersion,
      scheduleName: project.name,
      dataDate: project.dataDate,
      exportDate: snapshot.exportDate,
      approvalStatus: snapshot.approvalStatus,
    },
    coverage: {
      ...SCHEDULE_PATH_LIMITS,
      inspectedNodes: selectedNodes.size,
      inspectedRelationships: inspectedRelationships.length,
      excludedScopeNodes: input.activities.length - scopedActivities.length,
      excludedScopeRelationships: input.relationships.length - scopedRelationships.length,
      missingEndpointRelationships,
      missingActivityCount,
      missingRelationshipCount,
      truncated,
    },
    limitations,
  };
}
