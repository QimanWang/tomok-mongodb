import test from "node:test";
import assert from "node:assert/strict";
import { requireSameOrigin } from "../apps/web/lib/tomok/origin.ts";

function request(url, overrides = {}) {
  const headers = new Headers({
    origin: new URL(url).origin,
    host: new URL(url).host,
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) headers.delete(key);
    else headers.set(key, value);
  }
  return new Request(url, { method: "POST", headers, body: "{}" });
}
const statusIs = (status) => (error) => error?.status === status;

test("accepts the actual loopback Host when Next canonicalizes request.url to localhost", () => {
  const input = request("http://localhost:3000/api/investigations", {
    host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000",
  });
  assert.doesNotThrow(() => requireSameOrigin(input));
  assert.throws(() => requireSameOrigin(request(input.url, {
    host: null, origin: "http://127.0.0.1:3000",
  })), statusIs(403), "loopback addresses are not interchangeable without the actual Host");
});

test("accepts ordinary HTTPS requests and canonical URL fallback when Host is absent", () => {
  assert.doesNotThrow(() => requireSameOrigin(request("https://tomok.example/api/investigations")));
  assert.doesNotThrow(() => requireSameOrigin(request("https://tomok.example/api/investigations", { host: null })));
  assert.doesNotThrow(() => requireSameOrigin(request("https://tomok.example/api/investigations", {
    "content-type": "Application/JSON; charset=utf-8",
  })));
  assert.doesNotThrow(() => requireSameOrigin(request("http://localhost:3000/api/investigations", {
    host: "tomok.example", origin: "https://tomok.example",
  })), "TLS termination may leave an HTTP server URL behind the trusted Host");
});

test("rejects cross-origin hosts, ports, insecure origins, and cross-site fetch metadata", () => {
  for (const overrides of [
    { origin: "https://attacker.example" },
    { origin: "https://tomok.example:8443" },
    { origin: "http://tomok.example" },
    { "sec-fetch-site": "cross-site" },
    { origin: "https://attacker.example", "x-forwarded-host": "attacker.example" },
    { host: "other.tomok.example", "sec-fetch-site": "same-site" },
  ]) {
    assert.throws(() => requireSameOrigin(request("https://tomok.example/api/investigations", overrides)), statusIs(403));
  }
});

test("rejects missing, opaque, malformed, and non-origin URL headers", () => {
  for (const origin of [
    null, "", "null", "not-an-origin", "ftp://tomok.example", "//tomok.example",
    "https://tomok.example/", "https://tomok.example/path", "https://tomok.example?x=1",
    "https://tomok.example#fragment", "https://user:password@tomok.example",
    "https://tomok.example https://attacker.example",
  ]) {
    assert.throws(() => requireSameOrigin(request("https://tomok.example/api/investigations", { origin })), statusIs(403));
  }
});

test("rejects missing and non-JSON media types including misleading JSON prefixes", () => {
  for (const contentType of [
    null, "", "text/plain", "text/plain; application/json",
    "application/x-www-form-urlencoded", "multipart/form-data; boundary=abc",
    "application/jsonp", "application/json-attacker", "application/json, text/plain",
  ]) {
    assert.throws(() => requireSameOrigin(request("https://tomok.example/api/investigations", {
      "content-type": contentType,
    })), statusIs(415));
  }
});
