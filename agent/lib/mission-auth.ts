import { ForbiddenError, type AuthFn } from "eve/channels/auth";
import { authorizeMissionDispatch } from "../../apps/web/lib/tomok/missions/service";
import { MISSION_DISPATCH_HEADER, assertMissionDispatchRequest, verifyMissionDispatch } from "../../apps/web/lib/tomok/missions/dispatch-auth";

/** Internal dispatch credentials authorize only their exact mission operation. */
export const missionDispatchAuth: AuthFn<Request> = async request => {
  const token = request.headers.get(MISSION_DISPATCH_HEADER);
  if (!token) return null;
  try {
    const payload = verifyMissionDispatch(token);
    await assertMissionDispatchRequest(request, payload);
    return await authorizeMissionDispatch({ ...payload, sessionId: payload.sessionId ?? undefined });
  } catch {
    throw new ForbiddenError({ message: "This mission dispatch is unavailable or no longer authorized." });
  }
};
