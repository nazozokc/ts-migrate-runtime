import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { MigrationError } from "./plan.ts";
import type { Plan, PlanAction } from "./types.ts";

export interface ApplyOptions {
  /** Called before each action runs, for progress output. */
  onAction?: (action: PlanAction) => void;
}

/** Apply a plan to disk. Throws {@link MigrationError} on the first failure. */
export async function applyPlan(plan: Plan, opts: ApplyOptions = {}): Promise<void> {
  for (const action of plan.actions) {
    opts.onAction?.(action);
    switch (action.kind) {
      case "write": {
        const path = resolve(plan.root, action.path);
        await mkdir(dirname(path), { recursive: true });
        await Bun.write(path, action.content);
        break;
      }
      case "delete": {
        await rm(resolve(plan.root, action.path), { recursive: true, force: true });
        break;
      }
      case "run": {
        const proc = Bun.spawnSync({
          cmd: action.cmd,
          cwd: plan.root,
          stdout: "inherit",
          stderr: "inherit",
        });
        if (proc.exitCode !== 0) {
          throw new MigrationError(`command failed (exit ${proc.exitCode}): ${action.cmd.join(" ")}`);
        }
        break;
      }
    }
  }
}
