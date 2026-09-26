import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

export function mergeEnv(local, pulled) {
  const localValues = parseEnv(local);
  const remoteValues = parseEnv(pulled);
  // Keep complete declarations, including quoted multiline values, verbatim.
  const declarations = /^[\t ]*(?:export[\t ]+)?([A-Za-z_][A-Za-z0-9_]*)[\t ]*=[\t ]*(?:'[^']*'|"[^"]*"|`[^`]*`|[^\r\n]*)[^\r\n]*/gm;
  const preserved = [...local.matchAll(declarations)]
    .filter((match) => !Object.hasOwn(remoteValues, match[1]))
    .map((match) => match[0]);
  const merged = `${pulled.trimEnd()}\n${preserved.length ? `${preserved.join("\n")}\n` : ""}`;
  const expected = { ...localValues, ...remoteValues };
  const actual = parseEnv(merged);
  // An unsupported declaration must never silently discard a local value.
  if (Object.keys(actual).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([key, value]) => actual[key] !== value)) {
    throw new Error("Could not preserve local environment variables; .env.local was left unchanged.");
  }
  return merged;
}

export function pullEnv(args = []) {
  const destination = ".env.local";
  const existed = existsSync(destination);
  const original = existed ? readFileSync(destination, "utf8") : "";
  // Keep temporary credentials inside the project's gitignored .env* paths.
  const directory = mkdtempSync(".env.pull-");
  const temporary = join(directory, ".env.local");
  try {
    const result = spawnSync("vercel", [
      "env", "pull", temporary, "--environment=development", "--yes", ...args,
    ], { stdio: "inherit" });
    if (result.error || result.status !== 0) {
      throw new Error("Vercel environment pull failed; .env.local was left unchanged.");
    }
    const merged = mergeEnv(original, readFileSync(temporary, "utf8"));
    if (existsSync(destination) !== existed ||
        (existed && readFileSync(destination, "utf8") !== original)) {
      throw new Error(".env.local changed during the pull; leaving your edits intact. Run the pull again.");
    }
    if (existed) {
      const backup = `.env.local.backup-${Date.now()}`;
      writeFileSync(backup, original, { flag: "wx", mode: 0o600 });
      console.log(`Saved existing environment to ${backup}`);
    }
    writeFileSync(temporary, merged);
    chmodSync(temporary, 0o600);
    renameSync(temporary, destination);
    console.log("Updated .env.local, preserving variables absent from Vercel.");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    pullEnv(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
