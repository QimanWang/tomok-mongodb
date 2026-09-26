import { TomokError } from "./errors";

function isLocalServiceProxy(request: Request, origin: URL, target: URL) {
  if (process.env.NODE_ENV !== "development" || process.env.VERCEL_ENV !== "development") return false;
  const publicHost = process.env.VERCEL_URL;
  if (!publicHost) return false;
  try {
    const configured = new URL(`http://${publicHost}`);
    const backend = new URL(`http://${request.headers.get("host") ?? target.host}`);
    const loopback = (url: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    // Vercel's local service router replaces Host with the internal service port.
    // Bind the exception to its server-configured public address, never to an
    // arbitrary forwarding header. Production continues to use the ordinary Host check.
    return configured.host === publicHost && loopback(configured) && loopback(backend) && loopback(target) &&
      origin.origin === configured.origin && target.protocol === "http:" &&
      request.headers.get("x-forwarded-host") === publicHost &&
      request.headers.get("x-forwarded-proto") === "http" &&
      request.headers.get("sec-fetch-site") === "same-origin";
  } catch { return false; }
}

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
    (originUrl.host !== targetHost && !isLocalServiceProxy(request, originUrl, target)) ||
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
