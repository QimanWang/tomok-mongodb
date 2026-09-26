import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { requirePrincipal, type ProjectPrincipal } from "../auth";
import { TomokError } from "../errors";

export const MISSION_DISPATCH_HEADER = "x-tomok-mission-dispatch";
export const MISSION_ATTRIBUTE = "tomokMissionId";
const identity = z.string().regex(/^[A-Za-z0-9_-]{1,180}$/);
const principalSchema = z.strictObject({
  principalId: z.string().min(1).max(256),
  principalType: z.string().min(1).max(80),
  authenticator: z.string().min(1).max(80),
  issuer: z.string().min(1).max(256).optional(),
});
const claimsSchema = z.strictObject({
  version: z.literal(1), missionId: identity, owner: z.string().min(1).max(256),
  releaseId: identity, sessionId: identity.nullable(), principal: principalSchema,
  generation: z.number().int().nonnegative(), dispatchId: identity,
  operation: z.enum(["create", "send", "inspect", "cancel"]),
  expiresAt: z.number().int().positive(),
});
export type MissionDispatchClaims = z.infer<typeof claimsSchema>;
export type MissionDispatchDescriptor = {
  missionId: string;
  owner: string;
  releaseId: string;
  principal: NonNullable<ProjectPrincipal>;
  generation: number;
  dispatchId: string;
  sessionId?: string | null;
};

function signingSecret() {
  const secret = process.env.TOMOK_MISSION_DISPATCH_SECRET?.trim()
    || process.env.BETTER_AUTH_SECRET?.trim() || process.env.EVE_CHAT_PASSWORD?.trim();
  if (!secret || secret.length < 16) throw new TomokError("Configure a server authentication secret before starting an archive mission.");
  return secret;
}

function signature(payload: string) {
  return createHmac("sha256", signingSecret()).update(`tomok-mission-dispatch-v1.${payload}`).digest();
}

/** Short-lived server credential; never serialize this into a browser response or a job output. */
export function signMissionDispatch(descriptor: MissionDispatchDescriptor, operation: MissionDispatchClaims["operation"], now = Date.now()) {
  if (requirePrincipal(descriptor.principal) !== descriptor.owner) throw new TomokError("Mission owner authorization is unavailable.", 403);
  const { principalId, principalType, authenticator, issuer } = descriptor.principal;
  const claims = claimsSchema.parse({ version: 1, missionId: descriptor.missionId, owner: descriptor.owner,
    releaseId: descriptor.releaseId, sessionId: descriptor.sessionId ?? null,
    generation: descriptor.generation, dispatchId: descriptor.dispatchId, operation,
    principal: { principalId, principalType, authenticator, ...(issuer ? { issuer } : {}) },
    expiresAt: Math.floor(now / 1_000) + 90 });
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${signature(payload).toString("base64url")}`;
}

export function verifyMissionDispatch(token: string, now = Date.now()): MissionDispatchClaims {
  try {
    if (token.length > 4_096) throw new Error("Invalid credential");
    const [payload, mac, extra] = token.split(".");
    if (!payload || !mac || extra || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(mac)) throw new Error("Invalid credential");
    const actual = Buffer.from(mac, "base64url");
    const expected = signature(payload);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Invalid credential");
    const claims = claimsSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    const current = Math.floor(now / 1_000);
    if (claims.expiresAt <= current || claims.expiresAt > current + 90) throw new Error("Expired credential");
    if (requirePrincipal(claims.principal) !== claims.owner) throw new Error("Unauthorized owner");
    return claims;
  } catch {
    throw new TomokError("The mission dispatch credential is unavailable or expired.", 403);
  }
}

/** A credential cannot be replayed against another session, operation, or a messageful create. */
export async function assertMissionDispatchRequest(request: Request, payload: MissionDispatchClaims) {
  const pathname = new URL(request.url).pathname;
  if (payload.operation === "create") {
    if (payload.sessionId !== null || request.method !== "POST" || pathname !== "/eve/v1/session") throw new TomokError("Invalid mission creation target.", 403);
    const body = await request.clone().text();
    if (body.length > 100 || (body.trim() && body.trim() !== "{}")) throw new TomokError("Create an idle mission session before sending work.", 403);
    return;
  }
  if (!payload.sessionId) throw new TomokError("Missing mission session.", 403);
  const target = `/eve/v1/session/${encodeURIComponent(payload.sessionId)}`;
  const valid = payload.operation === "send" ? request.method === "POST" && pathname === target
    : payload.operation === "inspect" ? request.method === "GET" && pathname === `${target}/stream`
      : request.method === "POST" && pathname === `${target}/cancel`;
  if (!valid) throw new TomokError("The mission credential does not authorize this operation.", 403);
}
