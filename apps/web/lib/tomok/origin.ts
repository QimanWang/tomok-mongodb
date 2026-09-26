import { TomokError } from "./errors";

export function requireSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  // Next may use its listening hostname in request.url (localhost) while the
  // browser connected through 127.0.0.1. The HTTP Host preserves the actual target.
  let originUrl: URL | null = null;
  try {
    originUrl = origin ? new URL(origin) : null;
  } catch {
    // Malformed Origin headers fail the same check as missing ones.
  }
  const target = new URL(request.url);
  const targetHost = request.headers.get("host") ?? target.host;
  if (
    !originUrl ||
    !["http:", "https:"].includes(originUrl.protocol) ||
    originUrl.origin !== origin ||
    originUrl.host !== targetHost ||
    (target.protocol === "https:" && originUrl.protocol !== "https:") ||
    request.headers.get("sec-fetch-site") === "cross-site"
  ) {
    throw new TomokError("This request must come from Tomok.", 403);
  }
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new TomokError("A JSON request is required.", 415);
  }
}
