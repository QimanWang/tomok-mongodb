import { existsSync } from "node:fs";
import path from "node:path";

/** Support both repository-root commands and the apps/web service's working directory. */
export function projectSourceDirectory(cwd = process.cwd()) {
  const relativePath = "data/kiewit/bp-tunnel";
  const candidates = [
    path.resolve(cwd, relativePath),
    path.resolve(cwd, "../..", relativePath),
  ];
  return candidates.find((directory) => existsSync(directory)) ?? candidates[0];
}
