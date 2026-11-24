import type { PmDef, PmId } from "./types.ts";

export const PACKAGE_MANAGERS: Record<PmId, PmDef> = {
  npm: {
    id: "npm",
    label: "npm",
    lockfiles: ["package-lock.json", "npm-shrinkwrap.json"],
    installCmd: ["npm", "install"],
    versionCmd: ["npm", "--version"],
    workspaceSource: "package.json",
  },
  pnpm: {
    id: "pnpm",
    label: "pnpm",
    lockfiles: ["pnpm-lock.yaml"],
    installCmd: ["pnpm", "install"],
    versionCmd: ["pnpm", "--version"],
    workspaceSource: "pnpm-workspace.yaml",
  },
  yarn: {
    id: "yarn",
    label: "yarn",
    lockfiles: ["yarn.lock"],
    installCmd: ["yarn", "install"],
    versionCmd: ["yarn", "--version"],
    workspaceSource: "package.json",
  },
  bun: {
    id: "bun",
    label: "bun",
    lockfiles: ["bun.lock", "bun.lockb"],
    installCmd: ["bun", "install"],
    versionCmd: ["bun", "--version"],
    workspaceSource: "package.json",
  },
};

export const PM_IDS = Object.keys(PACKAGE_MANAGERS) as PmId[];

export function isPmId(value: string): value is PmId {
  return Object.prototype.hasOwnProperty.call(PACKAGE_MANAGERS, value);
}

/**
 * Command that imports another manager's lockfile into the target, if the
 * target supports it. `undefined` means the target cannot import and will
 * resolve dependencies fresh from `package.json`.
 */
export function importCommand(from: PmId, to: PmId): string[] | undefined {
  if (from === to) return undefined;
  switch (to) {
    case "pnpm":
      return from === "npm" || from === "yarn" ? ["pnpm", "import"] : undefined;
    case "yarn":
      // Yarn Berry (v2+) removed `yarn import`; only Yarn Classic can import.
      return from === "npm" ? ["yarn", "import"] : undefined;
    case "bun":
      return ["bun", "pm", "migrate"];
    default:
      return undefined;
  }
}

/** Parse the major version from a version string such as `1.22.19`. */
export function majorVersion(version: string | undefined): number | undefined {
  if (version === undefined) return undefined;
  const match = version.match(/^(\d+)(?:\.|$)/);
  if (!match) return undefined;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) ? major : undefined;
}
