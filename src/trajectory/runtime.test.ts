import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TRAJECTORY_RUNTIME_EVENT_MAX_BYTES,
  createTrajectoryRuntimeRecorder,
  resolveTrajectoryPointerOpenFlags,
  resolveTrajectoryPointerFilePath,
  resolveTrajectoryFilePath,
  toTrajectoryToolDefinitions,
} from "./runtime.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-trajectory-runtime-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("trajectory runtime", () => {
  it("resolves a session-adjacent trajectory file by default", () => {
    expect(
      resolveTrajectoryFilePath({
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session-1",
      }),
    ).toBe("/tmp/session.trajectory.jsonl");
  });

  it("sanitizes session ids when resolving an override directory", () => {
    expect(
      resolveTrajectoryFilePath({
        env: { OPENCLAW_TRAJECTORY_DIR: "/tmp/traces" },
        sessionId: "../evil/session",
      }),
    ).toBe("/tmp/traces/___evil_session.jsonl");
  });

  it("records sanitized runtime events by default", () => {
    const writes: string[] = [];
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "responses",
      workspaceDir: "/tmp/workspace",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: (line) => {
          writes.push(line);
        },
        flush: async () => undefined,
      },
    });

    expect(recorder).not.toBeNull();
    recorder?.recordEvent("context.compiled", {
      systemPrompt: "system prompt",
      headers: [{ name: "Authorization", value: "Bearer sk-test-secret-token" }],
      command: "curl -H 'Authorization: Bearer sk-other-secret-token'",
      tools: toTrajectoryToolDefinitions([
        { name: "z-tool", parameters: { z: 1 } },
        { name: "a-tool", description: "alpha", parameters: { a: 1 } },
        { name: " ", description: "ignored" },
      ]),
    });

    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(writes[0]);
    expect(parsed.type).toBe("context.compiled");
    expect(parsed.source).toBe("runtime");
    expect(parsed.sessionId).toBe("session-1");
    expect(parsed.data.tools).toEqual([
      { name: "a-tool", description: "alpha", parameters: { a: 1 } },
      { name: "z-tool", parameters: { z: 1 } },
    ]);
    expect(JSON.stringify(parsed.data)).not.toContain("sk-test-secret-token");
    expect(JSON.stringify(parsed.data)).not.toContain("sk-other-secret-token");
  });

  it("digests an oversized field instead of dropping the whole payload", () => {
    const writes: string[] = [];
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: (line) => {
          writes.push(line);
        },
        flush: async () => undefined,
      },
    });

    recorder?.recordEvent("context.compiled", {
      streamStrategy: "block",
      prompt: "x".repeat(TRAJECTORY_RUNTIME_EVENT_MAX_BYTES + 1),
    });

    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(writes[0]);
    // The small sibling field survives (the old post-hoc truncation dropped it).
    expect(parsed.data.streamStrategy).toBe("block");
    // The oversized field becomes a compact digest, not a discarded payload.
    expect(parsed.data.prompt).toMatchObject({
      __trajectoryDigest: true,
      kind: "string",
      length: TRAJECTORY_RUNTIME_EVENT_MAX_BYTES + 1,
    });
    expect(parsed.data.truncated).toBeUndefined();
    expect(Buffer.byteLength(writes[0], "utf8")).toBeLessThanOrEqual(
      TRAJECTORY_RUNTIME_EVENT_MAX_BYTES,
    );
  });

  it("digests an oversized transcript snapshot but preserves usage metadata", () => {
    const writes: string[] = [];
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: (line) => {
          writes.push(line);
        },
        flush: async () => undefined,
      },
    });

    const messagesSnapshot = Array.from({ length: 400 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: "y".repeat(2048),
    }));
    recorder?.recordEvent("model.completed", {
      usage: { promptTokens: 190000 },
      promptCache: { cacheWriteInputTokens: 1234 },
      messagesSnapshot,
    });

    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(writes[0]);
    // Sibling metadata survives (previously lost when the whole event was stubbed).
    expect(parsed.data.usage).toEqual({ promptTokens: 190000 });
    expect(parsed.data.promptCache).toEqual({ cacheWriteInputTokens: 1234 });
    expect(parsed.data.messagesSnapshot).toMatchObject({
      __trajectoryDigest: true,
      kind: "array",
      length: 400,
    });
    expect(parsed.data.messagesSnapshot.head).toBeDefined();
    expect(parsed.data.messagesSnapshot.tail).toBeDefined();
    expect(parsed.data.truncated).toBeUndefined();
    expect(Buffer.byteLength(writes[0], "utf8")).toBeLessThanOrEqual(
      TRAJECTORY_RUNTIME_EVENT_MAX_BYTES,
    );
  });

  it("still truncates when kept fields together exceed the event cap", () => {
    const writes: string[] = [];
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: (line) => {
          writes.push(line);
        },
        flush: async () => undefined,
      },
    });

    const data: Record<string, string> = {};
    for (let index = 0; index < 6; index += 1) {
      // Each field is under the per-field budget so none is digested, but six of
      // them together exceed the 256 KB event cap and hit the post-hoc safety net.
      data[`field${index}`] = "z".repeat(50 * 1024);
    }
    recorder?.recordEvent("context.compiled", data);

    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(writes[0]);
    expect(parsed.data).toMatchObject({
      truncated: true,
      reason: "trajectory-event-size-limit",
    });
    expect(Buffer.byteLength(writes[0], "utf8")).toBeLessThanOrEqual(
      TRAJECTORY_RUNTIME_EVENT_MAX_BYTES + 1,
    );
  });

  it("writes a session-adjacent pointer when using an override directory", () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const trajectoryDir = path.join(tmpDir, "traces");
    const recorder = createTrajectoryRuntimeRecorder({
      env: { OPENCLAW_TRAJECTORY_DIR: trajectoryDir },
      sessionId: "session-1",
      sessionFile,
      writer: {
        filePath: path.join(trajectoryDir, "session-1.jsonl"),
        write: () => undefined,
        flush: async () => undefined,
      },
    });

    expect(recorder).not.toBeNull();
    const pointer = JSON.parse(
      fs.readFileSync(resolveTrajectoryPointerFilePath(sessionFile), "utf8"),
    ) as { runtimeFile?: string };
    expect(pointer.runtimeFile).toBe(path.join(trajectoryDir, "session-1.jsonl"));
  });

  it("keeps pointer write flags usable when O_NOFOLLOW is unavailable", () => {
    expect(
      resolveTrajectoryPointerOpenFlags({
        O_CREAT: 0x01,
        O_TRUNC: 0x02,
        O_WRONLY: 0x04,
      }),
    ).toBe(0x07);
  });

  it("does not record runtime events when explicitly disabled", () => {
    const recorder = createTrajectoryRuntimeRecorder({
      env: {
        OPENCLAW_TRAJECTORY: "0",
      },
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: () => undefined,
        flush: async () => undefined,
      },
    });

    expect(recorder).toBeNull();
  });
});
