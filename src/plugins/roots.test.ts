import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePluginSourceRoots } from "./roots.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-roots-"));
  temps.push(dir);
  return dir;
}

describe("resolvePluginSourceRoots", () => {
  it("omits the workspace root when .openclaw/extensions does not exist", () => {
    const roots = resolvePluginSourceRoots({ workspaceDir: makeWorkspace(), env: process.env });
    expect(roots.workspace).toBeUndefined();
    expect(roots.stock).toBeTruthy();
    expect(roots.global).toBeTruthy();
  });

  it("keeps the workspace root when .openclaw/extensions exists", () => {
    const workspaceDir = makeWorkspace();
    const extensionsDir = path.join(workspaceDir, ".openclaw", "extensions");
    fs.mkdirSync(extensionsDir, { recursive: true });
    expect(resolvePluginSourceRoots({ workspaceDir, env: process.env }).workspace).toBe(extensionsDir);
  });

  it("yields identical roots for different plugin-less workspaces (shared cache key)", () => {
    const a = resolvePluginSourceRoots({ workspaceDir: makeWorkspace(), env: process.env });
    const b = resolvePluginSourceRoots({ workspaceDir: makeWorkspace(), env: process.env });
    expect(a).toEqual(b);
  });
});
