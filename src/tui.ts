import * as p from "@clack/prompts";
import { applyPlan, verifyPlan } from "./execute.ts";
import { PACKAGE_MANAGERS, PM_IDS } from "./managers.ts";
import { MigrationError, buildPlan } from "./plan.ts";
import { detectFrom, detectVersion } from "./probe.ts";
import { renderPlan } from "./render.ts";
import type { FsProbe, Plan, PmId } from "./types.ts";
import { color } from "./ui.ts";

export interface InteractiveTuiOptions {
  from?: PmId;
  to?: PmId;
  keepNodeModules: boolean;
  noImport: boolean;
}

type Cancel = symbol;

export interface Prompter {
  intro(title: string): void;
  selectFrom(initialValue?: PmId): Promise<PmId | Cancel>;
  selectTo(from: PmId, initialValue?: PmId): Promise<PmId | Cancel>;
  selectOptions(initial: { noImport: boolean; keepNodeModules: boolean }): Promise<
    { noImport: boolean; keepNodeModules: boolean } | Cancel
  >;
  confirmApply(): Promise<"apply" | "dry-run" | "cancel" | Cancel>;
  note(message: string, title?: string): void;
  logWarn(message: string): void;
  logStep(message: string): void;
  outro(message: string): void;
  cancel(message: string): void;
  isCancel(value: unknown): value is Cancel;
}

function pmLabel(id: PmId, detectedFrom?: PmId): string {
  const base = PACKAGE_MANAGERS[id].label;
  return id === detectedFrom ? `${base} (detected)` : base;
}

export function createClackPrompter(): Prompter {
  return {
    intro: (title) => p.intro(title),
    selectFrom: (initialValue) =>
      p.select({
        message: "Which package manager are you migrating from?",
        initialValue,
        options: PM_IDS.map((id) => ({ value: id, label: pmLabel(id, initialValue) })),
      }) as Promise<PmId | Cancel>,
    selectTo: (from, initialValue) =>
      p.select({
        message: "Which package manager do you want to migrate to?",
        initialValue: initialValue && initialValue !== from ? initialValue : undefined,
        options: PM_IDS.filter((id) => id !== from).map((id) => ({
          value: id,
          label: PACKAGE_MANAGERS[id].label,
        })),
      }) as Promise<PmId | Cancel>,
    selectOptions: async (initial) => {
      const initialValues: string[] = [];
      if (initial.noImport) initialValues.push("no-import");
      if (initial.keepNodeModules) initialValues.push("keep-node-modules");
      const result = await p.multiselect({
        message: "Options",
        required: false,
        initialValues,
        options: [
          {
            value: "no-import",
            label: "Skip lockfile import",
            hint: "resolve fresh from package.json",
          },
          {
            value: "keep-node-modules",
            label: "Keep node_modules",
            hint: "do not delete the existing dependency tree",
          },
        ],
      });
      if (p.isCancel(result)) return result;
      const selected = new Set(result);
      return {
        noImport: selected.has("no-import"),
        keepNodeModules: selected.has("keep-node-modules"),
      };
    },
    confirmApply: () =>
      p.select({
        message: "What next?",
        options: [
          { value: "apply", label: "Apply migration", hint: "writes files and runs commands" },
          { value: "dry-run", label: "Exit dry-run", hint: "do not change anything" },
          { value: "cancel", label: "Cancel" },
        ],
      }) as Promise<"apply" | "dry-run" | "cancel" | Cancel>,
    note: (message, title) => p.note(message, title),
    logWarn: (message) => p.log.warn(message),
    logStep: (message) => p.log.step(message),
    outro: (message) => p.outro(message),
    cancel: (message) => p.cancel(message),
    isCancel: (value): value is Cancel => p.isCancel(value),
  };
}

function cancelled(prompter: Prompter): number {
  prompter.cancel("Migration cancelled.");
  return 1;
}

function isTTY(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function runInteractive(
  root: string,
  probe: FsProbe,
  initial: InteractiveTuiOptions,
  deps: {
    prompter?: Prompter;
    isTTY?: () => boolean;
    apply?: typeof applyPlan;
  } = {},
): Promise<number> {
  if (!(deps.isTTY ?? isTTY)()) {
    throw new MigrationError("interactive mode requires a TTY");
  }

  const prompter = deps.prompter ?? createClackPrompter();
  prompter.intro(color.bold("ts-migrate-runtime"));

  const detectedFrom = initial.from ?? detectFrom(probe);

  const from = initial.from ?? (await prompter.selectFrom(detectedFrom));
  if (prompter.isCancel(from)) return cancelled(prompter);

  const to = initial.to ?? (await prompter.selectTo(from, initial.to));
  if (prompter.isCancel(to)) return cancelled(prompter);

  if (from === to) {
    throw new MigrationError(`source and target are the same (${from})`);
  }

  const options = await prompter.selectOptions({
    noImport: initial.noImport,
    keepNodeModules: initial.keepNodeModules,
  });
  if (prompter.isCancel(options)) return cancelled(prompter);

  let plan: Plan;
  try {
    plan = buildPlan({
      from,
      to,
      root,
      probe,
      targetVersion: detectVersion(to),
      keepNodeModules: options.keepNodeModules,
      noImport: options.noImport,
    });
  } catch (error) {
    if (error instanceof MigrationError) {
      prompter.cancel(error.message);
      return 1;
    }
    throw error;
  }

  prompter.note(renderPlan(plan, false), "Migration plan");
  for (const warning of plan.warnings) prompter.logWarn(warning);

  const next = await prompter.confirmApply();
  if (prompter.isCancel(next) || next === "cancel") return cancelled(prompter);
  if (next === "dry-run") {
    prompter.outro("Dry run complete. No changes were made.");
    return 0;
  }
  if (!plan.targetVersion) {
    prompter.cancel(`target package manager "${to}" is not installed; install it before applying`);
    return 1;
  }

  const apply = deps.apply ?? applyPlan;
  const spinner = p.spinner();
  spinner.start("Applying migration...");
  try {
    await apply(plan, {
      onAction: (action) => {
        const target = action.kind === "run" ? action.cmd.join(" ") : action.path;
        spinner.message(`${action.kind}: ${target}`);
      },
    });
  } catch (error) {
    spinner.stop("Migration failed.");
    if (error instanceof MigrationError) {
      prompter.cancel(error.message);
      return 1;
    }
    throw error;
  }

  spinner.stop("Migration applied.");
  for (const warning of verifyPlan(plan, probe)) prompter.logWarn(warning);
  prompter.outro(color.green(`Migrated ${PACKAGE_MANAGERS[from].label} → ${PACKAGE_MANAGERS[to].label}`));
  return 0;
}
