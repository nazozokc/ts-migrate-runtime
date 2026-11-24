import { spawnSync } from "node:child_process";
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

/** Maximum time to wait for a `packageManager --version` call. */
const VERSION_TIMEOUT_MS = 5000;

/** Extract a version from the output of a `--version` call. */
export function parseVersionOutput(output: string): string | undefined {
  const text = output.trim();
  const match = text.match(/\d+\.\d+\.\d+[^\s]*/);
  return match ? match[0] : text || undefined;
}

/**
 * Detect the installed version of a package manager, or undefined when it is
 * missing, broken or too slow. Corepack's download prompt is disabled so a
 * missing manager fails fast instead of waiting for input.
 */
export function detectVersion(pm: PmId, opts: { timeoutMs?: number } = {}): string | undefined {
  try {
    const [command, ...args] = PACKAGE_MANAGERS[pm].versionCmd;
    const proc = spawnSync(command!, args, {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
      timeout: opts.timeoutMs ?? VERSION_TIMEOUT_MS,
    });
    if (proc.error || proc.status !== 0) return undefined;
    return parseVersionOutput(String(proc.stdout ?? ""));
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
