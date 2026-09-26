import { Client } from "eve/client";
import { TomokError } from "../errors";
import { MISSION_DISPATCH_HEADER, signMissionDispatch, type MissionDispatchClaims, type MissionDispatchDescriptor } from "./dispatch-auth";

export type { MissionDispatchDescriptor } from "./dispatch-auth";

function missionClient(descriptor: MissionDispatchDescriptor, operation: MissionDispatchClaims["operation"]) {
  // Only deployment configuration may select the destination of this credential.
  const host = process.env.VERCEL_URL?.trim();
  if (!host || !/^[A-Za-z0-9.[\]:-]+$/.test(host)) throw new TomokError("Start the linked web and eve services before dispatching an archive mission.");
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host);
  return new Client({ host: `${local ? "http" : "https"}://${host}`, redirect: "error",
    headers: () => ({ [MISSION_DISPATCH_HEADER]: signMissionDispatch(descriptor, operation),
      ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET ? { "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET } : {}) }) });
}

/** Create without a message. The caller must commit the binding before sending any work. */
export async function createIdleMissionSession(descriptor: MissionDispatchDescriptor) {
  const { session } = await missionClient({ ...descriptor, sessionId: null }, "create").sessions.create({ signal: AbortSignal.timeout(20_000) });
  return session.state.sessionId;
}

function sessionHandle(descriptor: MissionDispatchDescriptor, operation: MissionDispatchClaims["operation"]) {
  if (!descriptor.sessionId) throw new TomokError("The mission has no bound runtime session.");
  return missionClient(descriptor, operation).sessions.attach(descriptor.sessionId);
}

export async function sendMissionWork(descriptor: MissionDispatchDescriptor, dispatchId = descriptor.dispatchId) {
  if (!/^[A-Za-z0-9_-]{1,180}$/.test(dispatchId)) throw new TomokError("Invalid mission dispatch identity.", 400);
  if (dispatchId !== descriptor.dispatchId) throw new TomokError("The dispatch identity does not match this mission delivery.", 403);
  await sessionHandle(descriptor, "send").send(`MISSION_DISPATCH ${dispatchId}\nResume this session's archive mission from its committed checkpoint. Load get_archive_mission, select useful eligible work, and process source units serially within the remaining budget. Preserve exact source citations and disclose unresolved gaps. Finish only through complete_archive_mission after every in-scope range has an outcome.`,
    { turnPolicy: "queue", signal: AbortSignal.timeout(25_000) });
  // Accepting the durable delivery starts work independently of an HTTP stream or browser.
  return { accepted: true as const, sessionId: descriptor.sessionId! };
}

export type MissionRuntimeSnapshot = {
  state: "running" | "waiting" | "waiting_for_input" | "failed" | "completed" | "unknown";
  dispatchIds: string[];
  lastEventId: string | null;
  lastEventAt: string | null;
  latestTurnFailed: boolean;
};

export async function inspectMissionSession(descriptor: MissionDispatchDescriptor): Promise<MissionRuntimeSnapshot> {
  const snapshot = await sessionHandle(descriptor, "inspect").snapshot({ signal: AbortSignal.timeout(20_000) });
  let state: MissionRuntimeSnapshot["state"] = "unknown";
  let latestTurnFailed = false;
  const dispatchIds = new Set<string>();
  for (const event of snapshot.events) {
    if (event.type === "session.started" || event.type === "session.waiting") state = "waiting";
    if (event.type === "turn.started") { state = "running"; latestTurnFailed = false; }
    if (event.type === "turn.failed") latestTurnFailed = true;
    if (event.type === "input.requested" || event.type === "authorization.required") state = "waiting_for_input";
    if (event.type === "session.failed") state = "failed";
    if (event.type === "session.completed") state = "completed";
    if (event.type === "message.received") {
      const text = event.data.message;
      if (typeof text === "string") {
        const match = text.match(/^MISSION_DISPATCH ([A-Za-z0-9_-]{1,180})\n/);
        if (match) dispatchIds.add(match[1]);
      }
    }
  }
  const last = snapshot.events.at(-1);
  return { state, dispatchIds: [...dispatchIds], lastEventId: last?.meta.id ?? null, lastEventAt: last?.meta.at ?? null, latestTurnFailed };
}

export async function cancelMissionWork(descriptor: MissionDispatchDescriptor) {
  return sessionHandle(descriptor, "cancel").cancel({ signal: AbortSignal.timeout(20_000) });
}
