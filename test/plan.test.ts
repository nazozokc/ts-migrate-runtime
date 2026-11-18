import { describe, expect, test } from "bun:test";
import { MigrationError, buildPlan } from "../src/plan.ts";
import type { Plan, PlanAction } from "../src/types.ts";
import { fakeProbe } from "./helpers.ts";

const pkg = (obj: Record<string, unknown>) => JSON.stringify(obj);

function kinds(plan: Plan): string[] {
  return plan.actions.map((a: PlanAction) => `${a.kind}:${a.kind === "run" ? a.cmd.join(" ") : a.path}`);
}

function runCommands(plan: Plan): string[] {
  return plan.actions.filter((a) => a.kind === "run").map((a) => (a as Extract<PlanAction, { kind: "run" }>).cmd.join(" "));
}

describe("buildPlan", () => {
  test("npm → pnpm moves workspaces, imports lockfile and reinstalls", () => {
    const plan = buildPlan({
      from: "npm",
      to: "pnpm",
      root: "/proj",
      targetVersion: "12.9.0",
      probe: fakeProbe({
        files: {
          "package.json": pkg({ name: "app", workspaces: ["packages/*"] }),
          "package-lock.json": "{}",
        },
        dirs: ["node_modules"],
      }),
    });

    expect(kinds(plan)).toEqual([
      "write:pnpm-workspace.yaml",
      "write:package.json",
      "run:pnpm import",
      "delete:node_modules",
      "delete:package-lock.json",
      "run:pnpm install",
    ]);

    const yaml = plan.actions[0] as Extract<PlanAction, { kind: "write" }>;
    expect(yaml.content).toContain("packages:");
    expect(yaml.content).toContain("packages/*");

    const json = plan.actions[1] as Extract<PlanAction, { kind: "write" }>;
    const parsed = JSON.parse(json.content) as Record<string, unknown>;
    expect(parsed["packageManager"]).toBe("pnpm@12.9.0");
    expect(parsed["workspaces"]).toBeUndefined();
    expect(json.content.endsWith("\n")).toBe(true);
  });

  test("pnpm → npm moves packages out of pnpm-workspace.yaml", () => {
    const plan = buildPlan({
      from: "pnpm",
      to: "npm",
      root: "/proj",
      targetVersion: "11.20.0",
      probe: fakeProbe({
        files: {
          "package.json": pkg({ name: "app" }),
          "pnpm-workspace.yaml": "packages:\n  - packages/*\noverrides:\n  left-pad: 1.3.0\n",
          "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
        },
        dirs: ["node_modules"],
      }),
    });

    expect(kinds(plan)).toEqual([
      "write:pnpm-workspace.yaml",
      "write:package.json",
      "delete:node_modules",
      "delete:pnpm-lock.yaml",
      "run:npm install",
    ]);

    const yaml = plan.actions[0] as Extract<PlanAction, { kind: "write" }>;
    expect(yaml.content).toContain("overrides:");
    expect(yaml.content).not.toContain("packages:");

    const json = plan.actions[1] as Extract<PlanAction, { kind: "write" }>;
    const parsed = JSON.parse(json.content) as Record<string, unknown>;
    expect(parsed["workspaces"]).toEqual(["packages/*"]);
    expect(parsed["packageManager"]).toBe("npm@11.20.0");

    expect(plan.warnings.some((w) => w.includes("pnpm-specific settings"))).toBe(true);
    expect(plan.warnings.some((w) => w.includes("resolved fresh"))).toBe(true);
  });

  test("pnpm-workspace.yaml is removed when nothing else remains", () => {
    const plan = buildPlan({
      from: "pnpm",
      to: "bun",
      root: "/proj",
      targetVersion: "1.4.4",
      probe: fakeProbe({
        files: {
          "package.json": pkg({ name: "app" }),
          "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
          "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
        },
      }),
    });

    expect(kinds(plan)).toEqual([
      "delete:pnpm-workspace.yaml",
      "write:package.json",
      "run:bun pm migrate",
      "delete:pnpm-lock.yaml",
      "run:bun install",
    ]);
  });

  test("deletes a stale target lockfile before importing", () => {
    const plan = buildPlan({
      from: "npm",
      to: "bun",
      root: "/proj",
      targetVersion: "1.4.4",
      probe: fakeProbe({
        files: {
          "package.json": pkg({ name: "app" }),
          "package-lock.json": "{}",
          "bun.lock": "{}",
        },
      }),
    });

    expect(kinds(plan)).toEqual([
      "write:package.json",
      "delete:bun.lock",
      "run:bun pm migrate",
      "delete:package-lock.json",
      "run:bun install",
    ]);
    expect(plan.warnings.some((w) => w.includes("existing bun lockfile"))).toBe(true);
  });

  test("--no-import skips the import command", () => {
    const plan = buildPlan({
      from: "npm",
      to: "pnpm",
      root: "/proj",
      targetVersion: "12.9.0",
      noImport: true,
      probe: fakeProbe({
        files: { "package.json": pkg({ name: "app" }), "package-lock.json": "{}" },
      }),
    });

    expect(runCommands(plan)).toEqual(["pnpm install"]);
    expect(plan.warnings.some((w) => w.includes("resolved fresh"))).toBe(false);
  });

  test("--keep-node-modules keeps the existing tree", () => {
    const plan = buildPlan({
      from: "npm",
      to: "pnpm",
      root: "/proj",
      targetVersion: "12.9.0",
      keepNodeModules: true,
      probe: fakeProbe({
        files: { "package.json": pkg({ name: "app" }), "package-lock.json": "{}" },
        dirs: ["node_modules"],
      }),
    });

    expect(kinds(plan)).not.toContain("delete:node_modules");
  });

  test("warns when the target version is unknown", () => {
    const plan = buildPlan({
      from: "npm",
      to: "yarn",
      root: "/proj",
      probe: fakeProbe({ files: { "package.json": pkg({ name: "app" }) } }),
    });

    expect(plan.warnings.some((w) => w.includes("could not detect the yarn version"))).toBe(true);
    // Nothing changed in package.json, so it is not rewritten.
    expect(kinds(plan)).toEqual(["run:yarn install"]);
  });

  test("warns when no source lockfile exists", () => {
    const plan = buildPlan({
      from: "npm",
      to: "pnpm",
      root: "/proj",
      targetVersion: "12.9.0",
      probe: fakeProbe({ files: { "package.json": pkg({ name: "app" }) } }),
    });

    expect(plan.warnings.some((w) => w.includes("no npm lockfile found"))).toBe(true);
    expect(runCommands(plan)).toEqual(["pnpm install"]);
  });

  test("suggests dist files that still reference the source manager", () => {
    const plan = buildPlan({
      from: "npm",
      to: "pnpm",
      root: "/proj",
      targetVersion: "12.9.0",
      probe: fakeProbe({
        files: {
          "package.json": pkg({ name: "app" }),
          "dist/index.js": "npm install\n",
        },
        dirs: ["dist"],
      }),
    });

    expect(plan.suggestions).toEqual([
      { file: "dist/index.js", line: 1, column: 1, match: "npm", replacement: "pnpm" },
    ]);
    expect(plan.warnings.some((w) => w.includes("dist/ contains 1 reference(s) to npm"))).toBe(true);
  });

  test("has no suggestions when dist/ is absent", () => {
    const plan = buildPlan({
      from: "npm",
      to: "pnpm",
      root: "/proj",
      targetVersion: "12.9.0",
      probe: fakeProbe({ files: { "package.json": pkg({ name: "app" }) } }),
    });

    expect(plan.suggestions).toEqual([]);
    expect(plan.warnings.some((w) => w.includes("dist/ contains"))).toBe(false);
  });

  test("rejects the same source and target", () => {
    expect(() =>
      buildPlan({ from: "npm", to: "npm", root: "/proj", probe: fakeProbe({ files: {} }) }),
    ).toThrow(MigrationError);
  });

  test("rejects a missing package.json", () => {
    expect(() => buildPlan({ from: "npm", to: "pnpm", root: "/proj", probe: fakeProbe({ files: {} }) })).toThrow(
      /package\.json not found/,
    );
  });
});
