import { describe, expect, test } from "bun:test";
import { parseArgs, renderPlan } from "../src/cli.ts";
import type { Plan, Suggestion } from "../src/types.ts";

describe("parseArgs", () => {
  test("parses from and to", () => {
    const result = parseArgs(["npm", "pnpm"]);
    expect(result).toEqual({
      kind: "run",
      options: { from: "npm", to: "pnpm", yes: false, keepNodeModules: false, noImport: false },
    });
  });

  test("accepts flags in any order", () => {
    const result = parseArgs(["-y", "npm", "pnpm", "--keep-node-modules", "--no-import"]);
    expect(result.kind).toBe("run");
    if (result.kind !== "run") return;
    expect(result.options).toEqual({
      from: "npm",
      to: "pnpm",
      yes: true,
      keepNodeModules: true,
      noImport: true,
    });
  });

  test("recognises help and version", () => {
    expect(parseArgs(["--help"]).kind).toBe("help");
    expect(parseArgs(["-h"]).kind).toBe("help");
    expect(parseArgs(["--version"]).kind).toBe("version");
    expect(parseArgs(["-v"]).kind).toBe("version");
  });

  test("rejects unknown package managers", () => {
    const result = parseArgs(["cargo", "pnpm"]);
    expect(result).toEqual({ kind: "error", message: expect.stringContaining("unknown package manager: cargo") });
  });

  test("rejects identical source and target", () => {
    expect(parseArgs(["npm", "npm"])).toEqual({
      kind: "error",
      message: expect.stringContaining("same"),
    });
  });

  test("rejects missing arguments", () => {
    expect(parseArgs(["npm"]).kind).toBe("error");
    expect(parseArgs([]).kind).toBe("error");
  });

  test("rejects unknown options", () => {
    expect(parseArgs(["--bogus"])).toEqual({ kind: "error", message: "unknown option: --bogus" });
  });

  test("rejects extra positionals", () => {
    const result = parseArgs(["npm", "pnpm", "extra"]);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("unexpected extra arguments: extra");
  });
});

function planWith(suggestions: Suggestion[]): Plan {
  return {
    from: "npm",
    to: "pnpm",
    root: "/proj",
    targetVersion: "12.9.0",
    actions: [],
    warnings: [],
    suggestions,
  };
}

describe("renderPlan", () => {
  test("prints dist suggestions with their location", () => {
    const text = renderPlan(
      planWith([{ file: "dist/index.js", line: 2, column: 7, match: "npm", replacement: "pnpm" }]),
      false,
    );

    expect(text).toContain('suggestions (dist/ references "npm")');
    expect(text).toContain("dist/index.js:2:7");
    expect(text).toContain('"npm"');
    expect(text).toContain('"pnpm"');
  });

  test("caps the list at 20 entries", () => {
    const suggestions: Suggestion[] = Array.from({ length: 21 }, (_, i) => ({
      file: "dist/index.js",
      line: i + 1,
      column: 1,
      match: "npm",
      replacement: "pnpm",
    }));

    const text = renderPlan(planWith(suggestions), false);
    expect(text).toContain("dist/index.js:20:1");
    expect(text).not.toContain("dist/index.js:21:1");
    expect(text).toContain("… and 1 more");
  });

  test("omits the block when there are no suggestions", () => {
    expect(renderPlan(planWith([]), false)).not.toContain("suggestions");
  });
});
