import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildWorkspaceSkillsPrompt, sessionKindForSkills } from "./workspace.js";

function writeSkill(root: string, name: string, sessions?: string[]): void {
  const dir = path.join(root, "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  const meta = sessions
    ? `metadata:\n  openclaw:\n    sessions: [${sessions.map((s) => `"${s}"`).join(", ")}]\n`
    : "";
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: test skill ${name}\n${meta}---\n\n# ${name}\n`,
  );
}

describe("skill session scoping (metadata.openclaw.sessions)", () => {
  it("filters entries by sessionKind; undeclared skills stay visible to both", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "skill-scope-"));
    writeSkill(ws, "cron-only-skill", ["cron"]);
    writeSkill(ws, "chat-only-skill", ["chat"]);
    writeSkill(ws, "both-skill", ["cron", "chat"]);
    writeSkill(ws, "legacy-skill");

    const cronPrompt = buildWorkspaceSkillsPrompt(ws, { sessionKind: "cron" });
    expect(cronPrompt).toContain("cron-only-skill");
    expect(cronPrompt).toContain("both-skill");
    expect(cronPrompt).toContain("legacy-skill");
    expect(cronPrompt).not.toContain("chat-only-skill");

    const chatPrompt = buildWorkspaceSkillsPrompt(ws, { sessionKind: "chat" });
    expect(chatPrompt).toContain("chat-only-skill");
    expect(chatPrompt).toContain("both-skill");
    expect(chatPrompt).toContain("legacy-skill");
    expect(chatPrompt).not.toContain("cron-only-skill");

    // 不传 sessionKind = 老行为，全量可见
    const unscoped = buildWorkspaceSkillsPrompt(ws, {});
    expect(unscoped).toContain("cron-only-skill");
    expect(unscoped).toContain("chat-only-skill");
  });

  it("sessionKindForSkills derives kind from sessionKey", () => {
    expect(sessionKindForSkills("agent:wechat-dm-x:cron:1234:run:9")).toBe("cron");
    expect(sessionKindForSkills("agent:wechat-dm-x:wechat:default:direct:accX")).toBe("chat");
    expect(sessionKindForSkills(undefined)).toBe("chat");
  });
});
