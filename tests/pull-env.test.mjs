import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { mergeEnv } from "../scripts/pull-env.mjs";

test("refreshes Vercel values while preserving local MongoDB and multiline secrets", () => {
  const local = [
    '# local credentials',
    'MONGODB_URI="mongodb://user:p$ss@localhost/test?retryWrites=true&w=majority"',
    'export MONGODB_DATABASE = "local_db" # keep this',
    "LOCAL_SECRET='first line\nKEY=inside the secret\nlast line # still secret'",
    'EMPTY=',
    'VERCEL_OIDC_TOKEN="expired"',
    'SHARED="local"',
  ].join("\n");
  const pulled = 'VERCEL_OIDC_TOKEN="fresh"\nSHARED=""\nNEW_KEY="remote"\n';
  const merged = mergeEnv(local, pulled);
  assert.deepEqual({ ...parseEnv(merged) }, { ...parseEnv(local), ...parseEnv(pulled) });
  assert.ok(merged.includes('export MONGODB_DATABASE = "local_db" # keep this'));
  assert.ok(!merged.includes('expired'));
  assert.equal(mergeEnv(merged, pulled), merged, "repeated pulls do not accumulate duplicate entries");
});

test("preserves the effective value of repeated local declarations and Windows line endings", () => {
  const local = 'LOCAL=old\r\nLOCAL="new # value"\r\nTEMPLATE=`two\nlines`\r\n';
  assert.deepEqual({ ...parseEnv(mergeEnv(local, "REMOTE=value\n")) }, {
    ...parseEnv(local), REMOTE: "value",
  });
});

const script = fileURLToPath(new URL("../scripts/pull-env.mjs", import.meta.url));

function fixture(t, stub, local) {
  const directory = mkdtempSync(join(tmpdir(), "tomok-env-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "vercel"), `#!/bin/sh\n${stub}\n`, { mode: 0o700 });
  if (local !== undefined) writeFileSync(join(directory, ".env.local"), local);
  return {
    directory,
    run: () => spawnSync(process.execPath, [script, "--scope", "test-team"], {
      cwd: directory,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
      encoding: "utf8",
    }),
  };
}

test("pulls development vars with scope, keeps a private backup, and leaves dev overrides intact", (t) => {
  const original = 'MONGODB_DATABASE="test_db"\nMONGODB_URI="mongodb://localhost/test"\n';
  const { directory, run } = fixture(t, [
    '[ "$1" = env ] && [ "$2" = pull ] || exit 2',
    '[ "$4" = --environment=development ] && [ "$5" = --yes ] || exit 2',
    '[ "$6" = --scope ] && [ "$7" = test-team ] || exit 2',
    'printf \'VERCEL_OIDC_TOKEN="fresh"\\n\' > "$3"',
  ].join("\n"), original);
  const override = join(directory, ".env.development.local");
  writeFileSync(override, 'LOCAL_OVERRIDE="untouched"\n');
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const env = join(directory, ".env.local");
  assert.deepEqual({ ...parseEnv(readFileSync(env, "utf8")) }, {
    ...parseEnv(original), VERCEL_OIDC_TOKEN: "fresh",
  });
  const backups = readdirSync(directory).filter((name) => name.startsWith(".env.local.backup-"));
  assert.equal(backups.length, 1);
  const backup = join(directory, backups[0]);
  assert.equal(readFileSync(backup, "utf8"), original);
  assert.equal(statSync(backup).mode & 0o777, 0o600);
  assert.equal(statSync(env).mode & 0o777, 0o600);
  assert.equal(readFileSync(override, "utf8"), 'LOCAL_OVERRIDE="untouched"\n');
  assert.ok(!readdirSync(directory).some((name) => name.startsWith(".env.pull-")));
});

test("failed pulls leave local credentials byte-for-byte unchanged", (t) => {
  const original = 'MONGODB_URI="mongodb://localhost/test"\n';
  const { directory, run } = fixture(t, 'printf "PARTIAL=value\\n" > "$3"\nexit 1', original);
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /left unchanged/);
  assert.equal(readFileSync(join(directory, ".env.local"), "utf8"), original);
  assert.deepEqual(readdirSync(directory).sort(), [".env.local", "vercel"]);
});

test("first-time pulls create .env.local without a backup", (t) => {
  const { directory, run } = fixture(t, 'printf "REMOTE=value\\n" > "$3"');
  assert.equal(run().status, 0);
  assert.deepEqual({ ...parseEnv(readFileSync(join(directory, ".env.local"), "utf8")) }, { REMOTE: "value" });
  assert.deepEqual(readdirSync(directory).sort(), [".env.local", "vercel"]);
});

test("does not overwrite edits made while the pull is running", (t) => {
  const { directory, run } = fixture(t, [
    'printf "REMOTE=value\\n" > "$3"',
    'printf "LOCAL=user-edit\\n" > .env.local',
  ].join("\n"), "LOCAL=original\n");
  assert.equal(run().status, 1);
  assert.equal(readFileSync(join(directory, ".env.local"), "utf8"), "LOCAL=user-edit\n");
});
