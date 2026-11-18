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

/** Parse a YAML mapping, or return undefined when the content is not a mapping. */
export function parseYamlMapping(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  const parsed = Bun.YAML.parse(text);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return undefined;
}

export function stringifyYaml(value: unknown): string {
  const text = Bun.YAML.stringify(value, null, 2);
  return text.endsWith("\n") ? text : `${text}\n`;
}

export function stringifyPackageJson(pkg: unknown): string {
  return `${JSON.stringify(pkg, null, 2)}\n`;
}
