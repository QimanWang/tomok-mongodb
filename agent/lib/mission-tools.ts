import { getSessionMission } from "../../apps/web/lib/tomok/missions/service";
import type { MissionSession } from "../../apps/web/lib/tomok/missions/types";
import { safeStorageError } from "../../apps/web/lib/tomok/errors";

export async function missionToolResult<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { return safeStorageError(error); }
}

export async function missionWorkAvailable(session: MissionSession) {
  const mission = await getSessionMission(session);
  return Boolean(mission && ["queued", "running"].includes(mission.status) && mission.currentSessionId === session.id);
}
