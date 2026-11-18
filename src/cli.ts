import { existsSync } from "node:fs";
import { applyPlan } from "./execute.ts";
import { PACKAGE_MANAGERS, PM_IDS, isPmId } from "./managers.ts";
import { MigrationError, buildPlan } from "./plan.ts";
import { createFsProbe, detectVersion } from "./probe.ts";
import type { Plan, PlanAction, PmId } from "./types.ts";
import { color, fail, info, warn } from "./ui.ts";

export interface CliOptions {
  from: PmId;
  to: PmId;
  yes: boolean;
  keepNodeModules: boolean;
  noImport: boolean;
}

export type ParseResult =
  | { kind: "run"; options: CliOptions }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

const USAGE = `ts-migrate-runtime <from> <to> [options]

Migrate the project in the current directory between package managers.

Package managers: ${PM_IDS.join(", ")}

Arguments:
  <from>                current package manager
  <to>                  target package manager

Options:
  -y, --yes             apply the migration (default: dry run)
      --keep-node-modules
                        keep the existing node_modules directory
      --no-import       skip importing the source lockfile; resolve fresh
  -h, --help            show this help
  -v, --version         show the version`;

export function helpText(): string {
  return USAGE;
}

export function parseArgs(argv: string[]): ParseResult {
  const positionals: string[] = [];
  let yes = false;
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

  if (positionals.length < 2) {
    return { kind: "error", message: "expected <from> and <to> package managers" };
  }
  if (positionals.length > 2) {
    return { kind: "error", message: `unexpected extra arguments: ${positionals.slice(2).join(" ")}` };
  }

  const [from, to] = positionals;
  if (!isPmId(from!)) {
    return { kind: "error", message: `unknown package manager: ${from} (expected one of ${PM_IDS.join(", ")})` };
  }
  if (!isPmId(to!)) {
    return { kind: "error", message: `unknown package manager: ${to} (expected one of ${PM_IDS.join(", ")})` };
  }
  if (from === to) {
    return { kind: "error", message: `source and target are the same (${from})` };
  }

  return { kind: "run", options: { from, to, yes, keepNodeModules, noImport } };
}

function describeAction(action: PlanAction): { verb: string; target: string } {
  switch (action.kind) {
    case "write":
      return { verb: "write", target: action.path };
    case "delete":
      return { verb: "delete", target: action.path };
    case "run":
      return { verb: "run", target: action.cmd.join(" ") };
  }
}

export function renderPlan(plan: Plan, apply: boolean): string {
  const lines: string[] = [];
  lines.push(`${color.bold(`${plan.from} → ${plan.to}`)}  ${color.dim(plan.root)}`);
  lines.push("");
  plan.actions.forEach((action, index) => {
    const { verb, target } = describeAction(action);
    const label = `${String(index + 1).padStart(2)}.`;
    lines.push(`  ${color.dim(label)} ${verb.padEnd(6)} ${color.cyan(target)}  ${color.dim(`(${action.note})`)}`);
  });
  if (plan.warnings.length > 0) {
    lines.push("");
    for (const warning of plan.warnings) {
      lines.push(`  ${color.yellow("warning:")} ${warning}`);
    }
  }
  if (plan.suggestions.length > 0) {
    lines.push("");
    lines.push(`  ${color.dim(`suggestions (dist/ references "${plan.from}")`)}`);
    const limit = 20;
    for (const suggestion of plan.suggestions.slice(0, limit)) {
      const location = `${suggestion.file}:${suggestion.line}:${suggestion.column}`;
      lines.push(
        `    ${color.cyan(location)}  ${color.yellow(`"${suggestion.match}"`)} → ${color.green(`"${suggestion.replacement}"`)}`,
      );
    }
    if (plan.suggestions.length > limit) {
      lines.push(`    ${color.dim(`… and ${plan.suggestions.length - limit} more`)}`);
    }
  }
  lines.push("");
  lines.push(apply ? color.dim("applying…") : color.dim("dry run — re-run with --yes to apply"));
  return lines.join("\n");
}

async function readVersion(): Promise<string> {
  try {
    const url = new URL("../package.json", import.meta.url);
    const pkg = (await Bun.file(url).json()) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);

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
  }

  const { from, to, yes, keepNodeModules, noImport } = parsed.options;
  const root = process.cwd();
  if (!existsSync(root)) {
    fail(`directory not found: ${root}`);
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
      targetVersion: detectVersion(to),
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
        const { verb, target } = describeAction(action);
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

  info("");
  info(color.green(`✓ migrated ${PACKAGE_MANAGERS[from].label} → ${PACKAGE_MANAGERS[to].label}`));
  return 0;
}
