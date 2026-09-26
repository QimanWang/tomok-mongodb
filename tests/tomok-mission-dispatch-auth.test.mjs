import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { signMissionDispatch, verifyMissionDispatch, assertMissionDispatchRequest } from "../apps/web/lib/tomok/missions/dispatch-auth.ts";

const envBefore = { ...process.env };
const principal = { principalId: "eve-chat-user", principalType: "user", authenticator: "password", issuer: "eve-chat-template" };
const descriptor = { missionId: "a".repeat(32), owner: principal.principalId, releaseId: "b".repeat(64),
  principal, generation: 2, dispatchId: "c".repeat(32), sessionId: "wrun_isolated_mission" };
const now = Date.UTC(2026, 8, 26);
const forbidden = error => error?.status === 403;

before(() => {
  for (const key of ["DATABASE_URL", "BETTER_AUTH_SECRET", "NEXT_PUBLIC_VERCEL_APP_CLIENT_ID", "VERCEL_APP_CLIENT_SECRET", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN"]) delete process.env[key];
  process.env.EVE_CHAT_PASSWORD = "isolated-mission-credential-test";
  process.env.TOMOK_MISSION_DISPATCH_SECRET = "isolated-dispatch-signing-secret-only";
});
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
  Object.assign(process.env, envBefore);
});

test("dispatch credentials bind owner, release, generation and operation and reject tampering or expiry", () => {
  const token = signMissionDispatch(descriptor, "send", now);
  const claims = verifyMissionDispatch(token, now);
  assert.equal(claims.generation, 2);
  assert.equal(claims.dispatchId, descriptor.dispatchId);
  assert.equal(claims.sessionId, descriptor.sessionId);
  assert.equal(claims.operation, "send");
  assert.throws(() => verifyMissionDispatch(token, now + 90_000), forbidden);
  const [payload, mac] = token.split(".");
  const changed = JSON.parse(Buffer.from(payload, "base64url").toString());
  changed.missionId = "d".repeat(32);
  assert.throws(() => verifyMissionDispatch(`${Buffer.from(JSON.stringify(changed)).toString("base64url")}.${mac}`, now), forbidden);
  assert.throws(() => signMissionDispatch({ ...descriptor, owner: "another-owner" }, "send", now), forbidden);
  assert.throws(() => verifyMissionDispatch(`${token}.extra`, now), forbidden);
  assert.throws(() => verifyMissionDispatch("x".repeat(4_097), now), forbidden);
});

test("create credentials permit only idle creation and cannot run an unbound first turn", async () => {
  const claims = verifyMissionDispatch(signMissionDispatch({ ...descriptor, sessionId: null }, "create", now), now);
  for (const body of [undefined, "", "{}", " {} "]) {
    await assertMissionDispatchRequest(new Request("http://localhost/eve/v1/session", { method: "POST", body }), claims);
  }
  for (const body of ['{"message":"Read all current project evidence"}', '{"clientContext":{"missionId":"another"}}', "[]", "null"]) {
    await assert.rejects(() => assertMissionDispatchRequest(new Request("http://localhost/eve/v1/session", { method: "POST", body }), claims), forbidden);
  }
  await assert.rejects(() => assertMissionDispatchRequest(new Request(`http://localhost/eve/v1/session/${descriptor.sessionId}`, { method: "POST" }), claims), forbidden);
});

test("session credentials cannot cross sessions, escalate operations, clear history or reset the runtime", async () => {
  const base = `http://localhost/eve/v1/session/${descriptor.sessionId}`;
  for (const [operation, allowedPath, method] of [["send", "", "POST"], ["inspect", "/stream", "GET"], ["cancel", "/cancel", "POST"]]) {
    const claims = verifyMissionDispatch(signMissionDispatch(descriptor, operation, now), now);
    await assertMissionDispatchRequest(new Request(`${base}${allowedPath}`, { method }), claims);
    await assert.rejects(() => assertMissionDispatchRequest(new Request(`http://localhost/eve/v1/session/wrun_foreign${allowedPath}`, { method }), claims), forbidden);
    for (const suffix of ["/reset", "/clear", "/compact"]) {
      await assert.rejects(() => assertMissionDispatchRequest(new Request(`${base}${suffix}`, { method: "POST" }), claims), forbidden);
    }
    const wrongMethod = method === "GET" ? "POST" : "GET";
    await assert.rejects(() => assertMissionDispatchRequest(new Request(`${base}${allowedPath}`, { method: wrongMethod }), claims), forbidden);
  }
});
