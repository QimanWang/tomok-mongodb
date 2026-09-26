import { TomokError } from "../../apps/web/lib/tomok/errors";
import { getSessionMission } from "../../apps/web/lib/tomok/missions/service";
import { getSessionReplay, type ReplaySession } from "../../apps/web/lib/tomok/replay-chat-service";

/** Every capability checks the durable binding, including direct tool execution. */
export async function isBoundedProjectSession(session: ReplaySession) {
  // Check mission first: do not load an unrelated frozen replay for mission tools.
  if (await getSessionMission(session)) return true;
  return Boolean(await getSessionReplay(session));
}

export async function requireLiveProjectSession(session: ReplaySession) {
  if (await isBoundedProjectSession(session)) throw new TomokError("This conversation is limited to its saved replay or archive mission. Open a regular project conversation for live project tools.", 403);
}
