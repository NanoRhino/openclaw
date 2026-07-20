import { describe, expect, it } from "vitest";
import { boundTrajectoryEventData, estimateJsonBytes } from "./bound-event-data.js";

describe("estimateJsonBytes", () => {
  it("returns the full size for values within budget", () => {
    const result = estimateJsonBytes({ a: "hello", b: [1, 2, 3] }, 1024);
    expect(result.exceeded).toBe(false);
    expect(result.bytes).toBeGreaterThan(0);
  });

  it("reports an oversized lone string cheaply via its length", () => {
    // A single string is one node measured by .length (O(1), no traversal and no
    // allocation), so the reported size is the full length — the win is simply
    // that nothing is walked or copied.
    const result = estimateJsonBytes("x".repeat(1_000_000), 4096);
    expect(result.exceeded).toBe(true);
  });

  it("bails out of a large array without summing every element", () => {
    const many = Array.from({ length: 1000 }, () => "x".repeat(10_000));
    const result = estimateJsonBytes(many, 4096);
    expect(result.exceeded).toBe(true);
    // Stopped after the first oversized element, far below the ~10 MB total.
    expect(result.bytes).toBeLessThan(100_000);
  });

  it("does not enqueue every element of a huge flat array before bailing", () => {
    const huge = new Array(5_000_000).fill(0);
    const result = estimateJsonBytes(huge, 4096);
    expect(result.exceeded).toBe(true);
  });
});

describe("boundTrajectoryEventData", () => {
  it("returns the same reference when the whole payload is within budget", () => {
    const data = { usage: { tokens: 10 }, note: "small" };
    expect(boundTrajectoryEventData(data)).toBe(data);
  });

  it("digests an oversized array field and keeps small siblings", () => {
    const snapshot = Array.from({ length: 100 }, () => ({
      role: "user",
      content: "y".repeat(4096),
    }));
    const data = { usage: { promptTokens: 5 }, messagesSnapshot: snapshot };
    const bounded = boundTrajectoryEventData(data, {
      dataBudgetBytes: 8192,
      fieldBudgetBytes: 4096,
    });
    expect(bounded).not.toBe(data);
    expect(bounded.usage).toEqual({ promptTokens: 5 });
    expect(bounded.messagesSnapshot).toMatchObject({
      __trajectoryDigest: true,
      kind: "array",
      length: 100,
    });
    const digest = bounded.messagesSnapshot as { head?: unknown; tail?: unknown };
    expect(digest.head).toBeDefined();
    expect(digest.tail).toBeDefined();
  });

  it("digests an oversized string field with a clipped preview", () => {
    const data = { prompt: "a".repeat(20000) };
    const bounded = boundTrajectoryEventData(data, {
      dataBudgetBytes: 4096,
      fieldBudgetBytes: 2048,
    });
    expect(bounded.prompt).toMatchObject({
      __trajectoryDigest: true,
      kind: "string",
      length: 20000,
    });
    const preview = (bounded.prompt as { preview?: string }).preview;
    expect(typeof preview).toBe("string");
    expect((preview as string).length).toBeLessThan(300);
  });
});
