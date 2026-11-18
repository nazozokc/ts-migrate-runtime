import type { FsProbe, PmId, Suggestion } from "./types.ts";

/** Extensions that can contain readable code or configuration. */
const TEXT_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".json",
  ".map",
  ".css",
  ".html",
  ".txt",
  ".yaml",
  ".yml",
]);

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot).toLowerCase();
}

/**
 * Find references to the source package manager in built output under `dir`.
 * Reports each occurrence with its location and the target name; it never
 * modifies files.
 */
export function scanDist(opts: { probe: FsProbe; from: PmId; to: PmId; dir?: string }): Suggestion[] {
  const { probe, from, to } = opts;
  const dir = opts.dir ?? "dist";
  if (!probe.exists(dir)) return [];

  const suggestions: Suggestion[] = [];
  // Alphanumeric boundaries keep "npm" out of "pnpm" and "bun" out of "bundle",
  // while still matching forms like "npm_config" and "npm-run-all".
  const pattern = new RegExp(`(?<![A-Za-z0-9])${from}(?![A-Za-z0-9])`, "gi");

  for (const file of probe.listFiles(dir)) {
    if (!TEXT_EXTENSIONS.has(extensionOf(file))) continue;
    const content = probe.readText(file);
    if (content === undefined || content.includes("\0")) continue;

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        suggestions.push({
          file,
          line: i + 1,
          column: match.index + 1,
          match: match[0],
          replacement: to,
        });
        if (match[0].length === 0) pattern.lastIndex += 1;
      }
    }
  }

  return suggestions;
}
