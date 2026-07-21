// patch-006 v6.1 paragraph-level dedup tests
//
// Within a single LLM output, paragraphs (≥20 chars) that exactly match an
// earlier paragraph are dropped. Triggered by real cases (Mo 2026-06-01 08:18,
// accygnvhlv 2026-06-01 07:17) where the LLM emitted "draft + length-check +
// final" and both draft and final reached the user.
//
// cfg uses mode:"exclude" + a non-excluded sessionKey so the filter actually
// runs through to the paragraph-processing code (mode:"include" with empty
// include[] would early-return and bypass dedup). llm:false keeps Phase 2 off
// so the test is deterministic and makes no Bedrock/Anthropic calls.

import _replyFilterFs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { filterReplyText } from "./reply-filter.js";

const NON_EXCLUDED_SESSION_KEY =
  "agent:wechat-dm-acckyoy8rw7hbpxnui2n2ls:wechat:default:direct:acckyoy8rw7hbpxnui2n2ls";

let cfgPath: string;
let originalStateDir: string | undefined;

beforeEach(() => {
  cfgPath = `/tmp/openclaw-reply-filter-dedup-test-${process.pid}-${Date.now()}`;
  originalStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = cfgPath;
  _replyFilterFs.mkdirSync(cfgPath, { recursive: true });
  _replyFilterFs.writeFileSync(
    `${cfgPath}/reply-filter.json`,
    JSON.stringify({
      enabled: true,
      mode: "exclude",
      exclude: ["main", "strategic-management"],
      llm: false, // Phase 2 LLM disabled — fastReject + dedup only.
    }),
  );
});

afterEach(() => {
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  try {
    _replyFilterFs.rmSync(cfgPath, { recursive: true, force: true });
  } catch {
    // ignore
  }
  vi.restoreAllMocks();
});

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

describe("filterReplyText v6.1 paragraph dedup (patch-006)", () => {
  it("identical Chinese paragraph (≥20 chars) repeated → only one copy survives", async () => {
    const para = "今天的早餐看起来很均衡呢，蛋白质和碳水都有，继续保持这个节奏哦";
    const text = `${para}\n\n${para}`;

    const result = await filterReplyText(text, undefined, NON_EXCLUDED_SESSION_KEY);

    expect(result.drop).toBe(false);
    expect(countOccurrences(result.text, para)).toBe(1);
  });

  it("A\\n\\nB\\n\\nA with intervening different paragraph → output is A\\n\\nB", async () => {
    const a = "今天的早餐看起来很均衡呢，蛋白质和碳水都有，继续保持哦宝宝";
    const b = "记得午餐多吃点蔬菜，少油少盐，晚上我们再聊聊你的运动安排好不好";
    const text = `${a}\n\n${b}\n\n${a}`;

    const result = await filterReplyText(text, undefined, NON_EXCLUDED_SESSION_KEY);

    expect(result.drop).toBe(false);
    expect(result.text).toBe(`${a}\n\n${b}`);
  });

  it("short duplicates (<20 chars) are NOT deduped → both kept", async () => {
    const text = "早～\n\n早～";

    const result = await filterReplyText(text, undefined, NON_EXCLUDED_SESSION_KEY);

    expect(result.drop).toBe(false);
    expect(result.text).toBe("早～\n\n早～");
  });

  it("slightly different paragraphs (≥20 chars, differ by one char) → both kept", async () => {
    const a = "你好今天吃了什么呀宝宝你好今天吃了什么呀宝宝";
    const b = "你好今天吃了啥呀宝宝你好今天吃了什么呀宝宝";
    const text = `${a}\n\n${b}`;

    const result = await filterReplyText(text, undefined, NON_EXCLUDED_SESSION_KEY);

    expect(result.drop).toBe(false);
    expect(result.text).toBe(`${a}\n\n${b}`);
  });

  it("real Mo 08:18 case: two Chinese paras differ only by trailing tilde (FULLWIDTH vs ASCII) → both survive", async () => {
    const fullwidth =
      "连续第4天打卡啦～慢慢摸到你的早餐节奏了 ☀️\n新的一天，早餐吃啥？拍张照发我就行～";
    const ascii = "连续第4天打卡啦～慢慢摸到你的早餐节奏了 ☀️\n新的一天，早餐吃啥？拍张照发我就行~";
    const text = `Length budget: ≤80 chars Chinese (excl. final invitation).\n\n${fullwidth}\n\n${ascii}`;

    const result = await filterReplyText(text, undefined, NON_EXCLUDED_SESSION_KEY);

    expect(result.drop).toBe(false);
    // Exact-match dedup: these are not byte-equal, so both must survive.
    expect(result.text).toContain(fullwidth);
    expect(result.text).toContain(ascii);
    // Don't assert on the "Length budget" line — existing v6 fastReject rules
    // may or may not strip it.
  });
});
