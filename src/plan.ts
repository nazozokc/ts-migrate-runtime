import { PACKAGE_MANAGERS, importCommand, majorVersion } from "./managers.ts";
import { detectFrom } from "./probe.ts";
import { scanDist } from "./scan.ts";
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
    if (probe.exists(PKG_JSON)) {
      throw new MigrationError(`${PKG_JSON} exists in ${root} but is not valid JSON or not an object`);
    }
    throw new MigrationError(`${PKG_JSON} not found in ${root}`);
  }

  const actions: PlanAction[] = [];
  const warnings: string[] = [];
  const detectedFrom = detectFrom(probe);
  if (detectedFrom && detectedFrom !== from) {
    warnings.push(`project appears to use ${detectedFrom}, but the source was given as ${from}`);
  }
  const nextPkg: Record<string, unknown> = { ...pkg };
  let pkgChanged = false;

  // --- 1. workspace configuration ---
  if (toDef.workspaceSource === "pnpm-workspace.yaml") {
    const packages = workspacePackages(pkg);
    if (packages) {
      const yamlText = probe.readText(PNPM_WORKSPACE);
      const parsedYaml = parseYamlMapping(yamlText);
      const yaml = parsedYaml ?? {};
      if (yamlText !== undefined && parsedYaml === undefined) {
        warnings.push(`${PNPM_WORKSPACE} exists but is not a valid YAML mapping; it was replaced`);
      }
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
    const yamlText = probe.readText(PNPM_WORKSPACE);
    const yaml = parseYamlMapping(yamlText);
    if (yamlText !== undefined && yaml === undefined) {
      warnings.push(`${PNPM_WORKSPACE} exists but is not a valid YAML mapping; it was left unchanged`);
    }
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
    const stale = pkg["packageManager"];
    if (stale !== undefined) {
      delete nextPkg["packageManager"];
      pkgChanged = true;
      warnings.push(
        `could not detect the ${to} version; removed stale "packageManager" (${String(stale)}) — set it manually if needed`,
      );
    } else {
      warnings.push(`could not detect the ${to} version; the "packageManager" field was left unchanged`);
    }
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
  // Every supported import command reads a lockfile; `node_modules` alone is
  // never enough. `yarn import` also disappeared in Yarn Berry (v2+).
  const yarnMajor = to === "yarn" ? majorVersion(opts.targetVersion) : undefined;
  const yarnImportUnavailable = to === "yarn" && (yarnMajor === undefined || yarnMajor >= 2);
  const importCmd = opts.noImport || yarnImportUnavailable ? undefined : importCommand(from, to);
  const canImport = importCmd !== undefined && sourceLockfiles.length > 0;

  if (canImport && importCmd) {
    actions.push({
      kind: "run",
      cmd: importCmd,
      note: `import ${sourceLockfiles.join(", ")} into ${to}`,
    });
  } else if (!opts.noImport) {
    const reason = yarnImportUnavailable
      ? yarnMajor === undefined
        ? "could not detect the yarn version, so `yarn import` was skipped"
        : `yarn ${opts.targetVersion} does not support "yarn import"`
      : `${to} cannot import a ${from} lockfile`;
    warnings.push(`${reason}; dependencies will be resolved fresh and versions may change`);
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

  // --- 8. report stale references in built output ---
  const suggestions = scanDist({ probe, from, to });
  if (suggestions.length > 0) {
    warnings.push(`dist/ contains ${suggestions.length} reference(s) to ${from}; update the source and rebuild`);
  }

  return { from, to, root, targetVersion: opts.targetVersion, actions, warnings, suggestions };
}
