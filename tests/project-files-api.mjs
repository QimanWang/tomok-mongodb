import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout } from "node:timers/promises";
const origin = "http://127.0.0.1:3017";
const password = randomBytes(24).toString("hex");
const server = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "start",
    "apps/web",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3017",
  ],
  {
    env: {
      ...process.env,
      NODE_ENV: "production",
      EVE_CHAT_PASSWORD: password,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let output = "";
server.stdout.on("data", (data) => {
  output += data;
});
server.stderr.on("data", (data) => {
  output += data;
});
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null)
      throw new Error(`Test server exited: ${output}`);
    try {
      await fetch(`${origin}/api/project-files`);
      ready = true;
      break;
    } catch {
      await setTimeout(250);
    }
  }
  assert.ok(ready, "production test server ready");
  const signedOut = await (await fetch(`${origin}/api/bootstrap`)).json();
  assert.equal(signedOut.setupStatus.authMode, "password", "runtime configuration is not frozen during build");
  assert.equal(signedOut.setupStatus.appReady, true);
  assert.equal(signedOut.viewer, null);
  for (const route of [
    "/api/project-files",
    "/api/project-files/34dc842bf8c24545/schedule",
    "/api/project-files/8a814954be66ceba/content",
  ]) {
    const response = await fetch(origin + route);
    assert.equal(response.status, 401, route);
    assert.match(response.headers.get("cache-control"), /private, no-store/);
  }
  console.log(
    "PASS unauthenticated catalog, schedule and PDF requests rejected",
  );
  const login = await fetch(`${origin}/api/password-auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const headers = { Cookie: cookie };
  const bootstrap = await fetch(`${origin}/api/bootstrap`, { headers });
  assert.match(bootstrap.headers.get("cache-control"), /private, no-store/);
  assert.equal((await bootstrap.json()).viewer.id, "eve-chat-user");
  const listing = await fetch(`${origin}/api/project-files`, { headers });
  assert.equal(listing.status, 200);
  const { files } = await listing.json();
  assert.equal(files.length, 8);
  const schedule = await (
    await fetch(
      `${origin}/api/project-files/${files.find((f) => f.kind === "xer").id}/schedule`,
      { headers },
    )
  ).json();
  assert.equal(schedule.activities.length, 1793);
  const pdf = files.find((f) => f.pages === 920);
  const range = await fetch(`${origin}/api/project-files/${pdf.id}/content`, {
    headers: { ...headers, Range: "bytes=0-99" },
  });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 100);
  assert.equal(range.headers.get("content-range"), `bytes 0-99/${pdf.bytes}`);
  assert.match(range.headers.get("cache-control"), /private, no-store/);
  assert.equal(
    (
      await fetch(`${origin}/api/project-files/${pdf.id}/content`, {
        headers: { ...headers, Range: `bytes=${pdf.bytes}-` },
      })
    ).status,
    416,
  );
  assert.equal(
    (
      await fetch(`${origin}/api/project-files/not-a-source/content`, {
        headers,
      })
    ).status,
    404,
  );
  assert.equal(
    (await fetch(`${origin}/api/project-files/${pdf.id}/schedule`, { headers }))
      .status,
    400,
  );
  const worker = await fetch(`${origin}/api/pdf-worker`);
  assert.equal(worker.status, 200);
  assert.match(worker.headers.get("content-type"), /javascript/);
  assert.ok((await worker.text()).includes("WorkerMessageHandler"));
  console.log(
    "PASS authenticated source access, schedule, PDF ranges, unknown IDs, wrong file type and worker asset",
  );
} finally {
  server.kill("SIGTERM");
}
