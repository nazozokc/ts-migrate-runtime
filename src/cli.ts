import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { applyPlan, verifyPlan } from "./execute.ts";
import { dirtyWorktree, dirtyWorktreeWarning } from "./git.ts";
import type { DirtyWorktree } from "./git.ts";
import { PACKAGE_MANAGERS, PM_IDS, isPmId } from "./managers.ts";
import { MigrationError, buildPlan } from "./plan.ts";
import { createFsProbe, detectVersion } from "./probe.ts";
import { formatAction, renderPlan } from "./render.ts";
import { runInteractive } from "./tui.ts";
import type { Plan, PmId } from "./types.ts";
import { color, fail, info, warn } from "./ui.ts";

export interface CliOptions {
  from: PmId;
  to: PmId;
  /** Project directory, relative to the invocation directory. */
  root: string;
  yes: boolean;
  keepNodeModules: boolean;
  noImport: boolean;
  /** Apply even when tracked files have uncommitted changes. */
  allowDirty: boolean;
  /** Emit a machine-readable plan or result instead of progress output. */
  json: boolean;
  /** Retain the backup directory after a successful apply. */
  keepBackup: boolean;
}

export interface InteractiveOptions {
  from?: PmId;
  to?: PmId;
  /** Project directory, relative to the invocation directory. */
  root: string;
  keepNodeModules: boolean;
  noImport: boolean;
  keepBackup: boolean;
}

export type ParseResult =
  | { kind: "run"; options: CliOptions }
  | { kind: "interactive"; options: InteractiveOptions }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

const USAGE = `ts-migrate-runtime [from] [to] [dir] [options]

Migrate a project between package managers.

Package managers: ${PM_IDS.join(", ")}

Arguments:
  [from]                current package manager
  [to]                  target package manager
  [dir]                 project directory (default: current directory)

Options:
  -i, --interactive     launch the interactive TUI
  -y, --yes             apply the migration (default: dry run)
      --keep-node-modules
                        keep the existing node_modules directory
      --no-import       skip importing the source lockfile; resolve fresh
      --keep-backup     keep the backup directory after a successful apply
      --allow-dirty     apply even if tracked files have uncommitted changes
      --json            emit a machine-readable plan or result
  -h, --help            show this help
  -v, --version         show the version

With no arguments in a TTY, the interactive TUI starts automatically.`;

export function helpText(): string {
  return USAGE;
}

export function parseArgs(argv: string[], opts: { isTTY?: boolean } = {}): ParseResult {
  const positionals: string[] = [];
  let yes = false;
  let interactive = false;
  let keepNodeModules = false;
  let noImport = false;
  let keepBackup = false;
  let allowDirty = false;
  let json = false;
  let help = false;
  let version = false;
  let endOfOptions = false;

  for (const arg of argv) {
    if (endOfOptions) {
      positionals.push(arg);
      continue;
    }
    switch (arg) {
      case "--":
        endOfOptions = true;
        break;
      case "-h":
      case "--help":
        help = true;
        break;
      case "-v":
      case "--version":
        version = true;
        break;
      case "-i":
      case "--interactive":
        interactive = true;
        break;
      case "-y":
      case "--yes":
        yes = true;
        break;
      case "--keep-node-modules":
        keepNodeModules = true;
        break;
      case "--no-import":
        noImport = true;
        break;
      case "--keep-backup":
        keepBackup = true;
        break;
      case "--allow-dirty":
        allowDirty = true;
        break;
      case "--json":
        json = true;
        break;
      default:
        if (arg.startsWith("-") && arg !== "-") {
          return { kind: "error", message: `unknown option: ${arg}` };
        }
        positionals.push(arg);
    }
  }

  if (help) return { kind: "help" };
  if (version) return { kind: "version" };

  if (positionals.length > 3) {
    return { kind: "error", message: `unexpected extra arguments: ${positionals.slice(3).join(" ")}` };
  }

  const [fromArg, toArg, dirArg] = positionals;
  if (fromArg !== undefined && !isPmId(fromArg)) {
    return { kind: "error", message: `unknown package manager: ${fromArg} (expected one of ${PM_IDS.join(", ")})` };
  }
  if (toArg !== undefined && !isPmId(toArg)) {
    return { kind: "error", message: `unknown package manager: ${toArg} (expected one of ${PM_IDS.join(", ")})` };
  }
  if (fromArg !== undefined && toArg !== undefined && fromArg === toArg) {
    return { kind: "error", message: `source and target are the same (${fromArg})` };
  }

  const from = fromArg as PmId | undefined;
  const to = toArg as PmId | undefined;

  if (interactive || (positionals.length === 0 && !yes)) {
    if (json) {
      return { kind: "error", message: "--json cannot be used with interactive mode; pass <from> and <to>" };
    }
    const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!isTTY) {
      return { kind: "error", message: "interactive mode requires a TTY" };
    }
    return {
      kind: "interactive",
      options: { from, to, root: dirArg ?? ".", keepNodeModules, noImport, keepBackup },
    };
  }
  if (positionals.length < 2) {
    return { kind: "error", message: "expected <from> and <to> package managers" };
  }

  return {
    kind: "run",
    options: {
      from: from!,
      to: to!,
      root: dirArg ?? ".",
      yes,
      keepNodeModules,
      noImport,
      allowDirty,
      json,
      keepBackup,
    },
  };
}

