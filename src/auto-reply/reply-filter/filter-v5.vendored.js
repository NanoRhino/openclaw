let _replyFilterCfg = null;
let _replyFilterCfgMtime = 0;
// Bumped when the header body changes so apply.py can refresh an already-
// injected older header in place (see refresh_header in apply.py).
const _REPLY_FILTER_HEADER_VERSION = 20;
// v20 (2026-09-06, openclaw-infra#200 — from #185): STRIP-type transform for
// leaked internal tokens on macro lines: "Protein 42g (no token)" reached 7
// users / 21 messages. The kill-type layers can't help — dropping the paragraph
// eats the member's whole day card — so the token is removed and the line is
// kept. Deliberately narrow: only "(no token)/(none)/(null)/(undefined)"
// immediately after a number+unit (42g / 250 kcal); a standalone "(none)" in
// prose ("Restrictions: (none)") is untouched. Corpus 2026-09-06: 21/21 known
// instances hit, 0 other lines touched. Decision log: stats.st + {y:"strip"}.

// v19 (2026-09-04, openclaw-infra#186 reopen): the 6 service-incident apology
// notices sent that day were each cut 546→271 chars by two separate
// mechanisms. (1) The narration-opener regex ("The user/bug/issue/…") killed
// "The issue has been fully resolved … if a meal or weigh-in you sent …" —
// decisions log since 2026-07: that opener family killed 10 paragraphs, 4 true
// narration (none addressed to the member) + those 6. "The issue/problem/error"
// openers are now exempt when the paragraph speaks to the member (you/your)
// and carries no internal hard mark. (2) The classifier killed the bare
// salutation "Dear NanoRhino member," and the sign-off "— The NanoRhino Team"
// (no clean signal, so they were judged in isolation as meta). Those frames
// now skip the classifier (_RF_NOTICE_FRAME) — corpus 2026-09-04: 46
// delivered salutation lines (all coach greetings), 5 "— NanoRhino" sign-offs,
// zero narration hits.

// v14 (2026-08-01, agents 050171/050184/050273 + 10 others): the embedded
// runner's tool-error warning — "⚠️ 📝 Edit: in /tmp/noop.txt failed" /
// "⚠️ ✍️ Write: to /dev/null failed" — reached 13 real users over 7/17-8/1.
// The Sonnet main line invents no-op tool calls (noop.txt / /dev/null /
// dummy.txt / empty edits) between finishing real work and composing the
// <final> reply; the calls fail, and resolveToolErrorWarningPolicy echoed
// mutating-tool failures to the channel unconditionally. The EMITTER is fixed
// (messages.suppressToolErrors=true honored before the mutating branch,
// 021b5b257f3); this rule is the deterministic second belt so no ⚠️-prefixed
// tool-failure echo of any shape ever reaches a user again, whatever path
// produces it. Corpus-validated 2026-08-01 against all 28,911 delivered
// messages: matches exactly the 13 known harness leaks, zero coach-authored
// hits; the 147 other ⚠️-prefixed lines (error notices like "Something went
// wrong…", which carry no "failed") are untouched.
// v15 (2026-08-14, billing-pilot activation notice): the paragraph "Three
// promises: only new lows bill · the same pound never bills twice (regain +
// re-lose = free) · plateaus cost nothing." was killed by the classifier on
// agent 050171's activation notice (679→557 chars, y:llm) — a terse
// middot-separated list with no you/your/emoji/nutrition vocab reads as
// internal metadata. With results billing live, MONEY talk (bills, receipts,
// pay links, the pricing terms) is user-facing by construction and must never
// be silently dropped — a user who never sees their bill is strictly worse
// than a rare narration leak. Fix mirrors v12: `_RF_BILLING` is a first-class
// user-facing CLEAN SIGNAL — dollar amounts ($10/lb, $68, $500), "never
// bills twice", billing/billed/invoice vocab (en + zh 计费/账单/免单/封顶),
// and first-party pay/pricing URLs. Hard marks still override (the AND in
// _rfGateSkipLLM is unchanged), so "invoice_created, now mark it sent"
// narration keeps filtering. Second belt: classifier prompt gains a
// billing-terms keep example.
// v12 (2026-07-17, agent 050304 incident): a medical safety referral was
// silently killed by the Bedrock Haiku classifier. The delivered coach reply
// (user asking on a friend's behalf about severe muscle cramps after heavy
// weight loss + hard training) contained the paragraph:
//   "If it's a bad, recurring, or severe spasm, that's worth an actual doctor
//    visit — could also be something else going on. Not something to guess at
//    over text."
// It carried NO hard mark and NO user-facing clean signal (no you/your, no
// emoji, no nutrition vocab), so the suspicion gate did NOT fast-accept it →
// it went to the classifier, which read "Not something to guess at over text"
// as meta self-reference and returned "true" (kill). A health product must
// never silently drop a see-a-doctor referral. Fix: medical-referral /
// seek-care language is now a first-class user-facing CLEAN SIGNAL
// (_RF_MEDICAL_REFERRAL), same status as nutrition vocab — a paragraph that
// carries it and NO internal hard mark skips the classifier and is kept. The
// gate's hard-mark AND is unchanged, so third-person narration like "the user
// should see a doctor" is still filtered (it trips both _fastReject's
// "the user" rule and the hard-mark gate — clean signal does NOT override a
// hard mark). Narrow by design ("宁窄勿宽"): a bare "doctor" is not enough;
// the trigger is an explicit referral phrase (doctor visit, see/talk to a
// doctor, medical attention, urgent care, ER, 911, get it checked out).
// Second belt: the classifier prompt gains a medical-referral keep example.
// v11 (2026-07-15): classifier moved to Bedrock Haiku 4.5 (reply-filter.json
// {"provider":"bedrock","model":"global.anthropic.claude-haiku-4-5-20251001-v1:0"},
// hot config — gpt-5.5 ran a 13% classify-timeout rate at the 2000ms cap; Haiku
// answers in ~1s). Code fix required for that path: Haiku sometimes appends
// prose after the verdict ("true\n\nThis is" — 1 of 6 live probes, truncated at
// max_tokens 4), and the shared verdict check used STRICT equality
// (answer === "true"), silently turning such answers into "keep". The verdict
// is now normalized with startsWith("true") — matching the openai branch's
// looser includes() semantics — so a chatty verdict still filters.
// v10 (2026-07-15, coach-issues Issue-3): internal DELIBERATION delivered as
// real SMS — weigh-in/goal-weight decision narration ("Good downward trend, no
// intervention needed. Check pending recalc and goal ask, then finish.", "this
// user's already onboarded", "I shouldn't re-derive it") and correction-flow
// analysis ("This is a correction — the user is saying the amount is off…").
// 7 delivered leaks across 5 users on 2026-07-15 + 2 earlier same-shape
// (2026-07-11/12). Telemetry decomposition: 4 leaks skipped the LLM via the
// suspicion gate (nutrition vocab = clean signal, none of these shapes were
// hard marks), 3 were gate-flagged but the classify TIMED OUT and the dispatch
// path failed open. Fixes:
//   1. New _fastReject kills (corpus-validated 0 FP over 28,255 delivered
//      paragraphs 2026-07-01..15): third-person member reference ("the/this/
//      that user", "handoff user"), "no intervention needed", "re-deriv*",
//      "pending recalc*", "goal(-weight) ask", and the "This is a correction/
//      context …" analysis opener.
//   2. Hard-mark gaps: "I shouldn't" (the old \bI should\b never matched the
//      contraction), "the script".
//   3. Dispatch classify failures now retry once (previously deliver-only);
//      if the retry also fails AND the paragraph carries a hard internal
//      marker, it is suppressed (fail-closed, telemetry y:"fcd") — an
//      unjudgeable paragraph that tripped an internal marker is more likely
//      narration than coaching. Unmarked/no-signal paragraphs keep v9's
//      fail-open dispatch semantics.
//   4. Classifier prompt gains the decision-narration/self-instruction shapes.
// v9 (2026-07-11, "B" of the leak-hardening pass): the deliver chokepoint
// (Path 2 — cron/announce/message-tool, the historical leak source) now passes
// { path: "deliver" } as a 4th argument (apply.py upgrades the injected call
// line in place). On that path a suspicious paragraph whose classify attempt
// FAILS (timeout or error) is retried once and then suppressed — fail-CLOSED —
// instead of delivered unjudged; cron sends are latency-insensitive, so the
// timeout is also longer there ({"classifyTimeoutMsDeliver", default 4000}).
// The interactive dispatch path keeps fail-open (never hold a user's reply
// hostage to filter infra). Whole-message fail-closed suppressions alert the
// WeCom proxy. Config-level classifier unavailability (no SDK / no key) stays
// fail-open on BOTH paths — that is an ops failure with its own alert, not a
// per-paragraph judgment failure.
// v8 (2026-07-11 review of 48h prod corpus — 1,279 delivered SMS + 841 composed
// turns; docs/perf/2026-07-11-reply-filter-v8.md):
//   1. Suspicion gate: only paragraphs with internal markers (or without any
//      user-facing signal) pay the LLM classify. 92% of real delivered replies
//      skip the LLM phase entirely (was 19% via the meal fast-accept alone),
//      cutting ~1-1.4s off most non-meal replies and shrinking the classify
//      timeout surface (~37 fail-open TimeoutErrors/day → a few) to the
//      paragraphs that actually need judging. Kill switch: {"suspicionGate":false}.
//   2. FP fix (confirmed prod hit 050184 2026-07-10): gerund openers
//      (Checking/Running/Updating/...) now require an internal OBJECT on the
//      same line — "Running ahead of pace today" (coaching) is kept, "Reading
//      the config file" is killed. Same for "I'll check ..." ("I'll check in
//      with you" kept). "Let me <verb>" narrows to an internal-verb list so
//      "Let me know ..." / "Let me break it down for you" survive.
//   3. FN closures from the corpus: JSON-blob final texts ('{"tasks_completed"
//      ...}' — 13 composed in 48h, previously LLM-only), task-status lines
//      ("Both tasks complete.", "no cleanup needed"), pre-compose narration
//      ("Good — no restrictions on file. Now I'll compose ...", "No
//      restrictions. Tier 2 ...", "Now update <fields> ..."), and [[directive]]
//      routing tokens leaked into the text ([[reply_to_current]] — 050171).
//   4. Decision telemetry: one JSONL line per filtered reply to
//      ~/.openclaw/logs/reply-filter-decisions.jsonl (fire-and-forget) —
//      per-layer kill counts + previews, classify latency/timeouts, gate skips.
//      Kill switch: {"decisionLog":false}. This is the accuracy feedback loop.
//   5. Classifier ops: timeout hot-tunable via {"classifyTimeoutMs":N} (default
//      2000), warmup ping on first enabled call (kills the cold-start tail),
//      Bedrock client rebuilt if cfg region changes (config hot-reloads).
const _CLASSIFY_TIMEOUT_MS = 2000;
const _CLASSIFY_TIMEOUT_MS_DELIVER = 4000;
import _replyFilterFs from "node:fs";
import _replyFilterPath from "node:path";
import { fileURLToPath as _replyFilterFileURLToPath } from "node:url";
function _loadReplyFilterCfg() {
  try {
    if (!_replyFilterFs) return null;
    const cfgPath = (process.env.HOME ?? "/root") + "/.openclaw/reply-filter.json";
    const stat = _replyFilterFs.statSync(cfgPath);
    if (stat.mtimeMs !== _replyFilterCfgMtime) {
      _replyFilterCfg = JSON.parse(_replyFilterFs.readFileSync(cfgPath, "utf-8"));
      _replyFilterCfgMtime = stat.mtimeMs;
    }
  } catch {
    _replyFilterCfg = null;
  }
  return _replyFilterCfg;
}
// ── Line-anchored narration / NO_REPLY stripping (no API call) ──
// These run BEFORE paragraph splitting so they catch leaks that sit on their
// own line inside an otherwise-good paragraph. Every pattern is anchored to
// start-of-line (`^`) with `m` flag and matched against a SINGLE line — never
// a bare substring — so legitimate copy that merely *contains* one of these
// words mid-line ("Let me know if…", "Now's a great time to…") is untouched.
//
// A bare NO_REPLY token (optionally wrapped in markdown decoration —
// **bold**, `code`, _italics_ — / surrounding whitespace) appearing anywhere
// in the body. The model sometimes emits `**NO_REPLY**` or a `` `NO_REPLY` ``
// code-span on its own line then "corrects" itself — strip the token line
// wherever it occurs, not only when it's the entire message. The backtick
// variant is the one that leaked to a real SMS on 2026-07-06 (agent 050171
// weekly-report cron): the model wrapped the sentinel in a code-span, which
// dodged the old asterisk-only wrapper, and the backticks were then flattened
// by plaintext rendering — so the user received the raw "NO_REPLY".
const _NO_REPLY_LINE = /^[ \t]*[`*_]{0,3}[ \t]*NO_REPLY[ \t]*[`*_]{0,3}[ \t]*$/im;
const _NO_REPLY_LINE_G = /^[ \t]*[`*_]{0,3}[ \t]*NO_REPLY[ \t]*[`*_]{0,3}[ \t]*$/gim;
// Internal narration verbs after "Let me" — expanded in v8 with the shapes
// observed in the 2026-07 corpus ("Let me use the exact existing name",
// "Now let me pull the meal data"). "know" is deliberately NOT here.
const _RF_LETME_VERBS =
  "(?:finalize|send|generate|read|write|fix|update|check(?! in\\b)|reconsider|use|pull|verify|confirm|see|think|build|start|run|re-?run|look|double-?check|grab|fetch|parse|compute|calculate)";
