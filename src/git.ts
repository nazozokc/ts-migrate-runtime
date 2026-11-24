import { spawnSync } from "node:child_process";

/** A tracked file with uncommitted changes. */
export interface DirtyWorktree {
  dirty: boolean;
  files: string[];
}

/** Minimal result of `git status --porcelain`, injectable for tests. */
export interface StatusResult {
  status: number | null;
  stdout?: string | Buffer | null;
  error?: Error | null;
}

export type StatusRunner = (
  command: string,
  args: string[],
  options: { cwd: string; stdio: "ignore" | "pipe" },
) => StatusResult;

/** Parse the porcelain output into changed file paths. */
export function parseStatusOutput(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter((line) => line.length > 0);
}

const defaultRunner: StatusRunner = (command, args, options) =>
  spawnSync(command, args, options);

/**
 * Check tracked files for uncommitted changes. Untracked files are ignored so
 * a freshly cloned project with build artifacts is not treated as dirty.
 * A missing git binary or a directory outside a repository is not dirty.
 */
export function dirtyWorktree(root: string, run: StatusRunner = defaultRunner): DirtyWorktree {
  try {
    const result = run("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: root,
      stdio: "pipe",
    });
    if (result.error || result.status !== 0) return { dirty: false, files: [] };
    const files = parseStatusOutput(String(result.stdout ?? ""));
    return { dirty: files.length > 0, files };
  } catch {
    return { dirty: false, files: [] };
  }
}

/** Human-readable warning for a dirty worktree. */
export function dirtyWorktreeWarning(status: DirtyWorktree, root: string): string {
  const listed = status.files.slice(0, 5).join(", ");
  const more = status.files.length > 5 ? ` (+${status.files.length - 5} more)` : "";
  return (
    `${root} has uncommitted changes (${listed}${more}); ` +
    "a failed migration can overwrite them. Commit or stash first."
  );
}
