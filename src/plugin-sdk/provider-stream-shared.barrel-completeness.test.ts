import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as providerStreamShared from "./provider-stream-shared.js";

// Extensions reach core stream helpers only through the plugin-sdk barrels. If a
// barrel fails to re-export a symbol an extension imports, the code type-checks
// and unit-tests green but throws "<name> is not a function" at runtime.
// nano.11 shipped exactly that: the amazon-bedrock extension imported
// applyBedrockLastUserCacheBoundary from this barrel, but the barrel never
// re-exported it -- crashing every Bedrock turn (193 cron/Sonnet failures before
// it was caught). The bundler does not type-check re-exports, so nothing failed
// earlier in the pipeline. This test locks barrel completeness against its real
// consumer's import list, catching that class of drop for current and future
// symbols.

const BARREL = "openclaw/plugin-sdk/provider-stream-shared";
const CONSUMER = "extensions/amazon-bedrock/register.sync.runtime.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Named value imports (excluding `type` imports) the consumer pulls from BARREL. */
function valueImportsFromBarrel(consumerRelPath: string): string[] {
  const source = fs.readFileSync(path.join(repoRoot, consumerRelPath), "utf8");
  const importBlock = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["']${BARREL}["']`, "g");
  const names: string[] = [];
  for (const match of source.matchAll(importBlock)) {
    for (const entry of match[1].split(",")) {
      const trimmed = entry.trim();
      if (!trimmed || trimmed.startsWith("type ")) continue;
      names.push(trimmed.split(/\s+as\s+/)[0].trim());
    }
  }
  return names;
}

describe("provider-stream-shared barrel export completeness", () => {
  it(`re-exports every value ${CONSUMER} imports as a callable`, () => {
    const imported = valueImportsFromBarrel(CONSUMER);
    // Guard against the regex silently matching nothing (vacuous pass).
    expect(imported.length).toBeGreaterThan(0);
    expect(imported).toContain("applyBedrockLastUserCacheBoundary"); // the nano.11 regression target

    const barrel = providerStreamShared as Record<string, unknown>;
    const missing = imported.filter((name) => typeof barrel[name] !== "function");
    expect(
      missing,
      `symbols imported by ${CONSUMER} but not exported as functions from ${BARREL}: ${missing.join(", ") || "(none)"}`,
    ).toEqual([]);
  });
});