// Self-narration meta-lines the model leaks. Anchored to start-of-line and to
// the SPECIFIC leaked shapes from the 2026-06 incidents (users 050184 / 050194
// / 050177 / 050165). Each alternative is a narration *opener* that no real
// SMS to a user would begin a standalone line with.
const _NARRATION_LINE = new RegExp(
  "^[ \\t]*(?:\\*{0,2})[ \\t]*(?:" +
    [
      // "Wait — I should just output the message, not NO_REPLY." (em-dash or hyphen)
      "Wait\\s*[—–-]",
      // "Let me finalize:" / "Let me send …" / "Let me pull …" / "Let me use …"
      "Let me " + _RF_LETME_VERBS + "\\b",
      // "Stage 1, SEND…" / "Stage 1 — sending normal weight reminder…"
      "Stage \\d",
      // "Now I'll generate the tip, then mark it sent." / "Now let me read …" / "Now let's build …"
      "Now (?:I'?ll|I will|let me|let'?s)\\b",
      // "All 9 reminders created. Now marking onboarding complete."
      "All \\d+ (?:reminders?|jobs?|crons?|tasks?|files?)\\b",
      // "The card generated successfully with keto macros… Let me send it now."
      "The card generated\\b",
      // "The gateway isn't running. Let me fix that…"
      "The gateway (?:isn'?t|is not|was|wasn'?t)\\b",
    ].join("|") +
    ").*$",
  "im",
);
// A "self-correction divider": the model abandons its prior draft and re-emits
// the final version after this line. When present, everything BEFORE the last
// such line is an abandoned draft (often a near-duplicate of the final text,
// plus a leaked NO_REPLY) and must be discarded — keeping only the final block.
// This is the "take only the final message block" post-processing the issue
// asks for, scoped to the exact self-correction shapes observed.
const _CORRECTION_DIVIDER =
  /^[ \t]*(?:\*{0,2})[ \t]*(?:Wait\s*[—–-].*?Let me finalize|Let me finalize|Wait\s*[—–-].*?(?:just output|output the message))/im;
// Internal routing/control directives leaked into the reply body, e.g. a
// "[[reply_to_current]]" prefix observed on agent 050171 (2026-07-10). The
// token is stripped, the rest of the line is delivered.
const _DIRECTIVE_TOKEN_G = /^[ \t]*(?:\[\[[A-Za-z0-9_:.-]{1,40}\]\][ \t]*)+/gm;
const _INTERNAL_TOKEN_G =
  /(\d+(?:\.\d+)?\s*(?:g|kcal|cal|calories))[ \t]*\((?:no token|none|null|undefined)\)/gi;
