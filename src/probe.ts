import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import { resolve } from "node:path";
import { PACKAGE_MANAGERS, PM_IDS } from "./managers.ts";
import type { FsProbe, PmId } from "./types.ts";

/** Recursively list files below `relDir`, skipping symlinks and unreadable dirs. */
function listFilesRecursive(root: string, relDir: string): string[] {
  const files: string[] = [];
  const visit = (rel: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(resolve(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(child);
      } else if (entry.isFile()) {
        files.push(child);
      }
    }
  };
  visit(relDir);
  return files.sort();
}

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
    listFiles: (rel) => listFilesRecursive(root, rel),
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

function packageManagerField(pkg: Record<string, unknown> | undefined): PmId | undefined {
  const value = pkg?.["packageManager"];
  if (typeof value !== "string") return undefined;
  const [name] = value.split("@");
  return PM_IDS.find((id) => id === name);
}

/** Best-effort guess of the project's current package manager. */
export function detectFrom(probe: FsProbe): PmId | undefined {
  const pkg = probe.readJson("package.json");
  const fromField = packageManagerField(pkg);
  if (fromField) return fromField;

  const matches = PM_IDS.filter((id) => PACKAGE_MANAGERS[id].lockfiles.some((lockfile) => probe.exists(lockfile)));
  return matches.length === 1 ? matches[0] : undefined;
}
