import { parse, stringify } from "yaml";

/** Workspace helpers shared by the plan builder. */

export const PKG_JSON = "package.json";
export const PNPM_WORKSPACE = "pnpm-workspace.yaml";

/**
 * Extract workspace globs from a `package.json` `workspaces` field.
 * Supports both the array form and the `{ packages: [...] }` object form.
 */
export function workspacePackages(pkg: Record<string, unknown>): string[] | undefined {
  const ws = pkg["workspaces"];
  if (Array.isArray(ws)) {
    const list = ws.filter((x): x is string => typeof x === "string");
    return list.length > 0 ? list : undefined;
  }
  if (ws && typeof ws === "object") {
    const packages = (ws as Record<string, unknown>)["packages"];
    if (Array.isArray(packages)) {
      const list = packages.filter((x): x is string => typeof x === "string");
      return list.length > 0 ? list : undefined;
    }
  }
  return undefined;
}

/** Parse a YAML mapping, or return undefined when the content is not a mapping or is invalid. */
export function parseYamlMapping(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Invalid YAML — treat as unparsable
  }
  return undefined;
}

export function stringifyYaml(value: unknown): string {
  const text = stringify(value as Parameters<typeof stringify>[0], { indent: 2 });
  return text.endsWith("\n") ? text : `${text}\n`;
}

export function stringifyPackageJson(pkg: unknown): string {
  return `${JSON.stringify(pkg, null, 2)}\n`;
}
