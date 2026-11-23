import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { applyPlan, verifyPlan } from "./execute.ts";
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
}

export interface InteractiveOptions {
  from?: PmId;
  to?: PmId;
  /** Project directory, relative to the invocation directory. */
  root: string;
  keepNodeModules: boolean;
  noImport: boolean;
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

  if (positionals.length < 2) {
    if (interactive || (positionals.length === 0 && !yes)) {
      const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
      if (!isTTY) {
        return { kind: "error", message: "interactive mode requires a TTY" };
      }
      return { kind: "interactive", options: { from, to, root: dirArg ?? ".", keepNodeModules, noImport } };
    }
    return { kind: "error", message: "expected <from> and <to> package managers" };
  }

  if (interactive) {
    const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!isTTY) {
      return { kind: "error", message: "interactive mode requires a TTY" };
    }
    return { kind: "interactive", options: { from, to, root: dirArg ?? ".", keepNodeModules, noImport } };
  }

  return {
    kind: "run",
    options: { from: from!, to: to!, root: dirArg ?? ".", yes, keepNodeModules, noImport },
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
      if (parsed.kind === "interactive") {
        const probe = createFsProbe(root);
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

      const { from, to, yes, keepNodeModules, noImport } = parsed.options;
      const targetVersion = detectVersion(to);
      if (yes && !targetVersion) {
        fail(`target package manager "${to}" is not installed; install it before applying`);
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

      info(renderPlan(plan, yes));
      if (!yes) return 0;

      try {
        await applyPlan(plan, {
          onAction: (action) => {
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

      for (const warning of verifyPlan(plan)) warn(warning);
      info("");
      info(color.green(`✓ migrated ${PACKAGE_MANAGERS[from].label} → ${PACKAGE_MANAGERS[to].label}`));
      return 0;
    }
  }
}
