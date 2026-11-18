import type { FsProbe } from "../src/types.ts";

export function fakeProbe(input: { files?: Record<string, string>; dirs?: string[] }): FsProbe {
  const files = input.files ?? {};
  const dirs = new Set(input.dirs ?? []);
  return {
    exists: (rel) => rel in files || dirs.has(rel),
    readText: (rel) => files[rel],
    readJson: (rel) => {
      const text = files[rel];
      if (text === undefined) return undefined;
      const parsed: unknown = JSON.parse(text);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    },
    listFiles: (rel) => {
      const prefix = rel.endsWith("/") ? rel : `${rel}/`;
      return Object.keys(files)
        .filter((path) => path.startsWith(prefix))
        .sort();
    },
  };
}
