import { describe, expect, test } from "bun:test";
import { workspacePackages } from "../src/workspaces.ts";

describe("workspacePackages", () => {
  test("reads the array form", () => {
    expect(workspacePackages({ workspaces: ["packages/*", "apps/*"] })).toEqual(["packages/*", "apps/*"]);
  });

  test("reads the object form", () => {
    expect(workspacePackages({ workspaces: { packages: ["libs/*"], nohoist: ["x"] } })).toEqual(["libs/*"]);
  });

  test("returns undefined when absent or empty", () => {
    expect(workspacePackages({})).toBeUndefined();
    expect(workspacePackages({ workspaces: [] })).toBeUndefined();
    expect(workspacePackages({ workspaces: { nohoist: [] } })).toBeUndefined();
  });
});
