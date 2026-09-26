import type { Db } from "mongodb";
import type { ActivityRecord, EvidenceRecord, RelationshipRecord, SnapshotRecord, SourceRecord } from "./import-types";
import type { TargetMilestoneCode } from "./investigation-options";
import { TomokError } from "./errors";
import { PROJECT_ID, type Release } from "./repository";
import { buildSchedulePath } from "./schedule-path";
import { resolveSelectedSource, type SelectedSourceInput } from "./source-selection";

export async function readMilestoneContext(db: Db, release: Release, activity: ActivityRecord, snapshot: SnapshotRecord, targetCode: TargetMilestoneCode) {
  const scope = { projectId: PROJECT_ID, releaseId: release.releaseId, sourceId: activity.sourceId, snapshotId: activity.snapshotId } as const;
  const target = await db.collection<ActivityRecord>("schedule_activities").findOne({ ...scope, code: targetCode });
  if (!target || !["TT_FinMile", "TT_Mile"].includes(target.type)) throw new TomokError("The selected milestone is not in this schedule snapshot.", 404);
  const [activities, relationships] = await Promise.all([
    db.collection<ActivityRecord>("schedule_activities").find(scope).sort({ id: 1 }).limit(2_501).toArray(),
    db.collection<RelationshipRecord>("schedule_relationships").find(scope).sort({ id: 1 }).limit(5_001).toArray(),
  ]);
  return buildSchedulePath({ activity, target, activities, relationships, snapshot });
}

export async function readSelectedSource(db: Db, release: Release, input: SelectedSourceInput, evidence: EvidenceRecord[], activityCode: string) {
  const scope = { projectId: PROJECT_ID, releaseId: release.releaseId } as const;
  const sources = await db.collection<SourceRecord>("project_sources").find({ ...scope, sourceId: input.sourceId }).limit(2).toArray();
  const activities = input.activity ? await db.collection<ActivityRecord>("schedule_activities").find({ ...scope, sourceId: input.sourceId, id: input.activity }).limit(2).toArray() : [];
  return resolveSelectedSource(input, { sources, activities, evidence, activityCode });
}
