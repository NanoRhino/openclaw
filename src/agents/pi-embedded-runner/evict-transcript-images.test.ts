import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { acquireSessionWriteLock } from "../session-write-lock.js";
import { replaceBedrockHistoryImages } from "./bedrock-stream-wrappers.js";
import {
  evictHistoryImagesFromSessionFile,
  evictHistoryImagesFromTranscript,
} from "./evict-transcript-images.js";
import { historyImagePlaceholderForBase64 } from "./history-image-placeholder.js";

const PLACEHOLDER_RE = /^\[photo [0-9a-f]{8}: analyzed meal image\]$/;
const b64 = (...bytes: number[]) => Buffer.from(bytes).toString("base64");

const HEADER = {
  type: "session",
  version: 1,
  id: "sess-1",
  timestamp: "2026-01-01T00:00:00.000Z",
  cwd: "/tmp",
};
const msg = (id: string, parentId: string | null, message: unknown) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-01-01T00:00:00.000Z",
  message,
});
const jsonl = (...entries: unknown[]) => `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
const mkTmpFile = (content: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evict-transcript-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, content);
  return file;
};

describe("evictHistoryImagesFromTranscript", () => {
  it("replaces user + toolResult image data with a byte-stable placeholder", () => {
    const content = jsonl(
      HEADER,
      msg("m1", null, {
        role: "user",
        content: [
          { type: "text", text: "lunch" },
          { type: "image", data: b64(1, 2, 3), mimeType: "image/jpeg" },
        ],
      }),
      msg("m2", "m1", { role: "assistant", content: [{ type: "text", text: "logged" }] }),
      msg("m3", "m2", {
        role: "toolResult",
        toolCallId: "t1",
        content: [{ type: "image", data: b64(4, 5), mimeType: "image/png" }],
        isError: false,
      }),
    );

    const result = evictHistoryImagesFromTranscript(content);
    expect(result).not.toBeNull();
    expect(result!.imagesEvicted).toBe(2);

    const lines = result!.content
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    const userContent = lines[1].message.content;
    expect(userContent[0]).toEqual({ type: "text", text: "lunch" });
    expect(userContent[1].type).toBe("text");
    expect(userContent[1].text).toMatch(PLACEHOLDER_RE);
    expect(userContent[1]).not.toHaveProperty("data");
    const toolContent = lines[3].message.content;
    expect(toolContent[0].type).toBe("text");
    expect(toolContent[0].text).toMatch(PLACEHOLDER_RE);
    // Untouched fields preserved.
    expect(lines[1].id).toBe("m1");
    expect(lines[1].parentId).toBeNull();
    expect(lines[3].message.toolCallId).toBe("t1");
  });

  it("returns null and does not touch a transcript with no images", () => {
    const content = jsonl(
      HEADER,
      msg("m1", null, { role: "user", content: [{ type: "text", text: "hi" }] }),
      msg("m2", "m1", { role: "assistant", content: [{ type: "text", text: "hello" }] }),
    );
    expect(evictHistoryImagesFromTranscript(content)).toBeNull();
  });

  it("is idempotent — a second pass finds only placeholders and returns null", () => {
    const content = jsonl(
      HEADER,
      msg("m1", null, {
        role: "user",
        content: [{ type: "image", data: b64(1, 2, 3), mimeType: "image/jpeg" }],
      }),
    );
    const first = evictHistoryImagesFromTranscript(content);
    expect(first).not.toBeNull();
    expect(evictHistoryImagesFromTranscript(first!.content)).toBeNull();
  });

  it("tolerates a torn/corrupt trailing line — keeps it verbatim, does not throw", () => {
    const good = msg("m1", null, {
      role: "user",
      content: [{ type: "image", data: b64(1, 2, 3), mimeType: "image/jpeg" }],
    });
    // Second line is a partial write that also contains the image marker.
    const corrupt = `{"type":"message","message":{"role":"user","content":[{"type":"image","data":"AA`;
    const content = `${JSON.stringify(good)}\n${corrupt}`;

    const result = evictHistoryImagesFromTranscript(content);
    expect(result).not.toBeNull();
    expect(result!.imagesEvicted).toBe(1);
    const outLines = result!.content.split("\n");
    // The good line was rewritten; the corrupt line is preserved byte-for-byte.
    expect(outLines[1]).toBe(corrupt);
  });

  it("preserves all entries and structure across multiple branches", () => {
    const content = jsonl(
      HEADER,
      msg("m1", null, { role: "user", content: [{ type: "text", text: "a" }] }),
      msg("m2", "m1", {
        role: "user",
        content: [{ type: "image", data: b64(7, 7), mimeType: "image/jpeg" }],
      }),
      // Sibling branch off m1 (different parent path).
      msg("m3", "m1", {
        role: "user",
        content: [{ type: "image", data: b64(8, 8), mimeType: "image/jpeg" }],
      }),
    );
    const result = evictHistoryImagesFromTranscript(content);
    expect(result).not.toBeNull();
    expect(result!.imagesEvicted).toBe(2);
    const lines = result!.content
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(4); // header + 3 messages, none lost
    expect(lines[0].type).toBe("session");
    expect(lines.slice(1).map((l) => l.id)).toEqual(["m1", "m2", "m3"]);
    expect(lines[3].parentId).toBe("m1");
  });

  it("leaves no-image lines byte-for-byte identical", () => {
    const textLine = JSON.stringify(
      msg("m1", null, { role: "assistant", content: [{ type: "text", text: "plain" }] }),
    );
    const imageLine = JSON.stringify(
      msg("m2", "m1", {
        role: "user",
        content: [{ type: "image", data: b64(1), mimeType: "image/jpeg" }],
      }),
    );
    const content = `${JSON.stringify(HEADER)}\n${textLine}\n${imageLine}\n`;
    const out = evictHistoryImagesFromTranscript(content)!.content;
    const outLines = out.split("\n");
    expect(outLines[0]).toBe(JSON.stringify(HEADER));
    expect(outLines[1]).toBe(textLine); // untouched line unchanged
    expect(outLines[3]).toBe(""); // trailing newline preserved
  });

  it("produces the same placeholder as the Bedrock payload projection (fix A)", () => {
    const bytes = [9, 8, 7, 6, 5];
    const base64 = b64(...bytes);
    const evictorText = historyImagePlaceholderForBase64(base64);

    const payload = {
      messages: [
        {
          role: "user",
          content: [{ image: { format: "jpeg", source: { bytes: Uint8Array.from(bytes) } } }],
        },
        { role: "assistant", content: [{ text: "ok" }] },
        { role: "user", content: [{ text: "current" }] },
      ],
    };
    replaceBedrockHistoryImages(payload);
    const fixAText = (payload.messages[0].content[0] as { text: string }).text;

    expect(evictorText).toMatch(PLACEHOLDER_RE);
    expect(evictorText).toBe(fixAText);
  });
});

