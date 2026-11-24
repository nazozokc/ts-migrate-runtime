import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ts-migrate-main-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function quiet(run: () => Promise<number>): Promise<number> {
  const out = spyOn(process.stdout, "write").mockImplementation(() => true);
  const err = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    return await run();
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

async function captureOutput(run: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err += String(chunk);
    return true;
  });
  try {
    const code = await run();
    return { code, out, err };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

describe("main safety and output", () => {
  test("refuses to apply when tracked files are dirty", async () => {
    const git = (args: string[]) => spawnSync("git", args, { cwd: root, stdio: "ignore" });
    expect(git(["init", "-q"]).status).toBe(0);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "app" }));
    expect(git(["add", "package.json"]).status).toBe(0);
    expect(
      git(["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "init"]).status,
    ).toBe(0);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "changed" }));

    const { code, err } = await captureOutput(() =>
      main(["npm", "bun", "--yes"], { cwd: root, isTTY: false }),
    );

    expect(code).toBe(1);
    expect(err).toContain("uncommitted changes");
    expect(err).toContain("--allow-dirty");
  });

  test("--json --yes prints only the final result object", async () => {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "app" }));

    const { code, out } = await captureOutput(() =>
      main(["npm", "bun", "--json", "--yes", "--no-import"], { cwd: root, isTTY: false }),
    );

    expect(code).toBe(0);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed["applied"]).toBe(true);
    expect(out.trim().endsWith("}")).toBe(true);
  });

  test("--json emits the plan without progress text in dry-run mode", async () => {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "app" }));

    const { code, out } = await captureOutput(() =>
      main(["npm", "bun", "--json"], { cwd: root, isTTY: false }),
    );

    expect(code).toBe(0);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed["from"]).toBe("npm");
    expect(parsed["to"]).toBe("bun");
    expect(parsed["applied"]).toBeUndefined();
    expect(parsed["dirty"]).toBe(false);
    expect(Array.isArray(parsed["actions"])).toBe(true);
  });
});

describe("main directory handling", () => {
  test("accepts a project directory as the third positional", async () => {
    await mkdir(join(root, "app"));
    await writeFile(join(root, "app", "package.json"), JSON.stringify({ name: "app" }));

    const code = await quiet(() => main(["npm", "pnpm", "app"], { cwd: root, isTTY: false }));
    expect(code).toBe(0);
  });

  test("rejects a missing directory", async () => {
    const code = await quiet(() => main(["npm", "pnpm", "missing"], { cwd: root, isTTY: false }));
    expect(code).toBe(1);
  });

  test("refuses to apply when the target manager is not installed", async () => {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "app" }));
    const previousPath = process.env["PATH"];
    process.env["PATH"] = "";
    try {
      const code = await quiet(() =>
        main(["npm", "pnpm", "--yes"], { cwd: root, isTTY: false }),
      );
      expect(code).toBe(1);
    } finally {
      if (previousPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previousPath;
    }
  });
});
