import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { routeAuth } from "eve/channels/auth";
import { withReplayAuthorization } from "../agent/lib/replay-auth.ts";
import { buildProjectImport } from "../apps/web/lib/tomok/import-data.ts";
import { persistProjectImport, readEvidence } from "../apps/web/lib/tomok/repository.ts";
import { closeProjectDb } from "../apps/web/lib/tomok/db.ts";
import { investigateJetGrouting } from "../apps/web/lib/tomok/service.ts";
import { getMemoryContext, proposeProjectMemory, reviseProjectMemory } from "../apps/web/lib/tomok/memory-service.ts";
import { startCaseReplay, advanceCaseReplay } from "../apps/web/lib/tomok/replay-service.ts";
import { startReplayChat, getReplayChat, listReplayChats, authorizeReplaySession, getSessionReplay, requireLiveProjectSession, getReplayContext } from "../apps/web/lib/tomok/replay-chat-service.ts";

let server, client, db, release, data;
const owner = { principalId: "replay-chat-owner", principalType: "user", authenticator: "better-auth", issuer: "better-auth", attributes: { name: "Isolated Replay Chat Owner" } };
const other = { ...owner, principalId: "replay-chat-other", attributes: { name: "Isolated Replay Chat Other" } };
const status = expected => error => error?.status === expected;
const clientError = error => error?.status >= 400 && error?.status < 500;
const envBefore = { ...process.env };
const freshSessionId = () => `wrun_${randomUUID().replaceAll("-", "")}`;
const session = (id, current = owner, initiator = current) => ({ id, auth: { current, initiator } });
const marked = (principal, replayId) => ({ ...principal, attributes: { ...principal.attributes, tomokReplayId: replayId } });

before(async () => {
  [server, data] = await Promise.all([
    MongoMemoryServer.create(),
    buildProjectImport(fileURLToPath(new URL("../", import.meta.url))),
  ]);
  client = await new MongoClient(server.getUri()).connect();
  db = client.db("replay_chat_test");
  Object.assign(process.env, {
    NODE_ENV: "development", DATABASE_URL: "test", BETTER_AUTH_SECRET: "test",
    NEXT_PUBLIC_VERCEL_APP_CLIENT_ID: "test", VERCEL_APP_CLIENT_SECRET: "test",
    UPSTASH_REDIS_REST_URL: "test", UPSTASH_REDIS_REST_TOKEN: "test",
    TOMOK_PROJECT_VIEWER_IDS: `${owner.principalId},${other.principalId}`,
    MONGODB_URI: server.getUri(), MONGODB_DATABASE: "replay_chat_test",
  });
  release = await persistProjectImport(db, data);
});

beforeEach(async () => {
  await Promise.all(["investigations", "project_memory", "replay_chats"].map(name => db.collection(name).deleteMany({})));
});

after(async () => {
  await closeProjectDb();
  await client?.close();
  await server?.stop();
  for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
  Object.assign(process.env, envBefore);
});

async function boundChat(replay, input = { requestId: randomUUID() }) {
  const sessionId = freshSessionId();
  const chat = await startReplayChat(replay.investigation.id, input, owner, async () => sessionId);
  assert.equal(chat.sessionId, sessionId);
  return { chat, runtime: session(sessionId) };
}

async function reviewedNote(title, cutoff = "2026-07-14") {
  const { investigation } = await investigateJetGrouting({ cutoff, question: "Isolated replay chat memory test" }, owner);
  const context = await getMemoryContext(investigation.id, owner);
  const source = context.evidence.find(row => row.observedDate === cutoff);
  assert.ok(source);
  const content = {
    kind: "interpretation", title, statement: `${title}: synthetic test knowledge, not project-team acceptance.`,
    validFrom: "2026-07-13", validThrough: null, evidenceIds: [source.id],
  };
  const { memory } = await proposeProjectMemory({ ...content, investigationId: investigation.id }, owner);
  const reviewed = await reviseProjectMemory(memory.id, { action: "review", expectedRevision: 1, reason: null, content }, owner);
  return { ...reviewed, content };
}