describe("evicted transcript opens in SessionManager", () => {
  it("loads and replays equal except images (hard gate)", () => {
    // Build a real session file via pi's own writer so the format is valid.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evict-sm-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "session.jsonl");
    const writer = SessionManager.open(file);
    writer.appendMessage({
      role: "user",
      content: [
        { type: "text", text: "here is lunch" },
        { type: "image", data: b64(10, 20, 30, 40), mimeType: "image/jpeg" },
      ],
    } as never);
    writer.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "logged" }],
    } as never);
    expect(fs.readFileSync(file, "utf8")).toContain('"type":"image"');

    // Evict + write back.
    const result = evictHistoryImagesFromTranscript(fs.readFileSync(file, "utf8"));
    expect(result).not.toBeNull();
    fs.writeFileSync(file, result!.content);

    // Re-open with a fresh SessionManager: must load cleanly.
    const reopened = SessionManager.open(file);
    const branch = reopened.getBranch();
    const messages = branch
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: { role: string; content: unknown[] } }).message);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    // Image replaced by placeholder text; the sibling text block is intact.
    expect(messages[0].content[0]).toEqual({ type: "text", text: "here is lunch" });
    expect((messages[0].content[1] as { type: string; text: string }).type).toBe("text");
    expect((messages[0].content[1] as { text: string }).text).toMatch(PLACEHOLDER_RE);
    expect(messages[1].role).toBe("assistant");
    expect(fs.readFileSync(file, "utf8")).not.toContain('"type":"image"');
  });
});

describe("evictHistoryImagesFromSessionFile", () => {
  it("rewrites a file containing images atomically and reports the count", async () => {
    const file = mkTmpFile(
      jsonl(
        HEADER,
        msg("m1", null, {
          role: "user",
          content: [{ type: "image", data: b64(1, 2, 3), mimeType: "image/jpeg" }],
        }),
      ),
    );
    const result = await evictHistoryImagesFromSessionFile(file);
    expect(result).toEqual({ rewritten: true, imagesEvicted: 1 });
    const after = fs.readFileSync(file, "utf8");
    expect(after).not.toContain('"type":"image"');
    expect(after).toMatch(/\[photo [0-9a-f]{8}: analyzed meal image\]/);
    // No temp files left behind.
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".evict-"))).toHaveLength(0);
  });

  it("leaves a no-image file byte-for-byte unchanged and does not rewrite", async () => {
    const original = jsonl(
      HEADER,
      msg("m1", null, { role: "user", content: [{ type: "text", text: "hi" }] }),
    );
    const file = mkTmpFile(original);
    const result = await evictHistoryImagesFromSessionFile(file);
    expect(result).toEqual({ rewritten: false, imagesEvicted: 0 });
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  });

  it("is a no-op for a missing file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evict-missing-"));
    tmpDirs.push(dir);
    const result = await evictHistoryImagesFromSessionFile(path.join(dir, "nope.jsonl"));
    expect(result).toEqual({ rewritten: false, imagesEvicted: 0 });
  });

  // Regression for the .14 self-deadlock: the runner already holds the session
  // write lock across the load path, so eviction must acquire it reentrantly
  // (run, not time out) AND must not release the runner's outer lock.
  it("runs while the runner already holds the session lock, preserving the outer lock", async () => {
    const file = mkTmpFile(
      jsonl(
        HEADER,
        msg("m1", null, {
          role: "user",
          content: [{ type: "image", data: b64(1, 2, 3), mimeType: "image/jpeg" }],
        }),
      ),
    );
    // Same normalized lock path the lib computes, robust to /tmp symlinks.
    const lockPath = `${path.join(fs.realpathSync(path.dirname(file)), path.basename(file))}.lock`;

    // Simulate attempt.ts:624 — hold the main lock non-reentrantly.
    const outer = await acquireSessionWriteLock({ sessionFile: file });
    try {
      expect(fs.existsSync(lockPath)).toBe(true);
      const startedAt = Date.now();
      const result = await evictHistoryImagesFromSessionFile(file);
      // Ran reentrantly — did not sit out the ~5s timeout and skip.
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(result).toEqual({ rewritten: true, imagesEvicted: 1 });
      expect(fs.readFileSync(file, "utf8")).not.toContain('"type":"image"');
      // Inner release only decremented the count; the outer lock still holds.
      expect(fs.existsSync(lockPath)).toBe(true);
    } finally {
      await outer.release();
    }
    // Outer release was the final one — lock fully cleaned up.
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
