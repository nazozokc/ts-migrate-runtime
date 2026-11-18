import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PACKAGE_MANAGERS } from "./managers.ts";
import type { FsProbe, PmId } from "./types.ts";

/** Filesystem-backed {@link FsProbe} rooted at `root`. */
export function createFsProbe(root: string): FsProbe {
  const abs = (rel: string) => resolve(root, rel);
  return {
    exists: (rel) => existsSync(abs(rel)),
    readText: (rel) => {
      try {
        return readFileSync(abs(rel), "utf8");
      } catch {
        return undefined;
      }
    },
    readJson: (rel) => {
      try {
        const parsed: unknown = JSON.parse(readFileSync(abs(rel), "utf8"));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/** Detect the installed version of a package manager, or undefined. */
export function detectVersion(pm: PmId): string | undefined {
  try {
    const proc = Bun.spawnSync({
      cmd: PACKAGE_MANAGERS[pm].versionCmd,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (proc.exitCode !== 0) return undefined;
    const out = proc.stdout.toString().trim();
    const match = out.match(/\d+\.\d+\.\d+[^\s]*/);
    return match ? match[0] : out || undefined;
  } catch {
    return undefined;
  }
}