// Strip standalone narration/NO_REPLY lines from a body. Returns the cleaned
// body (may be empty/whitespace, which the caller treats as "suppress").
function _stripNarrationLines(text) {
  // Step 1: if a self-correction divider is present, drop everything up to and
  // including the LAST one — that prefix is the abandoned draft (the duplicate).
  const lines = text.split("\n");
  let lastDivider = -1;
  for (let i = 0; i < lines.length; i++) {
    if (_CORRECTION_DIVIDER.test(lines[i])) lastDivider = i;
  }
  const scoped = lastDivider >= 0 ? lines.slice(lastDivider + 1) : lines;
  // Step 2: strip any remaining standalone NO_REPLY tokens + narration lines.
  return (
    scoped
      .filter((line) => !_NO_REPLY_LINE.test(line) && !_NARRATION_LINE.test(line))
      .join("\n")
      // Collapse the blank-line holes left behind so paragraph splitting stays sane.
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\s+|\s+$/g, "")
  );
}
// Drop exact-duplicate paragraphs (keep first occurrence), normalized on
// trimmed + whitespace-collapsed text. Catches the cron double-emit where the
// model outputs the SAME reminder text twice in one turn (often with a
// NO_REPLY between them); after NO_REPLY is stripped, two identical paragraphs
// would otherwise be joined and delivered as one doubled SMS. p0-01 follow-on.
function _dedupParagraphs(arr) {
  const seen = new Set();
  const out = [];
  for (const p of arr) {
    const key = p.trim().replace(/\s+/g, " ");
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}
// ── First-party URL whitelist (never filter user-facing links) ──
// A paragraph carrying a NanoRhino report/plan/CTA URL is content the agent
// composed FOR the user (e.g. "Full weekly report here:\nhttps://nanorhino.ai/
// user/050171/weekly-report.html?week=…"). It survives _fastReject (the file-path
// regex doesn't match .html) but the Phase-2 Haiku classifier reads the URL as a
// "tool/file reference" and stochastically strips it — so ZERO of 2,320 outbound
// SMS over 7 days contained a nanorhino URL. Exempt these paragraphs from BOTH
// filter phases so they're delivered verbatim.
function _isUserFacingUrlPara(p) {
  // Match nanorhino.ai/com AND any first-party subdomain (user.nanorhino.com,
  // www.nanorhino.com, …) so the dashboard link survives both filter phases.
  // Subdomain labels only — no broadening to third-party hosts that merely
  // contain "nanorhino" (e.g. nanorhino.evil.com): a dot must immediately
  // precede "nanorhino" and the TLD must be ai|com with a path slash after.
  return /https?:\/\/(?:[a-z0-9-]+\.)*nanorhino\.(?:ai|com)\//i.test(p);
}
// ── Non-brand URL stripper (deterministic, no API call) ──
// Removes any URL / bare domain that is NOT a NanoRhino first-party link
// (nanorhino.ai / nanorhino.com and their subdomains); brand links are kept
// verbatim. Catches off-brand citations a model may append to an SMS
// (e.g. "(shop.atkins.com)"). Runs on EVERY reply — regardless of the LLM
// filter being enabled or the agent being excluded — so no non-brand URL can
// reach a user. \x00 (NUL) is the removal sentinel; it never appears in text.
const _RF_BRAND_HOST = /(?:^|\.)nanorhino\.(?:ai|com)$/i;
function _rfIsBrandUrl(u) {
  try {
    const h = u
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .split(/[\/?#]/)[0]
      .toLowerCase();
    return _RF_BRAND_HOST.test(h);
  } catch {
    return false;
  }
}
const _RF_URL_RE =
  /(?:https?:\/\/|www\.)[^\s)\]>]+|\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|ai|app|co|us|uk|ca|gov|edu|info|shop|store|biz)\b(?:\/[^\s)\]>]*)?/gi;
function _stripNonBrandUrls(text) {
  if (
    !text ||
    (!/https?:\/\//i.test(text) &&
      !/\bwww\./i.test(text) &&
      !/\b[a-z0-9-]+\.(?:com|net|org|io|ai|app|co|us|uk|ca|gov|edu|info|shop|store|biz)\b/i.test(
        text,
      ))
  )
    return text;
  let changed = false;
  let out = text.replace(_RF_URL_RE, (m) => {
    if (_rfIsBrandUrl(m)) return m;
    changed = true;
    return "\x00";
  });
  if (!changed) return text;
  out = out
    .replace(/[ \t]*[\(\[]\s*\x00\s*[\)\]]/g, "")
    .replace(/[ \t]*\x00/g, "")
    .replace(/\x00/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([.,!?;:])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]+$/gm, "");
  return out;
}
// ── Fast regex reject (no API call) ──
// v8: gerund openers require an internal object on the same line. A fitness
// coach legitimately opens lines with "Running …" / "Checking …" ("Running
// ahead of pace today — fat's climbing fast" was stripped from a REAL user's
// meal confirmation on 2026-07-10, agent 050184). Narration about files/tools
// still dies; coaching that merely starts with a gerund survives.
const _RF_INTERNAL_OBJ =
  "(?:data|files?|log ?files?|jsonl?|markdown|scripts?|crons?|config(?:uration)?s?|memory|skills?|sections?|entr(?:y|ies)|workspace|director(?:y|ies)|fields?|schemas?|payloads?|databases?|USER\\.md|PLAN\\.md|SKILL\\.md)";
