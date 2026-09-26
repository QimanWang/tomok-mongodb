import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MISSION_SOURCE_NAMES, packageEveSources } from "../scripts/package-eve-sources.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "tomok-eve-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDirectory = path.join(root, "data/kiewit/bp-tunnel");
  const manifestDirectory = path.join(root, "apps/web/lib/project-files");
  const outputDirectory = path.join(root, ".vercel/output");
  await Promise.all([mkdir(sourceDirectory, { recursive: true }), mkdir(manifestDirectory, { recursive: true })]);
  const files = [];
  for (const name of MISSION_SOURCE_NAMES) {
    const bytes = Buffer.from(`binary source fixture: ${name}\0\xff`);
    await writeFile(path.join(sourceDirectory, name), bytes);
    files.push({ name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  await writeFile(path.join(manifestDirectory, "source-manifest.json"), JSON.stringify({ files }));
  for (const name of ["__server.func", "eve/v1/workflow.func"]) {
    const directory = path.join(outputDirectory, "functions", name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, ".vc-config.json"), JSON.stringify({ runtime: "nodejs24.x", handler: "index.mjs" }));
  }
  await symlink("__server.func", path.join(outputDirectory, "functions/alias.func"));
  return { root, sourceDirectory, outputDirectory };
}

test("packages exact private bytes into each unique generated function without changing its configuration", async (t) => {
  const options = await fixture(t);
  const result = await packageEveSources(options);
  assert.equal(result.sourceCount, 3);
  assert.equal(result.functionCount, 2);
  for (const name of ["__server.func", "eve/v1/workflow.func", "alias.func"]) {
    const directory = path.join(options.outputDirectory, "functions", name);
    for (const source of MISSION_SOURCE_NAMES) {
      assert.deepEqual(await readFile(path.join(directory, "data/kiewit/bp-tunnel", source)), await readFile(path.join(options.sourceDirectory, source)));
    }
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, ".vc-config.json"), "utf8")), { runtime: "nodejs24.x", handler: "index.mjs" });
  }
  await assert.rejects(readFile(path.join(options.outputDirectory, "static/data/kiewit/bp-tunnel", MISSION_SOURCE_NAMES[0])), { code: "ENOENT" });
});

test("rejects changed source bytes before copying any source", async (t) => {
  const options = await fixture(t);
  await writeFile(path.join(options.sourceDirectory, MISSION_SOURCE_NAMES[2]), "changed");
  await assert.rejects(packageEveSources(options), /registered bytes and hash/);
  await assert.rejects(readFile(path.join(options.outputDirectory, "functions/__server.func/data/kiewit/bp-tunnel", MISSION_SOURCE_NAMES[0])), { code: "ENOENT" });
});

test("fails closed when generated function output is missing or escapes the output", async (t) => {
  const options = await fixture(t);
  await symlink(options.sourceDirectory, path.join(options.outputDirectory, "functions/outside.func"));
  await assert.rejects(packageEveSources(options), /outside the build output/);
  await rm(path.join(options.outputDirectory, "functions"), { recursive: true });
  await mkdir(path.join(options.outputDirectory, "functions"));
  await assert.rejects(packageEveSources(options), /No generated eve functions/);
});
