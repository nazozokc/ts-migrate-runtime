# ts-migrate-runtime

Migrate a JavaScript/TypeScript project between package managers — npm, pnpm, yarn, and bun.

```bash
ts-migrate-runtime [from] [to] [dir] [options]
```

`<from>` is the manager the project uses today, `<to>` is the one to migrate to. `[dir]` is the project directory and defaults to the current directory. With no arguments in a TTY, an interactive TUI starts.

The published binary runs on Node.js 18+ or Bun — Bun is not required by consumers.

## Usage

```bash
# Interactive TUI (also starts automatically with no args in a TTY)
ts-migrate-runtime
ts-migrate-runtime --interactive

# Preview what would happen (dry run, the default)
ts-migrate-runtime npm pnpm

# Apply it
ts-migrate-runtime npm pnpm --yes

# Target another directory
ts-migrate-runtime npm pnpm ../my-project --yes

# Machine-readable plan for CI
ts-migrate-runtime npm pnpm --json > plan.json

# Keep a recovery copy after applying
ts-migrate-runtime npm pnpm --yes --keep-backup
```

Run it straight from source with Bun:

```bash
bun run src/index.ts --interactive
bun run src/index.ts npm pnpm
```

## What a migration does

For `ts-migrate-runtime npm pnpm`, for example:

1. **Workspace config** — moves `workspaces` from `package.json` into `pnpm-workspace.yaml` (pnpm keeps them there). Going the other way moves `packages` back into `package.json` and removes `pnpm-workspace.yaml` when nothing else is left.
2. **`packageManager` field** — sets it to `<target>@<installed version>` in `package.json`.
3. **Lockfile** — imports the source lockfile into the target when the target supports it (`pnpm import`, `yarn import`, `bun pm migrate`), so locked versions are preserved. A stale target lockfile is removed first.
4. **`node_modules`** — removed, because the on-disk layout differs between managers.
5. **Old lockfile** — removed.
6. **Install** — runs the target's install to produce its lockfile.
7. **Build output scan** — reads text files under `dist/` and reports any place that still names the source manager, suggesting the target name instead (`dist/index.js:12:7 "npm" → "pnpm"`). It never rewrites files; update the source and rebuild.

npm cannot import another manager's lockfile, so migrating **to npm** resolves versions fresh from `package.json`. The plan prints a warning when that happens. Yarn Berry (v2+) has no `yarn import`, and an import is never attempted from `node_modules` alone — a source lockfile is required. Version detection times out after five seconds and disables Corepack's download prompt, so a missing target manager fails fast.

Before applying, the tool checks that the target manager is installed, that the source manager matches what the project appears to use, and that tracked files are not dirty. Uncommitted changes block an apply; commit or stash them, or pass `--allow-dirty` to override. Applying is guarded by a backup of every file it overwrites or deletes; if a command fails, the changes are rolled back and the backup is removed. `--keep-backup` retains that directory on success and prints its path for manual recovery. After a successful apply it verifies that the target lockfile exists and that `packageManager` was updated, and prints warnings if not.

If the target version cannot be detected, a stale `packageManager` field is removed rather than left pointing at the source manager. Set the version manually if Corepack or teammates need it.

`--json` replaces the human-readable output with a single JSON object containing the plan (`actions`, `warnings`, `suggestions`), git status (`dirty`, `dirtyFiles`) and, after an apply, `applied`, `backupDir` and `verifyWarnings`. It cannot be combined with interactive mode.

## Options

| Option                  | Description                                                                 |
| ----------------------- | --------------------------------------------------------------------------- |
| `-i`, `--interactive`   | Launch the interactive TUI. With no args in a TTY, it starts automatically. |
| `-y`, `--yes`           | Apply the migration. Without it, the tool only prints the plan.             |
| `--keep-node-modules`   | Keep the existing `node_modules` directory.                                 |
| `--no-import`           | Skip the lockfile import step and resolve fresh.                            |
| `--keep-backup`         | Retain the backup directory after a successful apply.                       |
| `--allow-dirty`         | Apply even when tracked files have uncommitted changes.                     |
| `--json`                | Emit a machine-readable plan or result instead of progress output.          |
| `-h`, `--help`          | Show help.                                                                  |
| `-v`, `--version`       | Show the version.                                                           |

Interactive mode requires a TTY. In non-interactive environments, pass `<from> <to>` explicitly.

## Development

```bash
bun install
bun test       # unit tests
bun check      # type check
bun run build  # produce dist/index.mjs for the bin
bun run src/index.ts --help
node dist/index.mjs --version  # verify the published binary
```

CI runs tests, typecheck, build, the Node binary smoke test and `actionlint`.

Source layout:

- `src/index.ts` — CLI entry point
- `src/cli.ts` — argument parsing and dispatch
- `src/tui.ts` — interactive TUI flow (`@clack/prompts`)
- `src/render.ts` — plan rendering
- `src/managers.ts` — package manager definitions and import commands
- `src/plan.ts` — pure plan builder
- `src/execute.ts` — applies a plan to disk
- `src/probe.ts` — filesystem probe and version detection
- `src/git.ts` — dirty-worktree preflight
- `src/workspaces.ts` — workspace config helpers
- `src/ui.ts` — output helpers
