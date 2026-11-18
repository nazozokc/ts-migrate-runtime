# ts-migrate-runtime

Migrate a JavaScript/TypeScript project between package managers — npm, pnpm, yarn, and bun.

```bash
ts-migrate-runtime <from> <to>
```

`<from>` is the manager the project uses today, `<to>` is the one to migrate to. The migration runs against the current directory.

## Usage

```bash
# Preview what would happen (dry run, the default)
ts-migrate-runtime npm pnpm

# Apply it
ts-migrate-runtime npm pnpm --yes
```

Run it straight from source with Bun:

```bash
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

npm cannot import another manager's lockfile, so migrating **to npm** resolves versions fresh from `package.json`. The plan prints a warning when that happens.

## Options

| Option                | Description                                                     |
| --------------------- | -------------------------------------------------------------- |
| `-y`, `--yes`         | Apply the migration. Without it, the tool only prints the plan. |
| `--keep-node-modules` | Keep the existing `node_modules` directory.                     |
| `--no-import`         | Skip the lockfile import step and resolve fresh.                |
| `-h`, `--help`        | Show help.                                                      |
| `-v`, `--version`     | Show the version.                                               |

## Development

```bash
bun install
bun test       # unit tests
bun check      # type check
bun run src/index.ts --help
```

Source layout:

- `src/index.ts` — CLI entry point
- `src/cli.ts` — argument parsing, plan rendering, dispatch
- `src/managers.ts` — package manager definitions and import commands
- `src/plan.ts` — pure plan builder
- `src/execute.ts` — applies a plan to disk
- `src/probe.ts` — filesystem probe and version detection
- `src/workspaces.ts` — workspace config helpers
- `src/ui.ts` — output helpers
