import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPlan, verifyPlan } from "../src/execute.ts";
import { MigrationError } from "../src/plan.ts";
import type { Plan, PlanAction } from "../src/types.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ts-migrate-runtime-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function plan(actions: PlanAction[]): Plan {
  return {
    from: "npm",
    to: "pnpm",
    root,
    targetVersion: "10.0.0",
    actions,
    warnings: [],
    suggestions: [],
  };
}

async function backupDirs(): Promise<string[]> {
  return (await readdir(root)).filter((name) => name.startsWith(".ts-migrate-backup-"));
}

describe("applyPlan", () => {
  test("applies writes, moves deletes to a backup and removes the backup on success", async () => {
    await writeFile(join(root, "package.json"), "old");
    await writeFile(join(root, "package-lock.json"), "lock");

    const seen: string[] = [];
    await applyPlan(
      plan([
        { kind: "write", path: "package.json", content: "new", note: "update" },
        { kind: "delete", path: "package-lock.json", note: "old lockfile" },
        {
          kind: "run",
          cmd: [process.execPath, "-e", "process.exit(0)"],
          note: "successful command",
        },
      ]),
      { onAction: (action) => seen.push(action.kind) },
    );

    expect(await readFile(join(root, "package.json"), "utf8")).toBe("new");
    expect(await readdir(root)).not.toContain("package-lock.json");
    expect(await backupDirs()).toEqual([]);
    expect(seen).toEqual(["write", "delete", "run"]);
  });

  test("rolls back writes and deletes when a command fails", async () => {
    await writeFile(join(root, "package.json"), "original");
    await writeFile(join(root, "package-lock.json"), "original lock");

    await expect(
      applyPlan(
        plan([
          { kind: "write", path: "package.json", content: "changed", note: "update" },
          { kind: "delete", path: "package-lock.json", note: "old lockfile" },
          {
            kind: "run",
            cmd: [process.execPath, "-e", "process.exit(1)"],
            note: "failing command",
          },
        ]),
      ),
    ).rejects.toThrow(/changes rolled back/);

    expect(await readFile(join(root, "package.json"), "utf8")).toBe("original");
    expect(await readFile(join(root, "package-lock.json"), "utf8")).toBe("original lock");
    expect(await backupDirs()).toEqual([]);
  });

  test("rolls back when a progress callback aborts", async () => {
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");

    await expect(
      applyPlan(
        plan([
          { kind: "write", path: "file.txt", content: "created", note: "new file" },
          { kind: "delete", path: "pnpm-workspace.yaml", note: "old config" },
        ]),
        {
          onAction: (action) => {
            if (action.kind === "delete") throw new Error("aborted by user");
          },
        },
      ),
    ).rejects.toThrow(/aborted by user.*changes rolled back/);

    expect(await readdir(root)).not.toContain("file.txt");
    expect(await readFile(join(root, "pnpm-workspace.yaml"), "utf8")).toContain("packages:");
    expect(await backupDirs()).toEqual([]);
  });

  test("backup: false leaves changes untouched on failure", async () => {
    await writeFile(join(root, "package.json"), "original");

    await expect(
      applyPlan(
        plan([
          { kind: "write", path: "package.json", content: "changed", note: "update" },
          {
            kind: "run",
            cmd: [process.execPath, "-e", "process.exit(1)"],
            note: "failing command",
          },
        ]),
        { backup: false },
      ),
    ).rejects.toThrow(MigrationError);

    expect(await readFile(join(root, "package.json"), "utf8")).toBe("changed");
    expect(await backupDirs()).toEqual([]);
  });

  test("restores a deleted directory even when the install recreated it", async () => {
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "node_modules", "keep.txt"), "cached");

    await expect(
      applyPlan(
        plan([
          { kind: "delete", path: "node_modules", note: "old layout" },
          {
            kind: "run",
            cmd: [process.execPath, "-e", 'import("node:fs").then((fs) => fs.mkdirSync("node_modules"))'],
            note: "recreates node_modules",
          },
          {
            kind: "run",
            cmd: [process.execPath, "-e", "process.exit(1)"],
            note: "failing command",
          },
        ]),
      ),
    ).rejects.toThrow(/changes rolled back/);

    expect(await readFile(join(root, "node_modules", "keep.txt"), "utf8")).toBe("cached");
  });
});

describe("applyPlan backup retention", () => {
  test("keeps the backup directory and reports its path on request", async () => {
    await writeFile(join(root, "package.json"), "original");
    let reported: string | undefined;

    await applyPlan(
      plan([{ kind: "write", path: "package.json", content: "changed", note: "update" }]),
      {
        keepBackup: true,
        onBackup: (dir) => {
          reported = dir;
        },
      },
    );

    expect(reported).toBeDefined();
    expect(await readFile(join(root, "package.json"), "utf8")).toBe("changed");
    expect(await backupDirs()).toHaveLength(1);
    expect(await readFile(join(reported!, "package.json"), "utf8")).toBe("original");
  });

  test("removes the backup directory by default", async () => {
    await writeFile(join(root, "package.json"), "original");

    await applyPlan(plan([{ kind: "write", path: "package.json", content: "changed", note: "update" }]));

    expect(await backupDirs()).toEqual([]);
  });
});

describe("verifyPlan", () => {
  test("reports a missing target lockfile, a stale source lockfile and a stale packageManager", async () => {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ packageManager: "npm@11.0.0" }),
    );
    await writeFile(join(root, "package-lock.json"), "{}");

    const warnings = verifyPlan(plan([]));
    expect(warnings.some((w) => w.includes("pnpm did not generate a lockfile"))).toBe(true);
    expect(warnings.some((w) => w.includes("source lockfile still present"))).toBe(true);
    expect(warnings.some((w) => w.includes('"packageManager" is not "pnpm@10.0.0"'))).toBe(true);
  });

  test("is quiet when the result looks correct", async () => {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ packageManager: "pnpm@10.0.0" }),
    );
    await writeFile(join(root, "pnpm-lock.yaml"), "{}");

    expect(verifyPlan(plan([]))).toEqual([]);
  });
});
