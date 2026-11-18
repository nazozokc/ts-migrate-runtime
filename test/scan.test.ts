import { describe, expect, test } from "bun:test";
import { scanDist } from "../src/scan.ts";
import { fakeProbe } from "./helpers.ts";

describe("scanDist", () => {
  test("finds the source manager name with its location", () => {
    const suggestions = scanDist({
      probe: fakeProbe({
        files: { "dist/index.js": "// built\nexec('npm install');\n" },
        dirs: ["dist"],
      }),
      from: "npm",
      to: "pnpm",
    });

    expect(suggestions).toEqual([
      { file: "dist/index.js", line: 2, column: 7, match: "npm", replacement: "pnpm" },
    ]);
  });

  test("does not match the source name inside another manager name", () => {
    expect(
      scanDist({
        probe: fakeProbe({ files: { "dist/a.js": "pnpm install\n" }, dirs: ["dist"] }),
        from: "npm",
        to: "pnpm",
      }),
    ).toEqual([]);

    expect(
      scanDist({
        probe: fakeProbe({ files: { "dist/a.js": "await bundle();\n" }, dirs: ["dist"] }),
        from: "bun",
        to: "pnpm",
      }),
    ).toEqual([]);
  });

  test("returns nothing when dist/ is absent", () => {
    expect(
      scanDist({
        probe: fakeProbe({ files: { "dist/a.js": "npm install\n" } }),
        from: "npm",
        to: "pnpm",
      }),
    ).toEqual([]);
  });

  test("skips binary files", () => {
    expect(
      scanDist({
        probe: fakeProbe({ files: { "dist/data.js": "\0npm\0" }, dirs: ["dist"] }),
        from: "npm",
        to: "pnpm",
      }),
    ).toEqual([]);
  });

  test("skips files that are not code or configuration", () => {
    expect(
      scanDist({
        probe: fakeProbe({ files: { "dist/logo.png": "npm" }, dirs: ["dist"] }),
        from: "npm",
        to: "pnpm",
      }),
    ).toEqual([]);
  });

  test("reports every occurrence on a line", () => {
    const suggestions = scanDist({
      probe: fakeProbe({ files: { "dist/a.js": "npm install && npm test" }, dirs: ["dist"] }),
      from: "npm",
      to: "pnpm",
    });

    expect(suggestions.map((s) => s.column)).toEqual([1, 16]);
  });

  test("walks nested directories", () => {
    const suggestions = scanDist({
      probe: fakeProbe({
        files: {
          "dist/chunks/a.js": "npm run build\n",
          "dist/index.mjs": "NPM_CONFIG=1\n",
        },
        dirs: ["dist"],
      }),
      from: "npm",
      to: "pnpm",
    });

    expect(suggestions.map((s) => `${s.file}:${s.match}`)).toEqual([
      "dist/chunks/a.js:npm",
      "dist/index.mjs:NPM",
    ]);
  });
});