const _RF_GERUND_INTERNAL = new RegExp(
  "^(?:Looking at|Checking|Reading|Writing|Updating|Creating|Running|Calling|Executing|I'll (?:check|look|read|update)|I will (?:check|read))\\b[^.!?\\n]{0,60}\\b" +
    _RF_INTERNAL_OBJ +
    "\\b",
  "i",
);
function _fastReject(p) {
  // v14: harness tool-failure echo ("⚠️ 📝 Edit: in /tmp/noop.txt failed",
  // "⚠️ ✍️ Write: to /dev/null failed") — never user content. Line-anchored
  // AND requires the "failed" verb, so error notices without it ("⚠️
  // Something went wrong…") and any coach-authored ⚠️ line pass untouched.
  if (/^[ \t]*⚠️[^\n]{0,200}\bfailed\b/i.test(p)) return true;
  // Machine output as final text: memory-consolidation crons end their turn
  // with a raw JSON object ('{"tasks_completed": …}' — 13 composed in 48h on
  // 2026-07-09/10). No legitimate SMS starts with a JSON bracket.
  if (/^\s*\{[^\n]{0,300}[:}]/.test(p) || /^\s*\[\s*[\{"]/.test(p)) return true;
  if (
    /(?:data\/|\.json|\.md|\.py|\.sh|baseDir|workspaceDir|scripts\/)/.test(p) &&
    !/^[>*\-]/.test(p)
  )
    return true;
  if (
    /(?:已写入|已保存到|已记录到|已更新.*文件|written to|saved to|logged to)/i.test(p) &&
    /\.(?:json|md|csv)\b/.test(p)
  )
    return true;
  // NO_REPLY in _fastReject: only reject if the paragraph is purely NO_REPLY
  // (tolerate markdown decoration — `code`, **bold**, _italics_ — around it,
  // so a `` `NO_REPLY` `` code-span is caught, not just the bare token).
  if (/^[\s`*_]*NO_REPLY[\s`*_]*$/.test(p)) return true;
  if (/(?:已通过.{1,6}回复|已发送到|already sent|already replied)/i.test(p)) return true;
  // Narration openers. "Let me" narrows to internal verbs (v8) so "Let me
  // know …" / "Let me break it down for you" survive; "I'll now" stays
  // unconditional; gerunds + "I'll check/read/update" moved to the
  // object-gated rule below.
  if (
    new RegExp(
      "^(?:Let me " +
        _RF_LETME_VERBS +
        "\\b|I'll now |I will now |Now I(?:'ll| will| need to) |Now let(?: me|'s) )",
      "i",
    ).test(p)
  )
    return true;
  if (_RF_GERUND_INTERNAL.test(p)) return true;
  if (
    /^(?:我来(?:看|查|检查|读|更新)|让我(?:看|查|检查)|我先(?:看|查|读)|现在我(?:来|去)|我看[看下一](?:这|你|那)|我检查一下|我查[看一])/i.test(
      p,
    )
  )
    return true;
  if (
    /^(?:Here'?s what I (?:did|found)|Done[.!]?\s*(?:I |Here)|OK[,.]?\s*(?:I've |I (?:just |already )))/i.test(
      p,
    )
  )
    return true;
  if (/^好的[，,]?\s*我(?:已经|来|先)/.test(p)) return true;
  if (/^(?:执行|调用|运行|正在(?:读取|写入|更新|检查|处理))/.test(p) && p.length < 80) return true;
  if (
    /\b(insufficient[_ ]data|no (?:message sent|action taken)|cron (?:preserved|job preserved)|will retry tomorrow|pre-send check)\b/i.test(
      p,
    )
  )
    return true;
  if (
    /^(?:The message should (?:combine|include|mention|start)|compose a|write a message that|draft the|send a (?:photo|image) invite)/i.test(
      p,
    )
  )
    return true;
  if (
    /\b(?:days_silent|Tier [0-3]|current_streak|Stage:|consecutive_increases|active_strategy|logging_gaps|no same weekday data)\b/.test(
      p,
    )
  )
    return true;
  // ── v5.1 hardening: confirmed leak patterns (2026-06 incidents) — no SDK dependency ──
  // HTML comments are never user-facing SMS content (e.g. "<!--diet_suggestion-->")
  if (/<!--[\s\S]*?(?:-->|$)/.test(p)) return true;
  // Cron self-deletion / one-shot reminder housekeeping notes
  if (
    /(?:self-?delet\w*|delete (?:this|the) (?:reminder|cron|job)|one-?time (?:reminder|cron)[^.\n]{0,40}delet|发送后(?:请)?删除|删除(?:此|该|本)(?:提醒|任务|定时任务|cron)|此(?:提醒|任务)(?:为一次性|发送后|已完成))/i.test(
      p,
    )
  )
    return true;
  // Thinking/debug openers at paragraph start ("The gateway isn't running...", "Wait, ...")
  if (
    !_rfMemberNoticeOpener(p) &&
    /^(?:The (?:user|bug|issue|problem|error|fix|gateway|script|file|code|agent|cron|workspace|skill)\b|Wait[,.]|Hmm\b|I (?:need|should|want) to |I'm going to |First[,，]? (?:I|let)\b|Next[,，]? I\b|Now marking\b|Perfect[.!] (?:Now|I|The)|Good[.!] (?:Now|I|The)|Done[.!] (?:Now|I|The))/i.test(
      p,
    )
  )
    return true;
  // Bulk-operation status lines ("All 9 reminders created. Now marking ...")
  if (
    /^All \d+ (?:reminders?|jobs?|crons?|tasks?|files?) (?:created|set|updated|done|deleted)/i.test(
      p,
    )
  )
    return true;
  // Backticked snake_case identifiers are debug/code talk ("the bug is that `data_dir` ...")
  if (/`[a-z][a-z0-9]*(?:_[a-z0-9]+)+`/.test(p)) return true;
  // ── v17: abandoned mid-draft self-correction delivered as SMS (2026-08-29,
  // 060366): the model emitted a meal card that broke off in "…Fat 0.5g...
  // wait", then a second corrected <final> — BOTH were delivered (the meal
  // fast-accept let the dead draft skip the classifier). A paragraph that ENDS
  // on an ellipsis + "wait" is an abandoned draft, never finished copy.
  // Corpus-validated: exactly 1 hit in 38,854 delivered texts — the incident.
  if (/(\.\.\.|…)\s*wait[.!?]?\s*$/i.test(p)) return true;
  // ── v8 additions: task-status + pre-compose narration (2026-07 corpus) ──
  // "Both tasks complete." / "Well under limit, no cleanup needed." (memory crons)
  if (/^(?:Both|All) tasks? complete\b/i.test(p)) return true;
  if (/\bno cleanup needed\b/i.test(p)) return true;
  // v16 (2026-08-16 W33 leak): report-pipeline step narration — 13 delivered
  // leaks like "Now run Step 5a (intake signal), skip 5b". Corpus-validated
  // 0 FP over 61,363 delivered paragraphs (only other hits: three unnoticed
  // 2026-07-26 W30-night leaks of the same class).
  if (/^Now (?:run|re-?run|execute)\b/i.test(p)) return true;
  if (/\b(?:run|re-?run|skip|need(?:ed)?|check) (?:Step )?\d+[ab]\b/i.test(p)) return true;
  if (/\bStep \d+[ab]\b/i.test(p)) return true;
  if (/\b(?:intake[- ]signal|weight[- ]lead)\b/i.test(p)) return true;
  if (/^Gate says no\b/i.test(p)) return true;
  if (/\b(?:no-weight (?:report|path|step)|weight-present path)\b/i.test(p)) return true;
  if (/^Everything (?:is |looks )?(?:confirmed|verified|correctly|within)/i.test(p)) return true;
  // "Now update the conclusion and follow-ups fields …" (imperative self-talk)
  if (
    /^Now (?:update|set|mark|compose|build|create|write|read|pull|delete|add|rotate|consolidate)\b/i.test(
      p,
    )
  )
    return true;
  if (/^Composing\b/i.test(p)) return true;
  // "Good — no restrictions on file. Now I'll compose …" / "Good, I have enough context."
  if (
    /^Good\b[\s,，]*[—–-]?\s*(?:I have enough\b|no restrictions\b|Now (?:I|let|compose))/i.test(p)
  )
    return true;
  // "No restrictions. Tier 2 — just a friendly lunch log invite."
  if (
    /^No (?:notable )?restrictions(?: on file)?[.,][^\n]{0,60}(?:Tier|[Dd]egrade|compos|Now\b|I\b)/.test(
      p,
    )
  )
    return true;
  // ── v10 additions: internal deliberation delivered as SMS (coach-issues Issue-3, 2026-07-15) ──
  // Weigh-in/goal-weight decision narration + correction-flow analysis reached
  // 5 real users as SMS. Every pattern below was corpus-validated with ZERO
  // false positives against 28,255 delivered paragraphs (2026-07-01..15).
  // The coach always addresses the member as "you" — a third-person member
  // reference is the strongest single narration marker.
  if (/\b(?:the|this|that) user(?:'s)?\b|\bhandoff user\b/i.test(p)) return true;
  // Weigh-in trend verdicts + post-save checklist talk (weight-tracking skill
  // internals: save-and-check → intervention judgment → pending recalc → goal ask).
  if (/\bno intervention needed\b|\bre-?deriv\w+|\bpending recalc\w*\b/i.test(p)) return true;
  if (/\bgoal[- ]weight ask\b|\bgoal ask\b/i.test(p)) return true;
  // "This is a correction — the user is saying…" / "This is context about an
  // already-logged meal … I should just acknowledge, not re-log." (both 050225,
  // 2026-07-15). Requires an analysis tail so a hypothetical user-facing
  // "This is a correction to your total: 720 kcal" is never eaten.
  if (
    /^This is (?:a )?(?:correction|context)\b[^\n]{0,200}\b(?:the user|I should|I need|just acknowledge|not (?:a new|disputing|re-?logg?))/i.test(
      p,
    )
  )
    return true;
  // ── v13 additions: composer/self-instruction narration that carries nutrition
  // vocab and so slipped the suspicion gate as "user-facing" (050317 2026-07-28
  // "No message content to log or act on here … Respond with empathy, no meal
  // card needed." — decision row: gs=2, lc=0, kept). Every pattern below was
  // corpus-validated with ZERO false positives against 59,986 delivered
  // paragraphs (fleet outbound.jsonl through 2026-07-28); the only hits are the
  // known leaks (050317 7/28, 050298 7/13, 050266 7/24, 050027 6/24, 050320
  // 7/2, and the three 7/26 weekly-report narrations).
  if (/^No (?:message|new|meal|food) content\b/i.test(p)) return true;
  if (/\bno meal card needed\b/i.test(p)) return true;
  if (/(?:^|[.!—–-]\s*)Respond with (?:empathy|warmth)\b/i.test(p)) return true;
  if (/\bI did not schedule a reminder\b|\bwill not trigger automatically\b/i.test(p)) return true;
  if (/\bjust an update on how (?:she|he|they)\b/i.test(p)) return true;
  if (
    /\b(?:render|rendering) the \w+ angle\b|\bangle (?:is already chosen|with a light invite)\b/i.test(
      p,
    )
  )
    return true;
  if (/\bpending flag\b/i.test(p)) return true;
  if (/\bno same-?weekday\b/i.test(p)) return true;
  return false;
}
// ── Bedrock SDK discovery (dynamic — no hardcoded install paths) ──
let _rfSdkResolved = null;
let _rfSdkMissingLastLog = 0;
function _rfSdkCandidates() {
  const rel = _replyFilterPath.join("@aws-sdk", "client-bedrock-runtime", "dist-cjs", "index.js");
  const home = process.env.HOME ?? "/root";
  const candidates = [];
  if (process.env.OPENCLAW_BEDROCK_SDK) candidates.push(process.env.OPENCLAW_BEDROCK_SDK);
  try {
    // This header is injected into a chunk inside <openclaw>/dist/, so the package's
    // own node_modules is always reachable from import.meta.url — survives nvm/pnpm
    // upgrades and version-suffixed global paths without any hardcoding.
    const distDir = _replyFilterPath.dirname(_replyFilterFileURLToPath(import.meta.url));
    candidates.push(_replyFilterPath.join(distDir, "..", "node_modules", rel));
    candidates.push(_replyFilterPath.join(distDir, "..", "..", "node_modules", rel));
    candidates.push(_replyFilterPath.join(distDir, "..", "..", "..", "node_modules", rel));
  } catch {}
  if (process.env.OPENCLAW_DIST)
    candidates.push(_replyFilterPath.join(process.env.OPENCLAW_DIST, "..", "node_modules", rel));
  // Legacy fallbacks (pre-2026.4 layouts); extensions are last resort — their
  // node_modules are owned by deploy.sh and may be pruned (see PR #45).
  candidates.push(_replyFilterPath.join(process.cwd(), "openclaw", "node_modules", rel));
  for (const _ext of ["twilio", "meal-tracker", "wechat", "qqbot"]) {
    candidates.push(
      _replyFilterPath.join(home, ".openclaw", "extensions", _ext, "node_modules", rel),
    );
  }
  return candidates;
}
function _resolveBedrockSdkPath() {
  if (_rfSdkResolved) return _rfSdkResolved;
  const candidates = _rfSdkCandidates();
  const found = candidates.find((p) => {
    try {
      return _replyFilterFs.existsSync(p);
    } catch {
      return false;
    }
  });
  if (found) {
    _rfSdkResolved = found;
    console.log("[reply-filter] bedrock SDK resolved:", found);
    return found;
  }
  // Fail-open (never block user messages on filter infra) but fail-VISIBLE:
  // ERROR-level so monitoring catches it, throttled to once per 5 minutes.
  const now = Date.now();
  if (now - _rfSdkMissingLastLog > 5 * 60 * 1000) {
    _rfSdkMissingLastLog = now;
    console.error(
      "[reply-filter] ERROR: bedrock SDK not found — LLM filter layer INACTIVE (fail-open, regex layer only). Tried " +
        candidates.length +
        " candidates, first: " +
        candidates[0] +
        ". Set OPENCLAW_BEDROCK_SDK to override.",
    );
  }
  return null;
}
// ── LLM-based classification (Bedrock Claude Haiku fallback) ──
const _replyFilterCache = new Map();
const _FILTER_PROMPT = `You are the outbound filter for an SMS nutrition coach. Decide whether this paragraph is INTERNAL agent output (narration/bookkeeping that must never be texted to the member) or a USER-FACING message. Output ONLY "true" (internal — filter it) or "false" (user-facing — keep).

true (filter) — any of:
- the NO_REPLY sentinel (with or without markdown decoration) or [[directive]] tokens
- planning/narration about the agent's OWN execution (tools, files, composing): "Let me check…", "Now I'll compose…", "I'll update the file…", "Composing now." — an "I'll…" that promises work FOR the member is coaching, NOT this (see keep list)
- tool/file/system talk: data/, .json, .md, scripts/, cron, workspace, skill names
- task status or raw JSON: "Both tasks complete", '{"tasks_completed": …}', "已写入", "saved to"
- state analysis about the member in third person, from internal data: "days_silent", "Tier 2 degrade", "she has 959 kcal left", "current_streak = 2", "this user's already onboarded", "this is a handoff user" — but ANSWERING the member's own question about someone else (a friend/family referral) is user-facing (see keep list)
- decision narration / self-instructions before acting: "Good downward trend, no intervention needed.", "Check pending recalc and goal ask, then finish.", "Now let's log the meals.", "I should just acknowledge, not re-log.", "Weight up slightly but within normal fluctuation — nothing to react to. Now let's log the meals."
- composition instructions: "The message should mention…", "compose a…"
- delivery notices: "already sent", "已通过微信回复"

false (keep) — text written TO the member, in any language:
- meal/weight confirmations ("📝 Lunch logged!…", "✏️ Updated: …", "Logged ✓ 136 lb")
- day summaries ("📊 So far today: …"), coaching, encouragement, reminders, questions
- medical safety guidance / referrals TO the member: "that's worth an actual doctor visit", "see your doctor", "talk to your doctor about it", "go to the ER if it worsens", "worth getting that checked out" — ALWAYS keep; a health coach must never drop a see-a-doctor referral
- billing/pricing terms TO the member: "Three promises: only new lows bill · the same pound never bills twice (regain + re-lose = free) · plateaus cost nothing.", "$10/lb, capped at $500 lifetime", "6 lbs → $60 · tap to pay", receipts, pay links — ALWAYS keep; a member must never miss money talk
- coach plans/commitments addressed TO the member: "Got it — 5 days a week it is. I'll build sessions around 20-25 min each…", "I'll send you the link when it's ready", "For the hormonal piece, I'd lean on her doctor's guidance and build her plan around that" — first-person future work FOR the member (or for a friend they asked about) is coaching, never narration. Two real members lost exactly these paragraphs (2026-09-01/02) — when the paragraph answers what the member just asked, keep it.
- greetings, tips, anything with a nanorhino link

"""
{text}
"""`;
// Returns { filter, failed }: `failed` is true ONLY when an attempted classify
// call threw (timeout / network / SDK error) — the deliver path turns that
// into fail-closed. Config-level unavailability (no key, no SDK) returns
// filter:false, failed:false — deliberate fail-open on both paths.
async function _classifyParagraphEx(text, filterCfg, stats, tmoMs) {
  const cacheKey = text.trim().slice(0, 200);
  if (_replyFilterCache.has(cacheKey)) {
    if (stats) stats.ch++;
    return { filter: _replyFilterCache.get(cacheKey), failed: false };
  }
  const _t1 = Date.now();
  if (stats) stats.lc++;
  const _tmo = Math.max(300, Number(tmoMs) || _CLASSIFY_TIMEOUT_MS);
  try {
    const prompt = _FILTER_PROMPT.replace("{text}", text.slice(0, 500));
    let answer;
    if ((filterCfg.provider ?? "bedrock") === "openai") {
      // OpenAI classifier (gpt-5.5, reasoning_effort "none" → 0 reasoning
      // tokens = fast, like a non-reasoning model). Anthropic org was
      // disabled 2026-06-26; this is the live classifier path.
      const model = filterCfg.model ?? "gpt-5.5";
      const effort = filterCfg.effort ?? filterCfg.reasoningEffort ?? "none";
      let apiKey = filterCfg.apiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) return { filter: false, failed: false };
      const _body = {
        model,
        max_completion_tokens: 16,
        messages: [{ role: "user", content: prompt }],
      };
      if (effort) _body.reasoning_effort = effort;
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
        body: JSON.stringify(_body),
        signal: AbortSignal.timeout(_tmo),
      });
      const result = await resp.json();
      const _raw = result?.choices?.[0]?.message?.content?.trim()?.toLowerCase() ?? "";
      answer = _raw.includes("true") ? "true" : _raw.includes("false") ? "false" : _raw;
    } else if ((filterCfg.provider ?? "bedrock") === "bedrock") {
      const model = filterCfg.model ?? "anthropic.claude-haiku-4-5-20250620-v1:0";
      const region = filterCfg.region ?? "us-east-1";
      const sdkPath = _resolveBedrockSdkPath();
      if (!sdkPath) return { filter: false, failed: false };
      let _brMod;
      try {
        _brMod = require(sdkPath);
      } catch {
        try {
          const { createRequire: _cr2 } = await import("node:module");
          _brMod = _cr2(import.meta.url)(sdkPath);
        } catch (e2) {
          console.error(
            "[reply-filter] ERROR: cannot load bedrock SDK at " + sdkPath + ":",
            e2?.message?.slice(0, 80),
          );
          return { filter: false, failed: false };
        }
      }
      const { BedrockRuntimeClient, InvokeModelCommand } = _brMod;
      // Rebuild the client if the configured region changed (cfg hot-reloads).
      if (!_replyFilterCache._brClient || _replyFilterCache._brRegion !== region) {
        _replyFilterCache._brClient = new BedrockRuntimeClient({ region });
        _replyFilterCache._brRegion = region;
      }
      const cmd = new InvokeModelCommand({
        modelId: model,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: 4,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const res = await _replyFilterCache._brClient.send(cmd, {
        abortSignal: AbortSignal.timeout(_tmo),
      });
      const body = JSON.parse(new TextDecoder().decode(res.body));
      answer = body?.content?.[0]?.text?.trim()?.toLowerCase();
    } else {
      const model = filterCfg.model ?? "claude-haiku-4-5";
      let apiKey = filterCfg.apiKey;
      if (!apiKey) {
        const home = process.env.HOME ?? "/root";
        const authPath = home + "/.openclaw/agents/main/agent/auth-profiles.json";
        const authData = JSON.parse(_replyFilterFs.readFileSync(authPath, "utf-8"));
        apiKey = authData?.profiles?.["anthropic:default"]?.key;
      }
      if (!apiKey) return { filter: false, failed: false };
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 4,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(_tmo),
      });
      const result = await resp.json();
      answer = result?.content?.[0]?.text?.trim()?.toLowerCase();
    }
    // v11: startsWith, not strict equality — Bedrock Haiku may append prose
    // after the verdict within the 4-token cap ("true\n\nThis is").
    const shouldFilter = ((answer ?? "") + "").trim().toLowerCase().startsWith("true");
    if (_replyFilterCache.size > 200) {
      const brClient = _replyFilterCache._brClient;
      const brRegion = _replyFilterCache._brRegion;
      _replyFilterCache.clear();
      if (brClient) {
        _replyFilterCache._brClient = brClient;
        _replyFilterCache._brRegion = brRegion;
      }
    }
    _replyFilterCache.set(cacheKey, shouldFilter);
    if (stats) stats.cms = Math.max(stats.cms, Date.now() - _t1);
    return { filter: shouldFilter, failed: false };
  } catch (e) {
    if (stats) {
      stats.cms = Math.max(stats.cms, Date.now() - _t1);
      if (e?.name === "TimeoutError") stats.to++;
    }
    console.error("[reply-filter] LLM classify error:", e?.name, e?.message?.slice(0, 120));
    return { filter: false, failed: true };
  }
}
// Bool-returning wrapper (warmup ping + any legacy caller); dispatch timeout.
async function _classifyParagraph(text, filterCfg, stats) {
  const r = await _classifyParagraphEx(
    text,
    filterCfg,
    stats,
    Number(filterCfg?.classifyTimeoutMs) || _CLASSIFY_TIMEOUT_MS,
  );
  return r.filter;
}
// ── R4 fast-accept: meal-confirmation template (no API call) ──
// The meal-logging skill's confirmation is machine-shaped and always
// user-facing: first line `📝 <Meal> logged!`, a `🍽 This meal:` macro line,
// then totals + short coaching. Verified against live replies 2026-07-10.
// Matching messages skip ONLY the LLM phase (~1.4s median per reply — R4 of
// the meal-latency investigation); the Phase-1 regex reject and the
// NO_REPLY/narration line-stripping above still run. Template drift simply
// stops matching and falls back to full classification (fail-safe).
// Disable via reply-filter.json { "fastAcceptMealConfirm": false }.
const _MEAL_CONFIRM_HEAD = /^📝[^\n]{0,120}logged/iu;
function _isMealConfirmFastAccept(text) {
  const t = (text ?? "").trim();
  if (t.length === 0 || t.length > 1600) return false;
  if (!_MEAL_CONFIRM_HEAD.test(t)) return false;
  if (!t.includes("🍽")) return false;
  return true;
}
// ── v8 suspicion gate: only suspicious paragraphs pay the LLM classify ──
// Two-sided: a paragraph skips the LLM phase only if it BOTH carries a
// user-facing signal (second person, question/exclamation, emoji, nutrition
// vocabulary, bullet food lines) AND carries no internal marker. Everything
// else — including text with no recognizable signal at all — still goes to the
// classifier. Validated offline on 48h of prod traffic (2,081 delivered
// paragraphs: 92% skip; 380 never-delivered internal paragraphs: every true
// thinking-process paragraph carries a marker). Kill switch:
// reply-filter.json {"suspicionGate": false} → v7 behavior (classify all).
const _RF_HARD_MARK = new RegExp(
  [
    '^\\s*[\\[{]["\\w]', // JSON blob
    "^#{1,4} ",
    "```",
    "<!--",
    "\\[\\[", // md/html/directive artifacts
    "\\b(?:data\\/|scripts\\/|\\.jsonl?\\b|\\.md\\b|\\.py\\b|\\.sh\\b|baseDir|workspaceDir)",
    "\\bthe script\\b",
    "\\bNO_REPLY\\b",
    "\\b(?:(?:the|this|that) user|handoff user|she has|he has)\\b",
    "\\b(?:Tier \\d|degrade|nudgeIndex|recall_topics|day_summary|hint_count|suggestion_type|short-term|medium-term|long-term|meal_checkin|SKILL\\.md|PLAN\\.md|USER\\.md|cron|meal card)\\b",
    "\\b(?:consolidat|rotat|compos|verbatim|sentinel|payload|classif)\\w*",
    "\\bmark(?:ing|ed)? (?:it |as |them )?sent\\b",
    "\\b(?:no cleanup needed|case-sensitiv\\w*|tasks? complete\\w*|restrictions? on file|no (?:notable )?restrictions)\\b",
    "\\bNow (?:update|set|mark|build|create|write|read|pull|delete|add|run|re-?run|execute|verify|check)\\b",
    "\\bLet me (?!know\\b)",
    "\\b(?:I need to|I should(?:n'?t)?|Now I|Now let)\\b",
    "\\b(?:no intervention needed|pending recalc|goal[- ]weight ask|goal ask|re-?deriv)\\w*",
    // v16: pipeline step tokens / report internals are never user-facing
    "\\bStep \\d+[ab]\\b",
    "\\bskip \\d+[ab]\\b",
    "\\b(?:intake[- ]signal|weight[- ]lead|no-weight (?:report|path|step)|weight-present path)\\b",
    "\\bGate says no\\b",
    // generic snake_case (unbackticked internal vars like "Cal_safe is false");
    // on_track is whitelisted — it appears in the day-summary template itself.
    "\\b(?!on_track\\b)[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\\b",
  ].join("|"),
  "im",
);
const _RF_CLEAN_SIG =
  /\byou\b|\byour\b|[?？!！]|[\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F000}-\u{1FAFF}]|(?:你|蛋白|早餐|午餐|晚餐|加餐|体重|打卡|目标)|\b(?:kcal|cal(?:orie)?s?|protein|carbs?|fat|fiber|meals?|lunch|dinner|breakfast|snack|weigh(?:-?ins?|t)?|lbs?|kg|oz|water|log(?:ged|ging)?|goals?|targets?|streak|deficit|macros?)\b|^[ \t]*[·•-] /imu;
// ── v12 medical-referral / seek-care signal (a user-facing CLEAN SIGNAL) ──
// A see-a-doctor / go-to-the-ER referral is safety guidance the coach owes the
// member; it must never be silently dropped (agent 050304, 2026-07-17 — killed
// because the paragraph had no you/your/emoji/nutrition-vocab clean signal and
// the classifier misread it as meta). Treated with the SAME status as nutrition
// vocab: it makes a paragraph skip the classifier ONLY when the paragraph also
// carries no internal hard mark (the gate still AND-s in !_RF_HARD_MARK, so
// "the user should see a doctor" narration is unaffected). Deliberately narrow —
// a bare "doctor" does NOT qualify; the trigger is an explicit referral phrase.
const _RF_MED_PROVIDER =
  "(?:doctor|physician|provider|specialist|clinician|dentist|surgeon|GP|medical professional|health-?care (?:provider|professional))";
const _RF_MEDICAL_REFERRAL = new RegExp(
  [
    "\\b" + _RF_MED_PROVIDER + "'?s? (?:visit|appointment|office)\\b", // "an actual doctor visit"
    "\\b(?:see(?:ing)?|call(?:ing)?|contact(?:ing)?|consult(?:ing)?|visit(?:ing)?) (?:a|an|your|the) " +
      _RF_MED_PROVIDER +
      "\\b",
    "\\b(?:talk(?:ing)?|speak(?:ing)?|reach(?:ing)? out) (?:to|with) (?:a|an|your|the) " +
      _RF_MED_PROVIDER +
      "\\b",
    "\\b(?:ask(?:ing)?|check(?:ing)? with) (?:a|an|your|the) " + _RF_MED_PROVIDER + "\\b",
    "\\bmedical (?:attention|advice|care|help|evaluation|treatment)\\b",
    "\\bseek(?:ing)? (?:medical )?(?:care|help|attention|treatment)\\b",
    "\\burgent care\\b",
    "\\bemergency room\\b",
    "\\b(?:go|get|head|rush|take (?:you|them|him|her)) (?:to )?(?:the )?ER\\b", // action verb guards the case-insensitive \bER\b
    "\\b911\\b",
    "\\bget (?:it |that |this |them )?(?:checked out|checked by|looked at|evaluated)\\b",
    "\\bworth (?:a |an )?(?:checkup|check-?up|getting (?:it |that |this )?(?:checked|looked at))\\b",
  ].join("|"),
  "i",
);
// ── v15 billing / money-talk signal (a user-facing CLEAN SIGNAL) ──
// Results billing (pilot 2026-08) makes money talk part of the coach's voice:
// activation notices, settlement lines, receipts, pay links. A silently
// dropped bill or billing term is a trust/consent failure, so explicit money
// language skips the classifier — ONLY when the paragraph also carries no
// internal hard mark (same AND as v12; billing narration with snake_case /
// "Now mark…" still filters). Narrow by design: a bare "pay"/"charge" does
// NOT qualify; triggers are dollar amounts, the never-bills-twice promise,
// billing vocab, and first-party pay/pricing URLs.
const _RF_BILLING = new RegExp(
  [
    "\\$\\s?\\d", // $10/lb, $68, $500 — any dollar figure
    "\\bnever bills? twice\\b",
    "\\bbill(?:ing|ed)\\b",
    "\\binvoice\\b",
    "\\bnanorhino\\.com\\/(?:pay|pricing)\\b",
    "(?:计费|账单|免单|封顶|不二收)",
  ].join("|"),
  "iu",
);
// v19: member-addressed service notice opening like narration ("The issue has
// been fully resolved …") — see changelog. Narrow on purpose: opener limited to
// issue/problem/error, requires you/your, and no hard internal marker.
function _rfMemberNoticeOpener(p) {
  return (
    /^The (?:issue|problem|error)\b/i.test(p) &&
    /\byou\b|\byour\b/i.test(p) &&
    !_RF_HARD_MARK.test(p)
  );
}
// v19: bare salutation / team sign-off lines of a notice — user-facing frames
// that carry no clean signal of their own. Skip the classifier.
const _RF_NOTICE_FRAME =
  /^(?:Dear|Hi|Hello|Hey)\b[^\n]{0,60}[,，:]?$|^[—–-]\s*(?:The )?NanoRhino(?: Team)?[.!]?$/i;
function _rfGateSkipLLM(p) {
  return (
    (_RF_CLEAN_SIG.test(p) ||
      _RF_MEDICAL_REFERRAL.test(p) ||
      _RF_BILLING.test(p) ||
      _RF_NOTICE_FRAME.test(p)) &&
    !_RF_HARD_MARK.test(p)
  );
}
// ── v8 decision telemetry (fire-and-forget JSONL) ──
// One line per filtered reply → ~/.openclaw/logs/reply-filter-decisions.jsonl.
// This is the accuracy feedback loop: killed-paragraph previews for weekly FP
// review, classify latency/timeout distribution for timeout tuning, gate-skip
// counts for speed accounting. ~1.3k lines/day ≈ 500 KB/day. Disable via
// reply-filter.json {"decisionLog": false}. Summarize with
// scripts/reply-filter-report.mjs.
let _rfLogDirReady = false;
function _rfLogDecision(rec) {
  try {
    const cfg = _replyFilterCfg;
    if (cfg && cfg.decisionLog === false) return;
    const dir = (process.env.HOME ?? "/root") + "/.openclaw/logs";
    if (!_rfLogDirReady) {
      try {
        _replyFilterFs.mkdirSync(dir, { recursive: true });
      } catch {}
      _rfLogDirReady = true;
    }
    _replyFilterFs.appendFile(
      dir + "/reply-filter-decisions.jsonl",
      JSON.stringify(rec) + "\n",
      () => {},
    );
  } catch {}
}
// ── v8 classifier warmup: pay the cold TLS/SigV4/inference tax off-path ──
// The first classify after a gateway restart runs 1-2s slower (cold Bedrock
// client). Fire one throwaway classify on the first enabled filter call so the
// cold tax never lands on a real user's suspicious paragraph.
let _rfWarmupFired = false;
function _rfFireWarmup(filterCfg) {
  if (_rfWarmupFired || filterCfg.llm === false) return;
  _rfWarmupFired = true;
  const _t = Date.now();
  try {
    Promise.resolve(_classifyParagraph("__rf_warmup_ping__", filterCfg))
      .then(() =>
        _rfLogDecision({
          t: new Date().toISOString(),
          v: _REPLY_FILTER_HEADER_VERSION,
          warmup: true,
          ms: Date.now() - _t,
        }),
      )
      .catch(() => {});
  } catch {}
}
// Whole-message fail-closed suppressions are worth an operator ping: the user
// expected a (cron) message and got nothing. Fire-and-forget to the local
// alert proxy — same pattern as the monitoring scripts.
function _rfAlertFailClosed(agentId, n) {
  try {
    fetch("http://127.0.0.1:9876/wecom-alert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: "reply-filter",
        jobName: "reply-filter fail-closed",
        message:
          "deliver-path reply suppressed fail-closed: agent " +
          agentId +
          ", " +
          n +
          " paragraph(s) unclassifiable after retry",
      }),
    }).catch(() => {});
  } catch {}
}
// ── Main filter logic ──
// opts.path: "deliver" (Path 2 — cron/announce/message-tool; fail-closed on
// classify failure, longer timeout) | anything else = interactive dispatch
// semantics (fail-open). The deliver chokepoint passes the hint; the dispatch
// chokepoints stay 3-arg on purpose.
async function _filterReplyText(text, cfg, sessionKey, opts) {
  const _t0 = Date.now();
  const _rfPath = opts && opts.path === "deliver" ? "deliver" : "dispatch";
  // Strip non-NanoRhino URLs on EVERY reply — before the enabled/exclude
  // early-returns — so no off-brand link can ever reach a user.
  if (text) text = _stripNonBrandUrls(text);
  const filterCfg = _loadReplyFilterCfg();
  if (!filterCfg?.enabled) return { drop: false, text };
  const agentId = sessionKey?.split(":")?.[1] ?? "main";
  const list = filterCfg.exclude ?? filterCfg.include ?? [];
  if (filterCfg.mode === "exclude" && list.includes(agentId)) return { drop: false, text };
  if (filterCfg.mode === "include" && !list.includes(agentId)) return { drop: false, text };
  _rfFireWarmup(filterCfg);
  if (!text) return { drop: false, text };
  const stats = {
    t: new Date().toISOString(),
    v: _REPLY_FILTER_HEADER_VERSION,
    a: agentId,
    path: _rfPath,
    in: text.length,
    n: 0,
    rk: 0,
    ls: 0,
    dt: 0,
    st: 0,
    fa: 0,
    gs: 0,
    lc: 0,
    ch: 0,
    lk: 0,
    to: 0,
    rt: 0,
    fc: 0,
    cms: 0,
    k: [],
  };
  const _done = (drop, outText) => {
    stats.drop = drop ? 1 : 0;
    stats.out = outText?.length ?? 0;
    stats.tms = Date.now() - _t0;
    if (stats.k.length > 6) stats.k = stats.k.slice(0, 6);
    _rfLogDecision(stats);
    return { drop, text: outText };
  };
  // Leaked [[directive]] routing tokens: strip the token, keep the line.
  if (text.includes("[[")) {
    const _pre = text;
    text = text
      .replace(_DIRECTIVE_TOKEN_G, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (text !== _pre) stats.dt = 1;
    if (!text) return _done(true, "");
  }
  // v20: macro-line token leak ("Protein 42g (no token)") — strip the
  // token, keep the line; see changelog.
  if (/\((?:no token|none|null|undefined)\)/i.test(text)) {
    const _hits = text.match(_INTERNAL_TOKEN_G) || [];
    if (_hits.length) {
      const _at = text.search(_INTERNAL_TOKEN_G);
      stats.st = _hits.length;
      stats.k.push({
        y: "strip",
        p: text.slice(Math.max(0, _at - 30), _at + 40).replace(/\n/g, " "),
      });
      text = text.replace(_INTERNAL_TOKEN_G, "$1");
    }
  }
  // Line-level NO_REPLY + self-narration stripping (runs before paragraph
  // splitting so a `**NO_REPLY**` / "Let me finalize:" / "Stage 1, SEND" line
  // embedded in an otherwise-good body is removed, not just an exact-match
  // whole message). After stripping, if nothing meaningful remains → suppress,
  // matching the existing whole-message NO_REPLY behavior.
  if (_NO_REPLY_LINE.test(text) || _NARRATION_LINE.test(text)) {
    const _linesBefore = text.split("\n").length;
    const stripped = _stripNarrationLines(text);
    stats.ls = Math.max(0, _linesBefore - stripped.split("\n").length);
    if (stripped.length === 0) return _done(true, "");
    text = stripped;
  }
  if (text.trim().length < 10) return _done(false, text);
  // Phase 1: fast regex reject per paragraph, then drop exact-duplicate
  // paragraphs (cron double-emit of the same reminder text).
  const paragraphs = text.split(/\n\n+/);
  stats.n = paragraphs.length;
  // First-party URL paragraphs (report/plan/CTA links) are exempt from BOTH
  // phases — keep them verbatim regardless of regex/LLM verdict.
  const afterRegex = _dedupParagraphs(
    paragraphs.filter((p) => {
      if (_isUserFacingUrlPara(p)) return true;
      if (_fastReject(p.trim())) {
        stats.rk++;
        stats.k.push({ y: "rx", p: p.trim().slice(0, 90) });
        return false;
      }
      return true;
    }),
  );
  if (afterRegex.length === 0) return _done(true, "");
  // R4 fast-accept: meal confirmations skip the LLM phase (Phase 1 already ran).
  if (filterCfg.fastAcceptMealConfirm !== false && _isMealConfirmFastAccept(text)) {
    stats.fa = 1;
    return _done(false, afterRegex.join("\n\n"));
  }
  // Phase 2: LLM classification — v8: only paragraphs that fail the suspicion
  // gate are classified; clean coach copy is delivered without the API call.
  if (filterCfg.llm !== false) {
    const _tmo =
      _rfPath === "deliver"
        ? Math.max(300, Number(filterCfg.classifyTimeoutMsDeliver) || _CLASSIFY_TIMEOUT_MS_DELIVER)
        : Math.max(300, Number(filterCfg.classifyTimeoutMs) || _CLASSIFY_TIMEOUT_MS);
    const results = await Promise.all(
      afterRegex.map(async (p) => {
        if (_isUserFacingUrlPara(p)) return p;
        if (filterCfg.suspicionGate !== false && _rfGateSkipLLM(p)) {
          stats.gs++;
          return p;
        }
        const _pt = p.trim();
        let _cr = await _classifyParagraphEx(_pt, filterCfg, stats, _tmo);
        if (_cr.failed) {
          // v9 fail-closed (deliver): the cron path is latency-insensitive and
          // is the historical leak source — retry once, then suppress the
          // paragraph rather than deliver unjudged suspicious text.
          // v10 extends the retry to the dispatch path too; after a failed
          // retry, dispatch suppresses ONLY paragraphs carrying a hard internal
          // marker (3 of the 2026-07-15 Issue-3 leaks were gate-flagged
          // narration whose classify timed out and fail-open delivered them).
          // Unmarked/no-signal paragraphs keep fail-open — never hold a plain
          // user reply hostage to filter infra.
          stats.rt++;
          _cr = await _classifyParagraphEx(_pt, filterCfg, stats, _tmo);
          if (_cr.failed) {
            if (_rfPath === "deliver") {
              stats.fc++;
              stats.k.push({ y: "fc", p: _pt.slice(0, 90) });
              return null;
            }
            if (_RF_HARD_MARK.test(p)) {
              stats.fc++;
              stats.k.push({ y: "fcd", p: _pt.slice(0, 90) });
              return null;
            }
          }
        }
        if (_cr.filter) {
          stats.lk++;
          stats.k.push({ y: "llm", p: _pt.slice(0, 90) });
          return null;
        }
        return p;
      }),
    );
    const kept = results.filter((p) => p !== null);
    if (kept.length === 0) {
      if (stats.fc > 0) _rfAlertFailClosed(agentId, stats.fc);
      return _done(true, "");
    }
    return _done(false, kept.join("\n\n"));
  }
  return _done(false, afterRegex.join("\n\n"));
}

// ── Source-native port (2026-07-30) ─────────────────────────────────────────
// This file is a verbatim vendor of openclaw-infra
// patches/002-reply-filter-v5/filter-v5-header.js (header v13), which until
// now was INJECTED into built dist chunks by apply.py on every deploy — and
// twice a dist swap shipped without re-applying it (009-class $400 cache burn
// 07-24..27 sibling incident; filter-down 07-24). Vendored into source, the
// filter ships inside the build itself and apply.py 002 becomes a no-op on
// fork dists (it probes for the marker string below).
// Keep edits FLOWING THROUGH THE PATCH FILE first (it remains the rollback
// insurance for non-fork dists), then re-vendor: the two files must stay
// byte-identical above this block.
const _REPLY_FILTER_SOURCE_NATIVE_MARKER = "[patch:002-reply-filter-source-native]";
// Anchored via a live globalThis assignment so bundlers cannot tree-shake the
// string out of the built dist — openclaw-infra's apply.py greps dist/*.js for
// the literal to know injection is unnecessary (a bare exported const was
// dropped by rollup, 2026-07-30). Also handy at runtime for verifying which
// filter build is live.
globalThis.__OPENCLAW_REPLY_FILTER_SOURCE_NATIVE = _REPLY_FILTER_SOURCE_NATIVE_MARKER;
export { _filterReplyText, _REPLY_FILTER_SOURCE_NATIVE_MARKER };
