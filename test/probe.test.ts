import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectVersion, parseVersionOutput } from "../src/probe.ts";

describe("parseVersionOutput", () => {
  test("extracts a semver from surrounding text", () => {
    expect(parseVersionOutput("pnpm v10.4.1\n")).toBe("10.4.1");
    expect(parseVersionOutput("1.22.19")).toBe("1.22.19");
    expect(parseVersionOutput("  \n")).toBeUndefined();
  });
});

describe("detectVersion", () => {
  let root: string;
  let previousPath: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ts-migrate-version-"));
    previousPath = process.env["PATH"];
    process.env["PATH"] = root;
  });

  afterEach(async () => {
    if (previousPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previousPath;
    await rm(root, { recursive: true, force: true });
  });

  test("returns the version of an installed manager", async () => {
    const script = join(root, "npm");
    await writeFile(script, "#!/bin/sh\necho 11.2.0\n");
    await chmod(script, 0o755);

    expect(detectVersion("npm")).toBe("11.2.0");
  });

  test("gives up on a hanging version command", async () => {
    const script = join(root, "npm");
    await writeFile(script, "#!/bin/sh\nexec sleep 2\n");
    await chmod(script, 0o755);

    const start = Date.now();
    expect(detectVersion("npm", { timeoutMs: 100 })).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(1500);
  });

  test("returns undefined when the manager is missing", () => {
    expect(detectVersion("pnpm")).toBeUndefined();
  });
});