export { renderPlan };

async function readVersion(): Promise<string> {
  try {
    const url = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(await readFile(url, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Machine-readable representation of a plan, shared by dry-run and apply output. */
function planJson(plan: Plan, status: DirtyWorktree): Record<string, unknown> {
  return {
    from: plan.from,
    to: plan.to,
    root: plan.root,
    targetVersion: plan.targetVersion ?? null,
    actions: plan.actions,
    warnings: plan.warnings,
    suggestions: plan.suggestions,
    dirty: status.dirty,
    dirtyFiles: status.files,
  };
}

export async function main(
  argv: string[],
  io: { isTTY?: boolean; cwd?: string } = {},
): Promise<number> {
  const isTTY = io.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const parsed = parseArgs(argv, { isTTY });

  switch (parsed.kind) {
    case "help":
      info(helpText());
      return 0;
    case "version":
      info(await readVersion());
      return 0;
    case "error":
      fail(parsed.message);
      info("");
      info(helpText());
      return 2;
    case "interactive":
    case "run": {
      const root = resolve(io.cwd ?? process.cwd(), parsed.options.root);
      if (!isDirectory(root)) {
        fail(`directory not found: ${root}`);
        return 1;
      }
      const gitStatus = dirtyWorktree(root);
      if (parsed.kind === "interactive") {
        const probe = createFsProbe(root);
        if (gitStatus.dirty) warn(dirtyWorktreeWarning(gitStatus, root));
        try {
          return await runInteractive(root, probe, parsed.options, { isTTY: () => isTTY });
        } catch (error) {
          if (error instanceof MigrationError) {
            fail(error.message);
            return 1;
          }
          throw error;
        }
      }

      const { from, to, yes, keepNodeModules, noImport, allowDirty, json, keepBackup } = parsed.options;
      const targetVersion = detectVersion(to);
      if (yes && !targetVersion) {
        fail(`target package manager "${to}" is not installed; install it before applying`);
        return 1;
      }
      if (yes && gitStatus.dirty && !allowDirty) {
        fail(`${dirtyWorktreeWarning(gitStatus, root)} Pass --allow-dirty to override.`);
        return 1;
      }

      const probe = createFsProbe(root);
      let plan: Plan;
      try {
        plan = buildPlan({
          from,
          to,
          root,
          probe,
          targetVersion,
          keepNodeModules,
          noImport,
        });
      } catch (error) {
        if (error instanceof MigrationError) {
          fail(error.message);
          return 1;
        }
        throw error;
      }

      // In --json --yes mode only the final result is written to stdout.
      if (!json || !yes) {
        if (json) {
          info(JSON.stringify(planJson(plan, gitStatus), null, 2));
        } else {
          info(renderPlan(plan, yes));
        }
      }
      if (!yes) return 0;

      let backupDir: string | undefined;
      try {
        await applyPlan(plan, {
          keepBackup,
          quietRuns: json,
          onBackup: (dir) => {
            backupDir = dir;
          },
          onAction: json
            ? undefined
            : (action) => {
                const { verb, target } = formatAction(action);
                info(`  ${color.green("→")} ${verb.padEnd(6)} ${target}`);
              },
        });
      } catch (error) {
        if (error instanceof MigrationError) {
          fail(error.message);
          return 1;
        }
        throw error;
      }

      const verifyWarnings = verifyPlan(plan);
      if (json) {
        info(
          JSON.stringify(
            {
              ...planJson(plan, gitStatus),
              applied: true,
              backupDir: backupDir ?? null,
              verifyWarnings,
            },
            null,
            2,
          ),
        );
        return 0;
      }
      for (const warning of verifyWarnings) warn(warning);
      if (backupDir) info(color.dim(`backup kept at ${backupDir}`));
      info("");
      info(color.green(`✓ migrated ${PACKAGE_MANAGERS[from].label} → ${PACKAGE_MANAGERS[to].label}`));
      return 0;
    }
  }
}
