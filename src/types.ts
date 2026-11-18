/** Supported package managers. */
export type PmId = "npm" | "pnpm" | "yarn" | "bun";

/** Static description of a package manager. */
export interface PmDef {
  id: PmId;
  /** Display name. */
  label: string;
  /** Lockfile names owned by this manager, in priority order. */
  lockfiles: string[];
  /** Command that installs dependencies and (re)generates the lockfile. */
  installCmd: string[];
  /** Command that prints the manager version. */
  versionCmd: string[];
  /** Where workspace globs live for this manager. */
  workspaceSource: "package.json" | "pnpm-workspace.yaml";
}

/** A single side effect of a migration. */
export type PlanAction =
  | { kind: "write"; path: string; content: string; note: string }
  | { kind: "delete"; path: string; note: string }
  | { kind: "run"; cmd: string[]; note: string };

/** A place under `dist/` that still references the source package manager. */
export interface Suggestion {
  /** File path relative to the project root, e.g. `dist/index.js`. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
  /** The matched source manager name, as written in the file. */
  match: string;
  /** Target manager name to use instead. */
  replacement: string;
}

/** A fully described migration, ready to print (dry-run) or apply. */
export interface Plan {
  from: PmId;
  to: PmId;
  /** Absolute project root the plan targets. */
  root: string;
  /** Detected target version, used for the `packageManager` field. */
  targetVersion?: string;
  actions: PlanAction[];
  warnings: string[];
  /** References to the source manager found under `dist/`. Never auto-applied. */
  suggestions: Suggestion[];
}

/** Read-only view of the target directory. */
export interface FsProbe {
  exists(relPath: string): boolean;
  readText(relPath: string): string | undefined;
  readJson(relPath: string): Record<string, unknown> | undefined;
  /** All files below `relDir`, as paths relative to the root. */
  listFiles(relDir: string): string[];
}

export interface PlanOptions {
  from: PmId;
  to: PmId;
  root: string;
  probe: FsProbe;
  /** Target version for `packageManager`; omit when undetectable. */
  targetVersion?: string;
  /** Keep the existing `node_modules` instead of deleting it. */
  keepNodeModules?: boolean;
  /** Skip importing the source lockfile; resolve fresh from package.json. */
  noImport?: boolean;
}
