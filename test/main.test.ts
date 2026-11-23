import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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
