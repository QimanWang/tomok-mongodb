import { TomokError } from "./errors";

export type ProjectPrincipal = {
  readonly principalId: string;
  readonly principalType: string;
  readonly authenticator: string;
  readonly issuer?: string;
  readonly attributes?: Readonly<Record<string, string | readonly string[]>>;
} | null;

export function projectAuthMode() {
  const has = (key: string) => Boolean(process.env[key]?.trim());
  const oauth = ["DATABASE_URL", "BETTER_AUTH_SECRET", "NEXT_PUBLIC_VERCEL_APP_CLIENT_ID", "VERCEL_APP_CLIENT_SECRET"].every(has);
  const redis = [["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"], ["KV_REST_API_URL", "KV_REST_API_TOKEN"]].some((keys) => keys.every(has));
  if (oauth && redis) return "vercel";
  if (has("EVE_CHAT_PASSWORD")) return "password";
  if (process.env.NODE_ENV === "development" && process.env.VERCEL !== "1") return "local-dev";
  return "unconfigured";
}

// Only trusted request/session adapters construct this principal. It is never a tool input.
export function requirePrincipal(principal: ProjectPrincipal): string {
  if (!principal) throw new TomokError("Sign in to access project evidence.", 401);
  const mode = projectAuthMode();
  if (mode === "vercel" && principal.principalType === "user" && principal.authenticator === "better-auth" && principal.issuer === "better-auth") {
    const members = (process.env.TOMOK_PROJECT_VIEWER_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
    if (members.includes(principal.principalId)) return principal.principalId;
  }
  if (mode === "password" && principal.principalType === "user" && principal.authenticator === "password" && principal.issuer === "eve-chat-template" && principal.principalId === "eve-chat-user") return "eve-chat-user";
  if (mode === "local-dev" && principal.principalType === "local-dev") return "eve-chat-user";
  throw new TomokError("You do not have access to this project.", 403);
}

export function projectActor(principal: ProjectPrincipal) {
  const id = requirePrincipal(principal);
  const name = principal?.attributes?.name;
  return { id, name: projectAuthMode() === "vercel" && typeof name === "string" && name.trim()
    ? name.trim().slice(0, 256) : projectAuthMode() === "vercel" ? `Project member ${id}` : "Local project operator" };
}