test("replay chat creation and retrieval enforce ownership before creating an eve session", async () => {
  const replay = await startCaseReplay({}, owner);
  const replayId = replay.investigation.id;
  let creates = 0;
  const create = async () => { creates++; return freshSessionId(); };
  await assert.rejects(() => startReplayChat(replayId, { requestId: randomUUID() }, null, create), status(401));
  await assert.rejects(() => startReplayChat(replayId, { requestId: randomUUID() }, other, create), status(404));
  await assert.rejects(() => startReplayChat("not-a-replay", { requestId: randomUUID() }, owner, create), status(404));
  for (const input of [null, [], { requestId: "invalid" }, { requestId: randomUUID(), cutoff: "2026-07-16" },
    { requestId: randomUUID(), sessionId: freshSessionId() }, { requestId: randomUUID(), owner: other.principalId },
    { requestId: randomUUID(), replayId: "f".repeat(32) }]) {
    await assert.rejects(() => startReplayChat(replayId, input, owner, create), clientError);
  }
  assert.equal(creates, 0);
  const { chat } = await boundChat(replay);
  assert.equal(chat.replayId, replayId);
  assert.equal(chat.cutoff, "2026-07-14");
  assert.deepEqual(await getReplayChat(replayId, chat.sessionId, owner), chat);
  await assert.rejects(() => getReplayChat(replayId, chat.sessionId, other), status(404));
  await assert.rejects(() => getReplayChat(replayId, chat.sessionId, null), status(401));
  await assert.rejects(() => getReplayChat(replayId, freshSessionId(), owner), status(404));
});

test("retries reuse the server-bound session and a new request creates a fresh conversation", async () => {
  const replay = await startCaseReplay({}, owner);
  const input = { requestId: randomUUID() };
  let creates = 0;
  const create = async () => { creates++; return freshSessionId(); };
  const first = await startReplayChat(replay.investigation.id, input, owner, create);
  const retry = await startReplayChat(replay.investigation.id, input, owner, create);
  assert.deepEqual(retry, first);
  assert.equal(creates, 1);
  await closeProjectDb();
  assert.deepEqual(await startReplayChat(replay.investigation.id, input, owner, create), first);
  const fresh = await startReplayChat(replay.investigation.id, { requestId: randomUUID() }, owner, create);
  assert.notEqual(fresh.sessionId, first.sessionId);
  assert.equal(creates, 2);
  assert.equal(await db.collection("replay_chats").countDocuments({}), 2);
});

test("chat history is bounded, owner-scoped, and separated by frozen stage", async () => {
  const initial = await startCaseReplay({}, owner);
  const later = await advanceCaseReplay(initial.investigation.id, {}, owner);
  const foreign = await startCaseReplay({}, other);
  await startReplayChat(foreign.investigation.id, { requestId: randomUUID() }, other, async () => freshSessionId());
  const { chat: laterChat } = await boundChat(later);
  await assert.rejects(() => listReplayChats(initial.investigation.id, null), status(401));
  await assert.rejects(() => listReplayChats(initial.investigation.id, other), status(404));
  await assert.rejects(() => listReplayChats("not-a-replay", owner), status(404));
  assert.deepEqual(await listReplayChats(initial.investigation.id, owner), { chats: [], hasMore: false });
  const { chat } = await boundChat(initial);
  assert.ok(chat.createdAt);
  assert.deepEqual(await listReplayChats(initial.investigation.id, owner), { chats: [chat], hasMore: false });
  for (let i = 0; i < 21; i++) await boundChat(initial);
  const history = await listReplayChats(initial.investigation.id, owner);
  assert.equal(history.chats.length, 20);
  assert.equal(history.hasMore, true);
  assert.ok(history.chats.every(item => item.replayId === initial.investigation.id));
  assert.ok(!JSON.stringify(history).includes(laterChat.sessionId));
  assert.doesNotMatch(JSON.stringify(history), /"owner"|"_id"|"messages"|"events"/);
  assert.deepEqual(history.chats.map(item => item.createdAt), history.chats.map(item => item.createdAt).toSorted().toReversed());
  await closeProjectDb();
  assert.deepEqual(await listReplayChats(initial.investigation.id, owner), history);
  assert.deepEqual(await getReplayChat(initial.investigation.id, chat.sessionId, owner), chat);
});

