import { describe, expect, mock, test } from "bun:test";
import type { ApplyOptions } from "../src/execute.ts";
import type { Prompter } from "../src/tui.ts";
import { runInteractive } from "../src/tui.ts";
import type { Plan } from "../src/types.ts";
import { fakeProbe } from "./helpers.ts";

function cancelSymbol(): symbol {
  return Symbol.for("cancel");
}

function makePrompter(overrides: Partial<Prompter> = {}): Prompter {
  const cancel = cancelSymbol();
  const base: Prompter = {
    intro: mock(() => {}),
    selectFrom: mock(async () => "npm" as const),
    selectTo: mock(async () => "pnpm" as const),
    selectOptions: mock(async () => ({ noImport: false, keepNodeModules: false, keepBackup: false })),
    confirmApply: mock(async () => "dry-run" as const),
    note: mock(() => {}),
    logWarn: mock(() => {}),
    logStep: mock(() => {}),
    outro: mock(() => {}),
    cancel: mock(() => {}),
    isCancel: (value): value is symbol => value === cancel,
  };
  return { ...base, ...overrides };
}

const baseFiles = {
  "package.json": JSON.stringify({ name: "app" }),
};

describe("runInteractive", () => {
  test("dry-run flow builds plan and does not apply", async () => {
    const prompter = makePrompter({
      confirmApply: mock(async () => "dry-run" as const),
    });
    const probe = fakeProbe({ files: baseFiles });

    const code = await runInteractive("/proj", probe, { keepNodeModules: false, noImport: false, keepBackup: false }, { prompter, isTTY: () => true });

    expect(code).toBe(0);
    expect(prompter.selectFrom).toHaveBeenCalledTimes(1);
    expect(prompter.selectTo).toHaveBeenCalledTimes(1);
    expect(prompter.note).toHaveBeenCalledTimes(1);
    expect(prompter.outro).toHaveBeenCalledWith(expect.stringContaining("Dry run"));
  });

  test("cancel returns 1 and does not show plan", async () => {
    const cancel = cancelSymbol();
    const prompter = makePrompter({
      selectFrom: mock(async () => cancel),
      isCancel: (value): value is symbol => value === cancel,
    });

    const code = await runInteractive(
      "/proj",
      fakeProbe({ files: baseFiles }),
      { keepNodeModules: false, noImport: false, keepBackup: false },
      { prompter, isTTY: () => true },
    );

    expect(code).toBe(1);
    expect(prompter.note).not.toHaveBeenCalled();
    expect(prompter.cancel).toHaveBeenCalled();
  });

  test("uses detected from and skips from prompt when provided", async () => {
    const prompter = makePrompter();
    const probe = fakeProbe({ files: { ...baseFiles, "pnpm-lock.yaml": "lockfileVersion: '9.0'" } });

    const code = await runInteractive(
      "/proj",
      probe,
      { from: "pnpm", to: "npm", keepNodeModules: false, noImport: false, keepBackup: false },
      { prompter, isTTY: () => true },
    );

    expect(code).toBe(0);
    expect(prompter.selectFrom).not.toHaveBeenCalled();
    expect(prompter.selectTo).not.toHaveBeenCalled();
  });

  test("rejects non-TTY", async () => {
    const prompter = makePrompter();
    await expect(
      runInteractive("/proj", fakeProbe({ files: baseFiles }), { keepNodeModules: false, noImport: false, keepBackup: false }, { prompter, isTTY: () => false }),
    ).rejects.toThrow("interactive mode requires a TTY");
  });

  test("apply confirmation runs migration and returns success", async () => {
    const apply = mock(async () => {});
    const prompter = makePrompter({
      confirmApply: mock(async () => "apply" as const),
    });
    const probe = fakeProbe({ files: baseFiles });

    const code = await runInteractive(
      "/proj",
      probe,
      { from: "npm", to: "pnpm", keepNodeModules: false, noImport: false, keepBackup: false },
      { prompter, isTTY: () => true, apply, detectVersion: () => "10.0.0" },
    );

    expect(code).toBe(0);
    expect(prompter.confirmApply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(prompter.outro).toHaveBeenCalledWith(expect.stringContaining("Migrated npm → pnpm"));
  });

  test("passes keepBackup to apply and reports the retained backup", async () => {
    const apply = mock(async (_plan: Plan, opts: ApplyOptions = {}) => {
      opts.onBackup?.("/tmp/migration-backup");
    });
    const prompter = makePrompter({
      confirmApply: mock(async () => "apply" as const),
      selectOptions: mock(async () => ({
        noImport: false,
        keepNodeModules: false,
        keepBackup: true,
      })),
    });

    const code = await runInteractive(
      "/proj",
      fakeProbe({ files: baseFiles }),
      { from: "npm", to: "pnpm", keepNodeModules: false, noImport: false, keepBackup: true },
      { prompter, isTTY: () => true, apply, detectVersion: () => "10.0.0" },
    );

    expect(code).toBe(0);
    expect(apply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ keepBackup: true }));
    expect(prompter.note).toHaveBeenCalledWith(expect.stringContaining("/tmp/migration-backup"), "Recovery");
  });

  test("refuses to apply when the target version is unavailable", async () => {
    const apply = mock(async () => {});
    const prompter = makePrompter({ confirmApply: mock(async () => "apply" as const) });

    const code = await runInteractive(
      "/proj",
      fakeProbe({ files: baseFiles }),
      { from: "npm", to: "pnpm", keepNodeModules: false, noImport: false, keepBackup: false },
      { prompter, isTTY: () => true, apply, detectVersion: () => undefined },
    );

    expect(code).toBe(1);
    expect(apply).not.toHaveBeenCalled();
    expect(prompter.cancel).toHaveBeenCalledWith(expect.stringContaining("not installed"));
  });
});
