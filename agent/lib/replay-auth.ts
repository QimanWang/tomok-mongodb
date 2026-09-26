import { ForbiddenError, type AuthFn } from "eve/channels/auth";
import { authorizeReplaySession } from "../../apps/web/lib/tomok/replay-chat-service";
import { authorizeMissionSession } from "../../apps/web/lib/tomok/missions/service";

/** Authenticate once, then authorize; a denied bound session must never fall through to another strategy. */
export function withReplayAuthorization(strategies: readonly AuthFn<Request>[]): AuthFn<Request> {
  return async request => {
    for (const strategy of strategies) {
      const principal = await strategy(request);
      if (!principal) continue;
      const match = new URL(request.url).pathname.match(/\/eve\/v1\/session\/([^/]+)(?:\/|$)/);
      if (!match) return principal;
      try {
        const replayAuthorized = await authorizeReplaySession(decodeURIComponent(match[1]), principal);
        const authorized = await authorizeMissionSession(decodeURIComponent(match[1]), replayAuthorized);
        if ((authorized.attributes?.tomokReplayId || authorized.attributes?.tomokMissionId) && /\/(?:reset|clear)\/?$/.test(new URL(request.url).pathname)) {
          throw new Error("Start a fresh replay conversation instead of resetting its history.");
        }
        return authorized;
      }
      catch { throw new ForbiddenError({ message: "This conversation is unavailable or you do not have access. Reopen its saved workspace and try again." }); }
    }
    return null;
  };
}
