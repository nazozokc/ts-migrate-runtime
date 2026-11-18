import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli.ts";

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
