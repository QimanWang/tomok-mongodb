import { createHash } from "node:crypto";
import { z } from "zod";
import { requirePrincipal, type ProjectPrincipal } from "./auth";
import { projectDb } from "./db";
import { TomokError, safeStorageError } from "./errors";
import { getCaseReplay } from "./replay-service";
import type { ReplayChatDescriptor, ReplayChatHistory } from "./replay-types";
import { getSessionMission } from "./missions/service";

const REPLAY_ATTRIBUTE = "tomokReplayId";
const sessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,180}$/);
const startInput = z.strictObject({ requestId: z.uuid() });
type Binding = {
  _id: string;
  sessionId: string;
  replayId: string;
  owner: string;
  cutoff: string;
  label: string;
  createdAt: string;
};
export type ReplaySession = {
  readonly id: string;
  readonly auth: { readonly current: ProjectPrincipal; readonly initiator?: ProjectPrincipal };
};

function describe(binding: Binding): ReplayChatDescriptor {
  return { sessionId: binding.sessionId, replayId: binding.replayId, cutoff: binding.cutoff,
    label: binding.label, createdAt: binding.createdAt, href: `/replays/${binding.replayId}/chat/${binding.sessionId}` };
}

function replayMarker(principal: ProjectPrincipal | undefined) { return principal?.attributes?.[REPLAY_ATTRIBUTE]; }

async function findBinding(sessionId: string) {
  if (!sessionIdSchema.safeParse(sessionId).success) throw new TomokError("Replay conversation not found.", 404);
  try { return await (await projectDb()).collection<Binding>("replay_chats").findOne({ sessionId }); }
  catch (error) { return safeStorageError(error); }
}

/** Only the server may create and bind a new, message-free runtime session. */
export async function startReplayChat(replayId: string, input: unknown, principal: ProjectPrincipal, createSession: () => Promise<string>) {
  const owner = requirePrincipal(principal);
  const parsed = startInput.safeParse(input);
  if (!parsed.success) throw new TomokError("Start a replay conversation with a valid request ID.", 400);
  const { investigation } = await getCaseReplay(replayId, principal);
  const id = createHash("sha256").update(JSON.stringify([owner, replayId, parsed.data.requestId])).digest("hex");
  try {
    const collection = (await projectDb()).collection<Binding>("replay_chats");
    const existing = await collection.findOne({ _id: id });
    if (existing) return describe(existing);
    const sessionId = await createSession();
    if (!sessionIdSchema.safeParse(sessionId).success) throw new TomokError("The chat service did not create a valid conversation.");
    const binding: Binding = { _id: id, sessionId, replayId, owner, cutoff: investigation.cutoff,
      label: investigation.replay.label, createdAt: new Date().toISOString() };
    // The unique _id makes retries converge. A concurrent loser can leave only an idle,
    // undisclosed session: no prompt has been sent and no evidence has been read by it.
    try { await collection.updateOne({ _id: id }, { $setOnInsert: binding }, { upsert: true }); }
    catch (error) { if ((error as { code?: number })?.code !== 11000) throw error; }
    const saved = await collection.findOne({ _id: id });
    if (!saved) throw new TomokError("Unable to save the replay conversation.");
    return describe(saved);
  } catch (error) { return safeStorageError(error); }
}

export async function getReplayChat(replayId: string, sessionId: string, principal: ProjectPrincipal) {
  const owner = requirePrincipal(principal);
  const binding = await findBinding(sessionId);
  if (!binding || binding.owner !== owner || binding.replayId !== replayId) throw new TomokError("Replay conversation not found.", 404);
  await getCaseReplay(binding.replayId, principal);
  return describe(binding);
}

/** Listing follows the same owner boundary as individual bindings and never reads another session's stream. */
export async function listReplayChats(replayId: string, principal: ProjectPrincipal): Promise<ReplayChatHistory> {
  const owner = requirePrincipal(principal);
  await getCaseReplay(replayId, principal);
  try {
    const rows = await (await projectDb()).collection<Binding>("replay_chats")
      .find({ replayId, owner }).sort({ createdAt: -1, _id: -1 }).limit(21).toArray();
    return { chats: rows.slice(0, 20).map(describe), hasMore: rows.length > 20 };
  } catch (error) { return safeStorageError(error); }
}

/** Applied to every existing eve route, including streams and session controls. */
export async function authorizeReplaySession<T extends NonNullable<ProjectPrincipal>>(sessionId: string, principal: T): Promise<T> {
  const binding = await findBinding(sessionId);
  if (!binding) {
    if (replayMarker(principal)) throw new TomokError("The replay conversation scope is unavailable.", 403);
    return principal;
  }
  if (binding.owner !== requirePrincipal(principal)) throw new TomokError("Replay conversation not found.", 403);
  return { ...principal, attributes: { ...principal.attributes, [REPLAY_ATTRIBUTE]: binding.replayId } };
}

/** Session identity, never clientContext or a model argument, selects the frozen result. */
export async function getSessionReplay(session: ReplaySession) {
  const binding = await findBinding(session.id);
  const markers = [replayMarker(session.auth.current), replayMarker(session.auth.initiator)].filter(Boolean);
  if (!binding) {
    if (markers.length) throw new TomokError("The replay conversation scope is unavailable.", 403);
    return null;
  }
  if (binding.owner !== requirePrincipal(session.auth.current) || markers.some(marker => marker !== binding.replayId)) {
    throw new TomokError("The replay conversation scope does not match this session.", 403);
  }
  if (session.auth.initiator && binding.owner !== requirePrincipal(session.auth.initiator)) {
    throw new TomokError("The replay conversation owner does not match this session.", 403);
  }
  return getCaseReplay(binding.replayId, session.auth.current);
}

export async function requireLiveProjectSession(session: ReplaySession) {
  if (await getSessionMission(session)) throw new TomokError("This conversation is limited to its archive mission. Use its scoped source-unit tools.", 403);
  if (await getSessionReplay(session)) throw new TomokError("This conversation is limited to its saved replay stage. Use get_replay_context for its frozen evidence and reviewed notes.", 403);
}

export async function getReplayContext(input: unknown, session: ReplaySession) {
  if (!z.strictObject({}).safeParse(input).success) throw new TomokError("Replay context takes no inputs; its saved stage cannot be changed.", 400);
  const replay = await getSessionReplay(session);
  if (!replay) throw new TomokError("Start a conversation from a saved case replay to use this tool.", 403);
  return replay;
}
