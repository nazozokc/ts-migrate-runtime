import type { Plan, PlanAction } from "./types.ts";
import { color } from "./ui.ts";

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

export function formatAction(action: PlanAction): { verb: string; target: string } {
  return describeAction(action);
}

export function renderPlan(plan: Plan, apply: boolean): string {
  const lines: string[] = [];
  lines.push(`${color.bold(`${plan.from} → ${plan.to}`)}  ${color.dim(plan.root)}`);
  lines.push("");
  if (plan.actions.length === 0) lines.push(`  ${color.dim("no changes planned")}`);
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
