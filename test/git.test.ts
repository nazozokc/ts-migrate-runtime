import { describe, expect, test } from "bun:test";
import { dirtyWorktree, dirtyWorktreeWarning, parseStatusOutput } from "../src/git.ts";

describe("parseStatusOutput", () => {
  test("extracts paths from porcelain lines", () => {
    const output = " M package.json\nD  old-lockfile\n?? ignored.txt\n";
    expect(parseStatusOutput(output)).toEqual(["package.json", "old-lockfile", "ignored.txt"]);
  });

  test("handles empty output", () => {
    expect(parseStatusOutput("\n")).toEqual([]);
  });
});

describe("dirtyWorktree", () => {
  test("reports changed tracked files", () => {
    const status = dirtyWorktree("/proj", () => ({
      status: 0,
      stdout: " M package.json\n",
    }));

    expect(status).toEqual({ dirty: true, files: ["package.json"] });
    expect(dirtyWorktreeWarning(status, "/proj")).toContain("Commit or stash first");
  });

  test("treats a clean tree, missing git and non-repositories as clean", () => {
    const clean = () => ({ status: 0, stdout: "" });
    const missingGit = () => ({ status: 0, error: new Error("ENOENT") });
    const outsideRepo = () => ({ status: 128, stdout: "" });

    expect(dirtyWorktree("/proj", clean).dirty).toBe(false);
    expect(dirtyWorktree("/proj", missingGit).dirty).toBe(false);
    expect(dirtyWorktree("/proj", outsideRepo).dirty).toBe(false);
  });

  test("caps the file list in the warning", () => {
    const files = Array.from({ length: 8 }, (_, i) => `file-${i}`);
    const warning = dirtyWorktreeWarning({ dirty: true, files }, "/proj");

    expect(warning).toContain("file-4");
    expect(warning).not.toContain("file-5");
    expect(warning).toContain("+3 more");
  });
});
