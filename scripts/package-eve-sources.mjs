import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// These are the three original files used by the registered nine-unit mission.
export const MISSION_SOURCE_NAMES = [
  "FDT-A-MS-R23.xer",
  "SOE-Master-Schedule.xlsx",
  "Daily-Construction-Report-july12-july17.xlsx",
];
const sourceRelativeDirectory = "data/kiewit/bp-tunnel";
const manifestRelativePath = "apps/web/lib/project-files/source-manifest.json";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function inside(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function nodeFunctionDirectories(outputDirectory) {
  const root = await realpath(path.join(outputDirectory, "functions"));
  const functions = new Set();
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.name.endsWith(".func") && (entry.isDirectory() || entry.isSymbolicLink())) {
        const resolved = await realpath(candidate);
        if (!inside(root, resolved)) throw new Error("A generated function resolves outside the build output.");
        const config = JSON.parse(await readFile(path.join(resolved, ".vc-config.json"), "utf8"));
        if (typeof config.runtime !== "string" || !config.runtime.startsWith("nodejs")) {
          throw new Error("Private mission sources require a generated Node.js function.");
        }
        functions.add(resolved);
      } else if (entry.isDirectory()) {
        await visit(candidate);
      }
    }
  }
  await visit(root);
  if (!functions.size) throw new Error("No generated eve functions were found for private source packaging.");
  return [...functions];
}

export async function packageEveSources({ root = repositoryRoot, outputDirectory } = {}) {
  if (!outputDirectory) throw new Error("The generated eve build output directory is required.");
  const manifest = JSON.parse(await readFile(path.join(root, manifestRelativePath), "utf8"));
  const sources = [];
  for (const name of MISSION_SOURCE_NAMES) {
    const registered = manifest.files.find((file) => file.name === name);
    if (!registered) throw new Error(`Mission source is not registered: ${name}`);
    const bytes = await readFile(path.join(root, sourceRelativeDirectory, name));
    if (bytes.length !== registered.bytes || createHash("sha256").update(bytes).digest("hex") !== registered.sha256) {
      throw new Error(`Mission source does not match its registered bytes and hash: ${name}`);
    }
    sources.push({ name, bytes });
  }
  const functions = await nodeFunctionDirectories(path.resolve(root, outputDirectory));
  for (const directory of functions) {
    const destination = path.join(directory, sourceRelativeDirectory);
    await mkdir(destination, { recursive: true });
    for (const source of sources) await writeFile(path.join(destination, source.name), source.bytes);
  }
  return { sourceCount: sources.length, functionCount: functions.length, bytesPerFunction: sources.reduce((sum, source) => sum + source.bytes.length, 0) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await packageEveSources({ outputDirectory: process.env.EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY });
  console.log(`Packaged ${result.sourceCount} verified private mission sources (${result.bytesPerFunction} bytes) in ${result.functionCount} eve functions.`);
}
