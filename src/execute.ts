import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PACKAGE_MANAGERS } from "./managers.ts";
import { MigrationError } from "./plan.ts";
import { createFsProbe } from "./probe.ts";
import type { FsProbe, Plan, PlanAction } from "./types.ts";

export interface ApplyOptions {
  /** Called before each action runs, for progress output. */
  onAction?: (action: PlanAction) => void;
  /** Back up overwritten/deleted paths and roll back if an action fails (default: true). */
  backup?: boolean;
}

interface Backup {
  dir: string;
  writes: Array<{ path: string; backup?: string }>;
  deletes: Array<{ path: string; backup: string }>;
}

function backupDir(root: string): string {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  let candidate = resolve(root, `.ts-migrate-backup-${stamp}`);
  for (let i = 1; existsSync(candidate); i++) {
    candidate = resolve(root, `.ts-migrate-backup-${stamp}-${i}`);
  }
  return candidate;
}

function backupPath(dir: string, rel: string): string {
  return resolve(dir, rel);
}

function changedPaths(plan: Plan): { writes: string[]; deletes: string[] } {
  const writes: string[] = [];
  const deletes: string[] = [];
  for (const action of plan.actions) {
    if (action.kind === "write") writes.push(action.path);
    if (action.kind === "delete") deletes.push(action.path);
  }
  return { writes, deletes };
}

async function createBackup(plan: Plan): Promise<Backup> {
  const dir = backupDir(plan.root);
  await mkdir(dir, { recursive: true });
  const { writes, deletes } = changedPaths(plan);
  const writeBackups: Backup["writes"] = [];

  for (const rel of writes) {
    const path = resolve(plan.root, rel);
    if (!existsSync(path)) {
      writeBackups.push({ path });
      continue;
    }
    if (!(await lstat(path)).isFile()) {
      throw new MigrationError(`cannot back up ${rel}: not a regular file`);
    }
    const backup = backupPath(dir, rel);
    await mkdir(dirname(backup), { recursive: true });
    await copyFile(path, backup);
    writeBackups.push({ path, backup });
  }

  return {
    dir,
    writes: writeBackups,
    deletes: deletes.map((rel) => ({
      path: resolve(plan.root, rel),
      backup: backupPath(dir, rel),
    })),
  };
}

async function restore(backup: Backup): Promise<void> {
  // Reverse order: a run action may have recreated a path that was deleted earlier.
  for (const entry of [...backup.deletes].reverse()) {
    if (!existsSync(entry.backup)) continue;
    await rm(entry.path, { recursive: true, force: true });
    await mkdir(dirname(entry.path), { recursive: true });
    await rename(entry.backup, entry.path);
  }
  for (const entry of [...backup.writes].reverse()) {
    if (entry.backup) {
      await mkdir(dirname(entry.path), { recursive: true });
      await copyFile(entry.backup, entry.path);
    } else {
      await rm(entry.path, { force: true });
    }
  }
  await rm(backup.dir, { recursive: true, force: true });
}

/** Apply a plan to disk. On failure, file changes are rolled back. */
export async function applyPlan(plan: Plan, opts: ApplyOptions = {}): Promise<void> {
  const useBackup = opts.backup ?? true;
  let backup: Backup | undefined;
  if (useBackup) {
    try {
      backup = await createBackup(plan);
    } catch (error) {
      throw new MigrationError(
        `could not create a backup before applying: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  try {
    for (const action of plan.actions) {
      opts.onAction?.(action);
      switch (action.kind) {
        case "write": {
          const path = resolve(plan.root, action.path);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, action.content, "utf8");
          break;
        }
        case "delete": {
          const entry = backup?.deletes.find((item) => item.path === resolve(plan.root, action.path));
          if (entry && existsSync(entry.path)) {
            await mkdir(dirname(entry.backup), { recursive: true });
            await rename(entry.path, entry.backup);
          } else {
            await rm(resolve(plan.root, action.path), { recursive: true, force: true });
          }
          break;
        }
        case "run": {
          const [command, ...args] = action.cmd;
          const proc = spawnSync(command!, args, {
            cwd: plan.root,
            stdio: "inherit",
          });
          if (proc.error || proc.status !== 0) {
            const detail = proc.error?.message ?? `exit ${proc.status}`;
            throw new MigrationError(`command failed (${detail}): ${action.cmd.join(" ")}`);
          }
          break;
        }
      }
    }
  } catch (error) {
    if (!backup) throw error;
    try {
      await restore(backup);
    } catch (rollbackError) {
      throw new MigrationError(
        `migration failed and rollback was incomplete; recover manually from ${backup.dir}: ` +
          `${error instanceof Error ? error.message : String(error)}; ` +
          `${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new MigrationError(`${detail} (changes rolled back)`);
  }

  if (backup) await rm(backup.dir, { recursive: true, force: true });
}

/** Check the result of an applied plan and return non-fatal warnings. */
export function verifyPlan(plan: Plan, probe: FsProbe = createFsProbe(plan.root)): string[] {
  const warnings: string[] = [];
  const toDef = PACKAGE_MANAGERS[plan.to];
  const fromDef = PACKAGE_MANAGERS[plan.from];

  if (!toDef.lockfiles.some((file) => probe.exists(file))) {
    warnings.push(
      `${plan.to} did not generate a lockfile (${toDef.lockfiles.join(", ")}); check the install step`,
    );
  }
  const remainingSource = fromDef.lockfiles.filter((file) => probe.exists(file));
  if (remainingSource.length > 0) {
    warnings.push(`source lockfile still present after migration: ${remainingSource.join(", ")}`);
  }
  if (plan.targetVersion) {
    const pkg = probe.readJson("package.json");
    const expected = `${plan.to}@${plan.targetVersion}`;
    if (pkg && pkg["packageManager"] !== expected) {
      warnings.push(`"packageManager" is not "${expected}" after migration`);
    }
  }
  return warnings;
}
