import { PACKAGE_MANAGERS, importCommand, importNeedsLockfileOnly } from "./managers.ts";
import type { FsProbe, Plan, PlanAction, PlanOptions } from "./types.ts";
import {
  PKG_JSON,
  PNPM_WORKSPACE,
  parseYamlMapping,
  stringifyPackageJson,
  stringifyYaml,
  workspacePackages,
} from "./workspaces.ts";

/** A fatal, user-facing migration error. */
export class MigrationError extends Error {
  override name = "MigrationError";
}

function hasNodeModules(probe: FsProbe): boolean {
  return probe.exists("node_modules");
}

/**
 * Build a migration plan without touching the filesystem. Pure with respect to
 * the given {@link FsProbe}, which makes it directly testable.
 */
export function buildPlan(opts: PlanOptions): Plan {
  const { from, to, root, probe } = opts;

  if (from === to) {
    throw new MigrationError(`source and target are the same (${from}); nothing to migrate`);
  }

  const fromDef = PACKAGE_MANAGERS[from];
  const toDef = PACKAGE_MANAGERS[to];

  const pkg = probe.readJson(PKG_JSON);
  if (!pkg) {
    throw new MigrationError(`${PKG_JSON} not found in ${root}`);
  }

  const actions: PlanAction[] = [];
  const warnings: string[] = [];
  const nextPkg: Record<string, unknown> = { ...pkg };
  let pkgChanged = false;

  // --- 1. workspace configuration ---
  if (toDef.workspaceSource === "pnpm-workspace.yaml") {
    const packages = workspacePackages(pkg);
    if (packages) {
      const yaml = parseYamlMapping(probe.readText(PNPM_WORKSPACE)) ?? {};
      if (yaml["packages"] !== undefined) {
        warnings.push(`${PNPM_WORKSPACE} already has "packages"; it was replaced from ${PKG_JSON}`);
      }
      yaml["packages"] = packages;
      actions.push({
        kind: "write",
        path: PNPM_WORKSPACE,
        content: stringifyYaml(yaml),
        note: `move "workspaces" from ${PKG_JSON}`,
      });
      delete nextPkg["workspaces"];
      pkgChanged = true;
    }
  } else if (fromDef.workspaceSource === "pnpm-workspace.yaml") {
    const yaml = parseYamlMapping(probe.readText(PNPM_WORKSPACE));
    const packages = yaml?.["packages"];
    if (yaml && Array.isArray(packages)) {
      if (workspacePackages(pkg)) {
        warnings.push(`${PKG_JSON} already has "workspaces"; keeping it and dropping ${PNPM_WORKSPACE} "packages"`);
      } else {
        nextPkg["workspaces"] = packages;
        pkgChanged = true;
      }
      delete yaml["packages"];
      const rest = Object.keys(yaml);
      if (rest.length === 0) {
        actions.push({ kind: "delete", path: PNPM_WORKSPACE, note: "no longer used" });
      } else {
        warnings.push(
          `${PNPM_WORKSPACE} has pnpm-specific settings (${rest.join(", ")}); they were left in place`,
        );
        actions.push({
          kind: "write",
          path: PNPM_WORKSPACE,
          content: stringifyYaml(yaml),
          note: 'drop "packages" (moved to package.json)',
        });
      }
    }
  }

  // --- 2. packageManager field ---
  if (opts.targetVersion) {
    const value = `${to}@${opts.targetVersion}`;
    if (nextPkg["packageManager"] !== value) {
      nextPkg["packageManager"] = value;
      pkgChanged = true;
    }
  } else {
    warnings.push(`could not detect the ${to} version; the "packageManager" field was left unchanged`);
  }

  if (pkgChanged) {
    actions.push({ kind: "write", path: PKG_JSON, content: stringifyPackageJson(nextPkg), note: "update package.json" });
  }

  // --- 3. lockfiles ---
  const sourceLockfiles = fromDef.lockfiles.filter((f) => probe.exists(f));
  const staleTargetLockfiles = toDef.lockfiles.filter((f) => probe.exists(f));

  if (sourceLockfiles.length === 0) {
    warnings.push(`no ${from} lockfile found (${fromDef.lockfiles.join(", ")}); migrating from ${PKG_JSON} alone`);
  }
  if (staleTargetLockfiles.length > 0) {
    warnings.push(`existing ${to} lockfile (${staleTargetLockfiles.join(", ")}) was replaced`);
  }
  // Delete stale target lockfiles first so import/install regenerate cleanly.
  for (const file of staleTargetLockfiles) {
    actions.push({ kind: "delete", path: file, note: `stale ${to} lockfile` });
  }

  // --- 4. import the source lockfile into the target ---
  const importCmd = opts.noImport ? undefined : importCommand(from, to);
  const canImport =
    importCmd !== undefined &&
    (sourceLockfiles.length > 0 || (!importNeedsLockfileOnly(to) && hasNodeModules(probe)));

  if (canImport && importCmd) {
    actions.push({
      kind: "run",
      cmd: importCmd,
      note: `import ${sourceLockfiles.length > 0 ? sourceLockfiles.join(", ") : "node_modules"} into ${to}`,
    });
  } else if (!opts.noImport) {
    warnings.push(`${to} cannot import a ${from} lockfile; dependencies will be resolved fresh and versions may change`);
  }

  // --- 5. drop the old dependency tree ---
  if (!opts.keepNodeModules && hasNodeModules(probe)) {
    actions.push({ kind: "delete", path: "node_modules", note: `dependency layout differs for ${to}` });
  }

  // --- 6. drop the source lockfiles ---
  for (const file of sourceLockfiles) {
    actions.push({ kind: "delete", path: file, note: `replaced by ${to}` });
  }

  // --- 7. install with the target manager ---
  actions.push({ kind: "run", cmd: toDef.installCmd, note: `generate ${to} lockfile and install` });

  return { from, to, root, targetVersion: opts.targetVersion, actions, warnings };
}