test("concurrent start retries converge on one disclosed session and failed creation leaves no binding", async () => {
  const replay = await startCaseReplay({}, owner);
  const replayId = replay.investigation.id;
  const failedInput = { requestId: randomUUID() };
  await assert.rejects(() => startReplayChat(replayId, failedInput, owner, async () => { throw new Error("Isolated runtime outage"); }));
  assert.equal(await db.collection("replay_chats").countDocuments({}), 0);
  const create = async () => freshSessionId();
  const results = await Promise.all([
    startReplayChat(replayId, failedInput, owner, create),
    startReplayChat(replayId, failedInput, owner, create),
  ]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(await db.collection("replay_chats").countDocuments({}), 1);
});

test("trusted route authorization scopes replay sessions and rejects another project member", async () => {
  const replay = await startCaseReplay({}, owner);
  const { chat, runtime } = await boundChat(replay);
  const scoped = await authorizeReplaySession(chat.sessionId, owner);
  assert.equal(scoped.principalId, owner.principalId);
  assert.equal(scoped.attributes.tomokReplayId, replay.investigation.id);
  await assert.rejects(() => authorizeReplaySession(chat.sessionId, other), clientError);
  await assert.rejects(() => authorizeReplaySession(chat.sessionId, null), status(401));
  assert.deepEqual(await getSessionReplay(runtime), replay);
  await assert.rejects(() => getSessionReplay(session(chat.sessionId, other, owner)), clientError);
  await assert.rejects(() => getSessionReplay(session(chat.sessionId, owner, other)), clientError);
  await assert.rejects(() => getSessionReplay(session(chat.sessionId, marked(owner, "f".repeat(32)), owner)), clientError);
  await assert.rejects(() => getSessionReplay(session(chat.sessionId, owner, marked(owner, "f".repeat(32)))), clientError);
  await assert.rejects(() => requireLiveProjectSession(runtime), clientError);
  const ordinary = session(freshSessionId());
  assert.equal(await getSessionReplay(ordinary), null);
  assert.deepEqual(await authorizeReplaySession(ordinary.id, owner), owner);
  await requireLiveProjectSession(ordinary);
});

test("eve follow-up, stream and control routes reject another owner without falling through authentication", async () => {
  const replay = await startCaseReplay({}, owner);
  const { chat } = await boundChat(replay);
  let fallbackCalls = 0;
  const denied = withReplayAuthorization([
    async () => other,
    async () => { fallbackCalls++; return owner; },
  ]);
  const accepted = withReplayAuthorization([async () => null, async () => owner]);
  for (const [suffix, method] of [["", "POST"], ["/stream", "GET"], ["/cancel", "POST"], ["/clear", "POST"], ["/compact", "POST"], ["/reset", "POST"]]) {
    const request = new Request(`http://localhost/eve/v1/session/${chat.sessionId}${suffix}`, { method });
    const rejected = await routeAuth(request, denied);
    assert.ok(rejected instanceof Response, `${suffix}: authorization should reject`);
    assert.equal(rejected.status, 403, suffix);
    const authorized = await routeAuth(request, accepted);
    if (suffix === "/clear" || suffix === "/reset") {
      assert.ok(authorized instanceof Response, `${suffix}: frozen history must be preserved`);
      assert.equal(authorized.status, 403, suffix);
    } else {
      assert.equal(authorized.attributes.tomokReplayId, replay.investigation.id, suffix);
    }
  }
  assert.equal(fallbackCalls, 0);
  const unscoped = await routeAuth(new Request("http://localhost/eve/v1/session", { method: "POST" }), accepted);
  assert.equal(unscoped.principalId, owner.principalId);
  assert.equal(unscoped.attributes.tomokReplayId, undefined);
});

test("live tools are omitted from replay turns and still reject direct execution", async () => {
  const replay = await startCaseReplay({}, owner);
  const { runtime } = await boundChat(replay);
  const ordinary = session(freshSessionId());
  const missingBinding = session(freshSessionId(), owner, marked(owner, replay.investigation.id));
  for (const name of ["get_project_evidence", "get_project_memory", "get_schedule_context", "investigate_jet_grouting", "propose_project_memory", "get_weather"]) {
    const { default: tool, liveTool } = await import(`../agent/tools/${name}.ts`);
    const resolve = tool.events["turn.started"];
    assert.equal(await resolve({}, { session: runtime }), null, name);
    assert.equal(await resolve({}, { session: ordinary }), liveTool, name);
    await assert.rejects(() => resolve({}, { session: missingBinding }), clientError, name);
    await assert.rejects(() => liveTool.execute({}, { session: runtime }), status(403), name);
  }
});

test("replay sessions have no external connections or cross-session profile memory", async () => {
  const replay = await startCaseReplay({}, owner);
  const { runtime } = await boundChat(replay);
  const missingBinding = session(freshSessionId(), owner, marked(owner, replay.investigation.id));
  for (const name of ["linear", "notion", "sentry"]) {
    const { default: connection } = await import(`../agent/connections/${name}.ts`);
    const resolve = connection.events["turn.started"];
    assert.equal(await resolve({}, { session: runtime }), null, name);
    await assert.rejects(() => resolve({}, { session: missingBinding }), clientError, name);
  }
  const { default: memory } = await import("../agent/memory/profile.ts");
  assert.equal(await memory.scope({ session: runtime }), null);
  await assert.rejects(() => memory.scope({ session: missingBinding }), clientError);
});

test("a missing binding cannot downgrade a previously scoped replay to an ordinary chat", async () => {
  const replay = await startCaseReplay({}, owner);
  const scoped = marked(owner, replay.investigation.id);
  const missingId = freshSessionId();
  await assert.rejects(() => authorizeReplaySession(missingId, scoped), clientError);
  for (const runtime of [session(missingId, scoped, owner), session(missingId, owner, scoped), session(missingId, scoped, scoped)]) {
    await assert.rejects(() => getSessionReplay(runtime), clientError);
    await assert.rejects(() => requireLiveProjectSession(runtime), clientError);
    await assert.rejects(() => getReplayContext({}, runtime), clientError);
  }
});

test("initial chat stays frozen when later reports are revealed and tool input cannot change its scope", async () => {
  await reviewedNote("FUTURE_CHAT_MEMORY_CANARY", "2026-07-16");
  const initial = await startCaseReplay({}, owner);
  const { chat, runtime } = await boundChat(initial);
  const frozen = await getReplayContext({}, runtime);
  assert.deepEqual(frozen, initial);
  for (const input of [null, { cutoff: "2026-07-16" }, { replayId: "f".repeat(32) }, { sessionId: freshSessionId() }, { query: "July 16" }]) {
    await assert.rejects(() => getReplayContext(input, runtime), clientError);
  }
  const later = await advanceCaseReplay(initial.investigation.id, {}, owner);
  await assert.rejects(() => getReplayChat(later.investigation.id, chat.sessionId, owner), status(404));
  assert.deepEqual(await getReplayContext({}, runtime), frozen);
  const laterChat = await boundChat(later);
  assert.notEqual(laterChat.chat.sessionId, chat.sessionId);
  assert.equal((await getReplayContext({}, laterChat.runtime)).investigation.cutoff, "2026-07-16");
  const serialized = JSON.stringify(frozen);
  assert.doesNotMatch(serialized, /55\/392|56\/392|83\/392|90\/392|AD5|AD6|FUTURE_CHAT_MEMORY_CANARY/);
  assert.doesNotMatch(serialized, /"rawCells"|"worksheets"|"relativePath"|\/files\?|\/api\/project-files/);
  for (const future of (await readEvidence(db, release, "2026-07-16")).filter(row => row.observedDate > "2026-07-14")) {
    assert.ok(!serialized.includes(future._id), `Future evidence identity leaked: ${future.locator.cell}`);
    assert.ok(!serialized.includes(future.text), `Future report leaked: ${future.locator.cell}`);
  }
});

test("replay chat memory remains at its saved revision after a subsequent human review", async () => {
  const note = await reviewedNote("Original isolated reviewed interpretation");
  const replay = await startCaseReplay({}, owner);
  const { runtime } = await boundChat(replay);
  const beforeReview = await getReplayContext({}, runtime);
  assert.deepEqual(beforeReview.investigation.reviewedMemory.map(row => [row.id, row.revision]), [[note.memory.id, 2]]);
  await reviseProjectMemory(note.memory.id, {
    action: "review", expectedRevision: 2, reason: "Isolated follow-up review after the replay was frozen",
    content: { ...note.content, statement: "LATER_REVIEW_CANARY: revised synthetic interpretation." },
  }, owner);
  assert.deepEqual(await getReplayContext({}, runtime), beforeReview);
  assert.doesNotMatch(JSON.stringify(await getReplayContext({}, runtime)), /LATER_REVIEW_CANARY/);
  const freshReplay = await startCaseReplay({ requestId: randomUUID() }, owner);
  const freshChat = await boundChat(freshReplay);
  assert.equal((await getReplayContext({}, freshChat.runtime)).investigation.reviewedMemory[0].revision, 3);
});

test("storage unavailability fails closed instead of treating a replay as an unscoped session", async () => {
  const replay = await startCaseReplay({}, owner);
  const { chat, runtime } = await boundChat(replay);
  const database = process.env.MONGODB_DATABASE;
  delete process.env.MONGODB_DATABASE;
  try {
    await assert.rejects(() => authorizeReplaySession(chat.sessionId, owner));
    await assert.rejects(() => getSessionReplay(runtime));
    await assert.rejects(() => requireLiveProjectSession(runtime));
    await assert.rejects(() => getReplayContext({}, runtime));
  } finally {
    process.env.MONGODB_DATABASE = database;
  }
  assert.deepEqual(await getReplayContext({}, runtime), replay);
});
