let _replyFilterCfg = null;
let _replyFilterCfgMtime = 0;
// Bumped when the header body changes so apply.py can refresh an already-
// injected older header in place (see refresh_header in apply.py).
const _REPLY_FILTER_HEADER_VERSION = 38;
// v38 (2026-09-23, openclaw-infra#300 5th reopen): a card row that SUMS several
// itemized record rows (060329's "Egg omelette (2 eggs, spinach, tomato, onion,
// butter) — 174g — 261 kcal" over five component rows) covers all of them: the
// row is judged against their sum and coverage is counted in record rows, so
// the coach's correct 821 is no longer "reconciled" down to 703 and the row to
// the single egg component (100 g / 143). See _rfCoverRow.
// v34 (2026-09-18, openclaw-infra#313 reopen): 050306 got "Correction — …
// Send it again" twice for "✓ Already got those leftovers logged — you're at
// 1383/1892 kcal" — a TRUE sentence: the record landed 25 s earlier, in the
// previous turn, so this turn's inbound window could not see the write, and
// v32's narrowed recap rule ("already" next to the verb) no longer read
// "already got those leftovers logged" as a recap. A recap-shaped claim
// (already / got it / counted) is about the record's STATE, not this turn's
// write: a member data write inside the last 30 min backs it (decision
// {y:"claim-recap-recent"}, stats.pr). And the canary now looks 15 s PAST
// the correction (persistClaimCanaryLateMs): 050025 09-17 wrote the lunch
// 6.4 s after the correction shipped — a premature correction the old
// [inbound, corrected+2s] window called "ok".
// v33 (2026-09-18, openclaw-infra#347): 060390 got "... and do tool calls in
// the think block? No, tool calls happen outside the think/final structure."
// as its own SMS — the seventh paragraph of a 990-char format deliberation
// whose other six were killed; it carried a "?" and no hard mark, so the
// suspicion gate skipped the classifier. Two belts: hard marks for the
// model's output-format vocabulary (think block / think-final / tool calls /
// final structure / <final> / "I'll do:" / system prompt / "the skill says";
// 40-day corpus: each hits only that message), and a kept paragraph that
// opens as the continuation of a killed one ("... and …") is dropped with it
// ({y:"tail"}, stats.tl, journal "dropped the tail of a killed paragraph").
// v32 (2026-09-17, openclaw-infra#331 reopen, Jason): (a) the resend copy is
// capped at THREE — persistClaimLoopN defaults to 3, so the fourth refuted
// claim inside 30 min is the loop copy; (b) "already" is a recap only when it
// sits next to the claim verb ("is already logged", "already have that
// logged", "already in your log"). "Yep, already got it — 4 magnesium chews
// logged for tonight" (050313 04:21:16Z, answering "did you log it?") is a
// fresh claim and is judged like any other: refuted → corrected.
// v31 (2026-09-17, openclaw-infra#331): persist-claim LOOP breaker. 050313
// answered the nightly supplement ask and got "Correction — … Send it again"
// four times in five minutes (04:16–04:21Z): the coach never called a write
// tool, so every resend was refuted again and the copy kept asking for the
// one action that could not succeed. The user had to break the loop himself
// ("You're repeating yourself"). From v31 the refuted path remembers its own
// corrections per agent (globalThis.__nrClaimCorrections, 30-min window):
// from the third one on the copy no longer asks for a resend ("resending
// won't fix it … no need to send it again"), the decision is {y:"claim-loop"}
// / stats.pl, the journal says "persist-claim LOOP", and the first loop hit
// posts a (non-critical) wecom alert so a human looks at why the write is
// missing (this time: the answer had no storage — fixed with a standing
// item). {"persistClaimLoopBreak":false} disables; persistClaimLoopN (default
// 2) is how many corrections must precede the loop copy.
// v25 (2026-09-14, openclaw-infra#272 reopen + #250 reopen):
// (a) "Got it — logging the same plate for dinner too. Just to confirm: full
//     second serving or smaller?" (050311 09-13): the engine ASKED and wrote
//     nothing, the sentence says the write is happening. Present-progressive
//     claims at the head of a sentence now count as claims; and on a turn
//     whose meal_checkin outcome was `ask`, the claim verbs are rewritten to
//     intent ("I'll log …") instead of the "Correction — send it again" line —
//     the user should answer the question, not resend. {y:"claim-ask"}.
// (b) 050184 got alcohol tips/nudges three times in eight days while
//     health-preferences.md said "Does not drink alcohol" (twice), the third
//     time answered "I DON'T DRINK". The deliver path (cron nudges, announce)
//     now drops a paragraph about alcohol when the workspace preference files
//     say the member does not drink, and a paragraph about the scale when the
//     files say recovery mode / zero scale pressure / avoid_weight_focus.
//     Dispatch (interactive) replies are untouched — a member asking about wine
//     gets an answer. {y:"pref"}, stats.pf; cached per agent for 10 min.
// v24 (2026-09-13, openclaw-infra#286): card reconciliation. The engine returns
// the rendered meal (render.meals[]: slot, per-row grams/kcal, meal total) and
// the coach composes the ①/② template from it — and sometimes from its own
// head instead: 050306 got "📝 Snack logged!" with popcorn at 300 kcal while
// the record it had just written said dinner / 316 (the day total on the same
// card was right). meal-tracker-v2 now publishes that render in the turn
// state; on the dispatch path a single-meal card whose title slot, row kcal /
// grams or "🍽 This meal:" total disagree with the record is rewritten to the
// record's numbers, in place, line by line — nothing is dropped, the tail
// coaching stays. Decision log: stats.cc + {y:"card"}; journal
// "[reply-filter] card reconciled".
// v23 (2026-09-13, openclaw-infra#237 reopen): v22's gate corrected a REAL card
// (060341 12:37Z, "Correction — … Send it again" on top of two rows that were
// in the file) because the turn state it read was empty — meal-tracker-v2
// keyed the turn start off the user message's session write, and this
// runtime persists that message together with the tool calls at the END of
// the turn, wiping the recorded meal_checkin. Three fixes: (1) the plugin now
// opens the turn at before_prompt_build (before the model, before any tool);
// (2) the gate has a hook-order-independent belt — any data file under the
// agent workspace (data/meals, weight.json, exercise.json, habits.json,
// streak.json) modified since the turn started counts as backing; (3) the
// negation regex missed contractions ("I don't see eggs logged today" was
// read as a claim) — any *n't now negates. The gate stays behind
// {"persistClaimGate": false} until v23 is verified live.
// v22 (2026-09-12, openclaw-infra#272): persist-claim gate. 050313 got "Got it —
// logged 4 magnesium chews…" three nights out of six with ZERO bytes written:
// twice the model never called meal_checkin, once it did and the engine
// returned action:none while the coach still said "logged". No plugin hook can
// transform the delivered text, so the reply filter is the delivery-side
// chokepoint: meal-tracker-v2 publishes what the current turn actually did
// (globalThis.__nrTurnState[agentId] = {userAt, tools[], checkins[]} — user
// message opens the turn, every tool call is recorded, meal_checkin with its
// outcome) and on the DISPATCH path a sentence that claims "logged / saved /
// recorded / 记录好了" is removed when nothing in the turn backs it, replaced by
// an explicit correction ("Correction — that didn't actually get saved on my
// end. Send it again and I'll log it properly."). Conservative on purpose: any
// exec/bash call (weight, exercise, reminder scripts write outside the engine)
// or any non-none meal_checkin outcome (log/edit/confirm/query) counts as
// backing; negated ("haven't logged"), recap ("already logged from earlier") and
// modal ("I'll log it once…") sentences are never touched; no turn state (plugin
// absent, cron turn, stale > 15 min) → no correction. Decision log: stats.pc +
// {y:"claim"}; journal line "[reply-filter] persist-claim corrected".
// v21 (2026-09-12, openclaw-infra#186 4th reopen): the classifier's verdict on
// an UNMARKED paragraph of an interactive (dispatch) reply is now advisory.
// Decisions log, full history (228 classifier kills): since v16 (2026-08-15)
// the dispatch path recorded 20 classifier kills and every one was a member-
// facing sentence with no internal marker — "Got it — 5 days a week it is…",
// "For the hormonal piece…", "Fixed — that was the same session…", "That
// makes sense…", "Got it — no beets…". The only true kills in that window
// carried a hard mark (step/state narration) or belong to two shapes the
// marker list missed ("Just a thumbs-up reaction … no reply needed",
// "Validation error: …") — those shapes are hard marks now. Three belts:
//   (1) new hard marks (deterministic): "Validation error:", reaction notes
//       ("thumbs-up reaction …"), "state update(s)", "proactive slot",
//       "I have everything I need", "content type", "via the (system) script";
//       and the `rotat*` marker is narrowed to session/memory/log rotation
//       (it was killing "Rotate 2–3 of these through the week" coaching).
//   (2) member-directed conversational openers ("Got it —", "Fixed —",
//       "Noted", "Yes,", "Here's", "No need to reply", …) skip the classifier
//       when the paragraph carries no hard mark (_RF_CONVO_OPENER).
//   (3) dispatch path: a classifier "true" on a paragraph with no hard mark is
//       logged ({y:"llm-veto"}, stats.lv) but NOT applied. The deliver path
//       (cron/announce — the historical leak source, fail-closed) is unchanged.
//       Kill switch: reply-filter.json {"classifierAdvisoryOnDispatch": false}.
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
// (patch 016 + messages.suppressToolErrors=true + fork 021b5b257f3); this
// rule is the deterministic second belt so no ⚠️-prefixed tool-failure echo
// of any shape ever reaches a user again, whatever path produces it.
// Corpus-validated 2026-08-01 against all 28,911 delivered messages: matches
// exactly the 13 known harness leaks, zero coach-authored hits; the 147
// other ⚠️-prefixed lines (error notices like "Something went wrong…", which
// carry no "failed") are untouched.
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
  // ── v16 additions: report-pipeline step narration (2026-08-16 W33 leak) ──
  // 13 users received "Now run Step 5a (intake signal), skip 5b…" as SMS:
  // final-tag discarded the no-<final> narration, patch-018 recovery
  // resurrected it, and the suspicion gate passed it (intake/weight read as
  // nutrition vocab → clean signal, no hard mark). Corpus-validated 0 FP over
  // 61,363 delivered paragraphs; the only non-W33 hits were three 2026-07-26
  // W30-night leaks of the same class ("The weight-lead.py output…") that had
  // gone unnoticed — i.e. the patterns also catch the class retroactively.
  if (/^Now (?:run|re-?run|execute)\b/i.test(p)) return true;
  if (/\b(?:run|re-?run|skip|need(?:ed)?|check) (?:Step )?\d+[ab]\b/i.test(p)) return true;
  if (/\bStep \d+[ab]\b/i.test(p)) return true;
  if (/\b(?:intake[- ]signal|weight[- ]lead)\b/i.test(p)) return true;
  if (/^Gate says no\b/i.test(p)) return true;
  if (/\b(?:no-weight (?:report|path|step)|weight-present path)\b/i.test(p)) return true;
  // ── v8 additions: task-status + pre-compose narration (2026-07 corpus) ──
  // "Both tasks complete." / "Well under limit, no cleanup needed." (memory crons)
  if (/^(?:Both|All) tasks? complete\b/i.test(p)) return true;
  if (/\bno cleanup needed\b/i.test(p)) return true;
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
    if (typeof globalThis.__rfClassifyOverride === "function") {
      // test-local.mjs hook: a synthetic verdict, no network (v21 tests).
      answer = String(await globalThis.__rfClassifyOverride(text));
    } else if ((filterCfg.provider ?? "bedrock") === "openai") {
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
// v33 (#347): a paragraph that OPENS as a continuation of the paragraph the
// filter just killed ("... and do tool calls in the think block? No, tool
// calls happen outside the think/final structure.") is the tail of that
// internal text — never a message of its own. 060390 2026-09-18: 990 chars
// of format deliberation, six paragraphs killed, the seventh (a "?"-bearing,
// unmarked fragment) skipped the classifier and shipped as its own SMS.
// `list` holds null for killed paragraphs; a kept paragraph whose left
// neighbour was killed and which opens with an ellipsis + conjunction is
// dropped too (chained, so a tail of a tail goes as well).
const _RF_KILLED_TAIL_RE =
  /^\s*(?:\.{3}|…)\s*(?:and|or|but|so|then|because|which|that|nor|also)\b/iu;
function _rfDropKilledTails(list, stats, agentId) {
  const out = [];
  let prevKilled = false;
  for (const p of list) {
    if (p === null || p === undefined) {
      prevKilled = true;
      continue;
    }
    if (prevKilled && _RF_KILLED_TAIL_RE.test(p)) {
      if (stats) {
        stats.tl = (stats.tl || 0) + 1;
        stats.k.push({ y: "tail", p: p.trim().slice(0, 90) });
      }
      try {
        console.log(
          "[reply-filter] dropped the tail of a killed paragraph agent=" +
            agentId +
            " text=" +
            JSON.stringify(p.trim().slice(0, 100)),
        );
      } catch {}
      prevKilled = true;
      continue;
    }
    prevKilled = false;
    out.push(p);
  }
  return out;
}
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
    "\\b(?:consolidat|compos|verbatim|sentinel|payload|classif)\\w*",
    // v21: rotation only as an internal noun — "Rotate 2–3 of these through the
    // week" is coaching copy and was hard-marked (then classifier-killed).
    "\\b(?:session|memory|log|file|transcript) rotat\\w*",
    "\\brotat\\w* (?:the |this )?(?:session|memory|log|file|transcript)s?\\b",
    "\\bmark(?:ing|ed)? (?:it |as |them )?sent\\b",
    // v21: unmarked true kills seen in the decisions log — never member copy.
    "\\bValidation error:",
    // ("no reply needed" itself is NOT a mark: coach sign-offs say it — corpus 2026-09-12: 7 delivered lines.)
    "\\b(?:thumbs[- ]?up|like|loved?|heart) reaction\\b",
    "\\breaction to (?:my|the|your) (?:last|previous)\\b",
    "\\bstate updates?\\b",
    "\\bproactive slot\\b",
    "\\bI have everything I need\\b",
    "\\bcontent type\\b",
    "\\bvia the (?:system )?script\\b",
    "\\b(?:no cleanup needed|case-sensitiv\\w*|tasks? complete\\w*|restrictions? on file|no (?:notable )?restrictions)\\b",
    "\\bNow (?:update|set|mark|build|create|write|read|pull|delete|add|run|re-?run|execute|verify|check)\\b", // v16: +run/re-run/execute/verify/check (W33 step narration)
    "\\bLet me (?!know\\b)",
    "\\b(?:I need to|I should(?:n'?t)?(?!'ve\\b| have\\b)|Now I|Now let)\\b", // v21: "it's not something I should've implied" is member copy
    "\\b(?:no intervention needed|pending recalc|goal[- ]weight ask|goal ask|re-?deriv)\\w*",
    // v16 (W33 step-narration leak): pipeline step tokens + report internals are
    // never user-facing — closes the gs=1 hole where intake/weight vocabulary in
    // narration reads as a nutrition clean signal.
    "\\bStep \\d+[ab]\\b",
    "\\bskip \\d+[ab]\\b",
    "\\b(?:intake[- ]signal|weight[- ]lead|no-weight (?:report|path|step)|weight-present path)\\b",
    "\\bGate says no\\b",
    // v33 (#347, 060390 2026-09-18): "... and do tool calls in the think block?
    // No, tool calls happen outside the think/final structure." — the model
    // debating its own output format. It carried a "?" and no mark, so the
    // suspicion gate skipped the classifier and it shipped as its own SMS.
    // Corpus 2026-09-18 (40 d, 13,211 delivered bodies): each token hits only
    // that one message.
    "\\bthink block\\b",
    "\\bthink\\s*\\/\\s*final\\b",
    "\\bfinal (?:structure|message|block|tag)\\b",
    "<\\/?final>",
    "\\btool calls?\\b",
    "\\bI'?ll do:",
    "\\bsystem prompt\\b",
    "\\bthe (?:skill|format) says\\b",
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
// v21: member-directed conversational openers — acknowledgments, completed-
// action reports, answer leads. The classifier read these as narration when the
// sentence had no other clean signal ("Got it — 5 days a week it is. I'll build
// sessions…", "Fixed — that was the same session…", "Noted for next time too").
// Bare "Good —"/"That's"/"This is" are NOT openers here: they lead narration as
// often as replies. Any hard mark still sends the paragraph to the classifier.
const _RF_CONVO_OPENER = new RegExp(
  "^\\s*(?:" +
    [
      "Got it",
      "Fixed(?: it| that)?",
      "Done",
      "Noted",
      "Yes",
      "Yeah",
      "Yep",
      "Nope",
      "Sure",
      "Perfect",
      "Okay",
      "OK",
      "Oops",
      "Absolutely",
      "Of course",
      "Correct",
      "Exactly",
      "Totally",
      "Makes sense",
      "(?:Ah,? )?that makes sense",
      "Good (?:catch|question|call|point|to know|instinct|news|idea|choice|plan|move|thinking)",
      "Fair (?:question|point|enough)",
      "Great (?:question|call|point)",
      "Here(?:'s| is| are)",
      "Happy to",
      "Sounds good",
      "No worries",
      "No need to reply",
      "Quick (?:note|heads[- ]up)",
      "Heads[- ]up",
      "Thanks",
      "Thank you",
      "Updated",
      "Adding",
      "Removed",
      "Swapped",
      "Changed",
      "Short answer",
      "Long story short",
      "明白",
      "收到",
      "好的",
      "没问题",
      "已改",
      "已更新",
    ].join("|") +
    ")(?![A-Za-z0-9])",
  "iu",
);
function _rfGateSkipLLM(p) {
  return (
    (_RF_CLEAN_SIG.test(p) ||
      _RF_MEDICAL_REFERRAL.test(p) ||
      _RF_BILLING.test(p) ||
      _RF_NOTICE_FRAME.test(p) ||
      _RF_CONVO_OPENER.test(p)) &&
    !_RF_HARD_MARK.test(p)
  );
}
// ── v22 persist-claim gate (openclaw-infra#272) — see changelog ──
const _RF_CLAIM_RE =
  /\b(?:logged|saved|recorded|tracked|noted down|written down|added (?:it |that |them |those |this )?to (?:your|the) (?:log|diary|day|record|tally))\b|^\s*(?:(?:got it|ok(?:ay)?|alright|sure|noted|on it)\s*[—–\-:,，]?\s*)?(?:logging|saving|recording|adding)\b|(?:记录好了|已记录|记下了|已经记|记上了|已保存|已登记|已加(?:上|入)?)/iu;
// v25: on an `ask` turn the claim verbs become intent, sentence kept.
const _RF_CLAIM_VERB_RE = /\b(logging|logged|saving|saved|recording|recorded|adding|added)\b/giu;
const _RF_CLAIM_INTENT = {
  logging: "I'll log",
  logged: "I'll log",
  saving: "I'll save",
  saved: "I'll save",
  recording: "I'll record",
  recorded: "I'll record",
  adding: "I'll add",
  added: "I'll add",
};
const _RF_CLAIM_NEG_RE =
  /\b\w+n'?t\b|\b(?:not|never|no|nothing|without|un-?logged|unsaved|missing|don't see|doesn't show)\b|(?:没有?|未|不会|无法|尚未|还没)/iu;
// v29: "locked in / marked / counts as logged" describes the record's state
// (050269 2026-09-16: "Breakfast's locked in as logged." answering the
// coach's own clarification question) — a recap, never a fresh claim.
// v32: "already" recaps only next to the claim verb — "already got it — X
// logged for tonight" is a fresh claim (050313 04:21:16Z).
const _RF_CLAIM_RECAP_RE =
  /\b(?:earlier|yesterday|so far|this week|last week|previously|before|streak|total|history)\b|\balready\s+(?:\w+\s+){0,2}(?:logged|saved|recorded|tracked|in (?:your|the) (?:log|record|diary|day))\b|\b(?:logged|saved|recorded|tracked)\s+already\b|\b(?:locked in|marked|counts?|shows?|stays?|remains?|still|sits?|sitting|stands?) as (?:logged|saved|recorded|tracked)\b|(?:已经|之前|昨天|本周|上周|到目前|累计)/iu;
const _RF_CLAIM_MODAL_RE =
  /\b(?:will|'ll|would|can|could|should|shall|once|when|if|want me to|let me know|make sure)\b|(?:会|将|可以|要不要|如果|一旦)/iu;
const _RF_CLAIM_FRESH_MS = 15 * 60 * 1000;
const _RF_NON_PERSIST_TOOLS = new Set([
  "read",
  "ls",
  "glob",
  "grep",
  "web_search",
  "web_fetch",
  "memory_search",
  "memory_get",
  "meal_checkin",
]);
const _RF_NON_PERSIST_OUTCOMES = new Set(["none", "error", "ask"]);
// Mirror of meal-tracker-v2 lib/turn-state.js turnBacksPersistClaim — keep in sync.
function _rfTurnBacksClaim(state) {
  if (!state) return true;
  for (const t of state.tools || []) if (!_RF_NON_PERSIST_TOOLS.has(String(t))) return true;
  for (const c of state.checkins || []) {
    if (!_RF_NON_PERSIST_OUTCOMES.has(String(c && c.outcome))) return true;
    if (c && c.save === "ok") return true;
  }
  return false;
}
function _rfIsBareClaim(sentence) {
  return (
    _RF_CLAIM_RE.test(sentence) &&
    !_RF_CLAIM_NEG_RE.test(sentence) &&
    !_RF_CLAIM_RECAP_RE.test(sentence) &&
    !_RF_CLAIM_MODAL_RE.test(sentence)
  );
}
// v23: hook-order-independent belt — did any member data file change since the
// turn started? Workspace from cfg.agents.list (falls back to the SMS-line
// layout). Any read error → "yes, it wrote" (never correct on a blind spot).
const _RF_DATA_FILES = [
  "data/weight.json",
  "data/exercise.json",
  "data/habits.json",
  "data/streak.json",
  "data/engagement.json",
];
function _rfAgentWorkspace(cfg, agentId) {
  const home = process.env.HOME ?? "/root";
  const list = cfg && cfg.agents && Array.isArray(cfg.agents.list) ? cfg.agents.list : [];
  const ent = list.find((a) => a && a.id === agentId);
  if (ent && ent.workspace) return String(ent.workspace).replace(/^~(?=$|\/)/, home);
  return home + "/.openclaw/workspace-nutritionist/" + agentId;
}
// v29: the channel's own inbound stamp (twilio inbound-stamp.ts writes
// channel-source.json lastInboundAt, epoch ms, on every inbound) — ground
// truth for "when did this turn start" that no turn-state reset can move.
function _rfLastInboundMs(ws) {
  try {
    const cs = JSON.parse(_replyFilterFs.readFileSync(ws + "/channel-source.json", "utf-8"));
    const raw = cs && typeof cs === "object" ? cs.lastInboundAt : null;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw < 1e12 ? raw * 1000 : raw;
    if (typeof raw === "string") {
      const n = Date.parse(raw);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  } catch {
    return null;
  }
}
// Newest mtime among the member data files in [sinceMs-2s, untilMs+2s]; null
// when nothing in that window. untilMs=null → open-ended.
function _rfWorkspaceWriteIn(ws, sinceMs, untilMs) {
  const lo = sinceMs - 2000;
  const hi = untilMs == null ? Infinity : untilMs + 2000;
  let hit = null;
  const probe = (p) => {
    try {
      const m = _replyFilterFs.statSync(p).mtimeMs;
      if (m >= lo && m <= hi && (hit == null || m > hit)) hit = m;
    } catch {}
  };
  for (const rel of _RF_DATA_FILES) probe(ws + "/" + rel);
  const mealsDir = ws + "/data/meals";
  let names = [];
  try {
    names = _replyFilterFs.readdirSync(mealsDir);
  } catch {
    names = [];
  }
  for (const n of names) if (n.endsWith(".json")) probe(mealsDir + "/" + n);
  return hit;
}
// Did any member data file change since the turn started? `sinceMs` is the
// EARLIER of the turn state's userAt and the channel inbound stamp (v29), so
// a turn-state reset that moved userAt past the file's mtime (#304's shape)
// no longer blinds the belt. `blind` is the answer on a read surprise —
// true for the gate (never correct on a blind spot), false for the canary.
// v34: a recap-shaped claim is backed by ANY member data write in the last
// window (default 30 min) — the write it recaps happened in an earlier turn.
const _RF_CLAIM_RECAP_WINDOW_MS = 30 * 60 * 1000;
// ("Got it — logged …" is a FRESH claim opener, not a recap — only already / counted / still … qualify.)
const _RF_CLAIM_RECAP_WORD_RE =
  /\balready\b|\bcounted\b|\bstill (?:at|counted|logged|in)\b|(?:已经|已记)/iu;
function _rfWorkspaceRecentWriteMs(cfg, agentId, windowMs) {
  try {
    const ws = _rfAgentWorkspace(cfg, agentId);
    return _rfWorkspaceWriteIn(ws, Date.now() - windowMs, null);
  } catch {
    return Date.now(); // read surprise → treat as backed (never correct on a blind spot)
  }
}
function _rfWorkspaceWroteSince(cfg, agentId, sinceMs, blind = true) {
  try {
    const ws = _rfAgentWorkspace(cfg, agentId);
    const inbound = _rfLastInboundMs(ws);
    const since = inbound != null && inbound < sinceMs ? inbound : sinceMs;
    return _rfWorkspaceWriteIn(ws, since, null) != null;
  } catch {
    return blind;
  }
}
// v29 (2026-09-16, openclaw-infra#313): fail-open evidence classes. Three
// days of v22–v25 produced 11 corrections on 7 members and every one was
// false — the record was on disk, the turn state was empty (#237 hook
// order, #304 final-tag rebuild, and on 09-16 050269 a plain confirmation
// turn: "Yes" to the coach's own "did you mean walnut halves?" → zero tools,
// zero checkins, "Breakfast's locked in as logged." rewritten into "Send it
// again"). An empty turn state is ABSENCE of evidence, not evidence of
// absence. From v29 the gate sorts an unbacked claim into:
//   refuted  — meal_checkin RAN this turn and every outcome was none/error
//              (and the workspace agrees): the engine said no while the coach
//              said logged → the correction line, the only path that still
//              asserts "didn't get saved" (050313 09-07: action:none).
//   unbacked — nothing ran at all: no evidence either way → the text passes
//              untouched, decision {y:"claim-unbacked"} / stats.pu / journal
//              "persist-claim unbacked (passed)" keeps the class visible.
//              {"persistClaimUnbackedMode":"soften"} applies the v25 intent
//              rewrite ("I'll log …") instead — never the correction.
// Every correction schedules a CANARY (below): a member data file written
// between the inbound stamp and the correction = the correction was false →
// alert (critical → owner SMS via the alert proxy) + persistClaimGate flipped
// off in reply-filter.json. v22→first human notice took 32 h and 7 members.
const _RF_CLAIM_CANARY_MS = 60 * 1000;
function _rfAlert(payload) {
  try {
    fetch("http://127.0.0.1:9876/wecom-alert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch {}
}
function _rfDisablePersistClaimGate(reason) {
  try {
    if (!_replyFilterFs) return false;
    const cfgPath = (process.env.HOME ?? "/root") + "/.openclaw/reply-filter.json";
    let cur = {};
    try {
      cur = JSON.parse(_replyFilterFs.readFileSync(cfgPath, "utf-8")) || {};
    } catch {
      cur = {};
    }
    if (cur.persistClaimGate === false) return true;
    cur.persistClaimGate = false;
    cur.persistClaimGateDisabledAt = new Date().toISOString();
    cur.persistClaimGateDisabledBy = reason;
    const tmp = cfgPath + ".tmp-" + process.pid;
    _replyFilterFs.writeFileSync(tmp, JSON.stringify(cur, null, 2) + "\n");
    _replyFilterFs.renameSync(tmp, cfgPath);
    return true;
  } catch (e) {
    try {
      console.error(
        "[reply-filter] persist-claim canary: could not disable gate:",
        e?.message?.slice(0, 120),
      );
    } catch {}
    return false;
  }
}
function _rfPersistClaimCanary(cfg, filterCfg, agentId, sinceMs, claimPreview) {
  try {
    if (filterCfg && filterCfg.persistClaimCanary === false) return;
    const delay =
      filterCfg && Number.isFinite(Number(filterCfg.persistClaimCanaryMs))
        ? Math.max(0, Number(filterCfg.persistClaimCanaryMs))
        : _RF_CLAIM_CANARY_MS;
    const correctedAt = Date.now();
    const t = setTimeout(() => {
      try {
        const ws = _rfAgentWorkspace(cfg, agentId);
        const inbound = _rfLastInboundMs(ws);
        const since = inbound != null && inbound < sinceMs ? inbound : sinceMs;
        // v34: a write that lands shortly AFTER the correction (050025 09-17: +6.4 s)
        // means the correction was premature — look 15 s past it.
        const lateMs =
          filterCfg && Number.isFinite(Number(filterCfg.persistClaimCanaryLateMs))
            ? Math.max(0, Number(filterCfg.persistClaimCanaryLateMs))
            : 15000;
        const hit = _rfWorkspaceWriteIn(ws, since, correctedAt + lateMs);
        if (hit == null) {
          try {
            console.log(
              "[reply-filter] persist-claim canary ok agent=" +
                agentId +
                " (no data write in window)",
            );
          } catch {}
          return;
        }
        const disabled = _rfDisablePersistClaimGate(
          "canary agent=" + agentId + " " + new Date(correctedAt).toISOString(),
        );
        try {
          console.error(
            "[reply-filter] persist-claim CANARY: false correction agent=" +
              agentId +
              " data written " +
              new Date(hit).toISOString() +
              " (inbound " +
              new Date(since).toISOString() +
              ", corrected " +
              new Date(correctedAt).toISOString() +
              ") claim=" +
              JSON.stringify(String(claimPreview || "").slice(0, 120)) +
              " gate " +
              (disabled ? "DISABLED" : "still on (disable failed)"),
          );
        } catch {}
        _rfAlert({
          jobId: "reply-filter-canary",
          jobName: "persist-claim false correction",
          alertType: "critical",
          message:
            "🔴 persist-claim 误纠正 agent=" +
            agentId +
            " claim=" +
            JSON.stringify(String(claimPreview || "").slice(0, 80)) +
            " — 数据文件 " +
            new Date(hit).toISOString() +
            " 已写入(收件 " +
            new Date(since).toISOString() +
            ",纠正 " +
            new Date(correctedAt).toISOString() +
            ")。persistClaimGate " +
            (disabled ? "已自动关闭" : "关闭失败,请手动关") +
            "(reply-filter.json)。infra#313",
        });
      } catch (e) {
        try {
          console.error("[reply-filter] persist-claim canary error:", e?.message?.slice(0, 120));
        } catch {}
      }
    }, delay);
    if (t && typeof t.unref === "function") t.unref();
  } catch {}
}
// v31 (#331): per-agent correction history for the loop breaker. Lives on
// globalThis so a header refresh (and the tests) can reset it; entries older
// than the window are dropped on read.
const _RF_CLAIM_LOOP_MS = 30 * 60 * 1000;
const _RF_CLAIM_LOOP_N = 3; // v32: the resend copy goes out at most three times (Jason, #331 reopen)
function _rfClaimLoopHistory() {
  if (!(globalThis.__nrClaimCorrections instanceof Map))
    globalThis.__nrClaimCorrections = new Map();
  return globalThis.__nrClaimCorrections;
}
function _rfClaimLoopCount(agentId, now) {
  const h = _rfClaimLoopHistory();
  const kept = (h.get(agentId) || []).filter(
    (t) => typeof t === "number" && now - t <= _RF_CLAIM_LOOP_MS,
  );
  if (kept.length) h.set(agentId, kept);
  else h.delete(agentId);
  return kept.length;
}
function _rfClaimLoopRecord(agentId, now) {
  const h = _rfClaimLoopHistory();
  const arr = h.get(agentId) || [];
  arr.push(now);
  h.set(agentId, arr.slice(-20));
}
function _rfHasBareClaim(text) {
  for (const line of text.split("\n")) {
    if (!_RF_CLAIM_RE.test(line)) continue;
    for (const sen of line.match(/[^.!?。!?]+[.!?。!?]*\s*/g) || [line])
      if (_rfIsBareClaim(sen)) return true;
  }
  return false;
}
function _rfSoftenClaimVerbs(text) {
  let n = 0;
  const out = text
    .split("\n")
    .map((line) => {
      if (!_RF_CLAIM_RE.test(line)) return line;
      const parts = line.match(/[^.!?。!?]+[.!?。!?]*\s*/g) || [line];
      return parts
        .map((sen) => {
          if (!_rfIsBareClaim(sen)) return sen;
          return sen.replace(_RF_CLAIM_VERB_RE, (m) => {
            n++;
            const r = _RF_CLAIM_INTENT[m.toLowerCase()];
            return r ? (m[0] === m[0].toUpperCase() ? r[0].toUpperCase() + r.slice(1) : r) : m;
          });
        })
        .join("");
    })
    .join("\n");
  return { out, n };
}
function _rfPersistClaimGate(text, agentId, stats, cfg, filterCfg) {
  try {
    const reg = globalThis.__nrTurnState;
    if (!(reg instanceof Map)) return text;
    const state = reg.get(String(agentId));
    if (
      !state ||
      typeof state.userAt !== "number" ||
      Date.now() - state.userAt > _RF_CLAIM_FRESH_MS
    )
      return text;
    if (!_RF_CLAIM_RE.test(text)) return text;
    if (_rfTurnBacksClaim(state)) return text;
    if (_rfWorkspaceWroteSince(cfg, agentId, state.userAt)) return text;
    const checkins = state.checkins || [];
    // v25: the engine asked a question this turn — the claim is premature,
    // not false. Rewrite the verbs to intent and keep the question intact.
    const askedTurn = checkins.some((c) => c && String(c.outcome) === "ask");
    // v29: nothing ran → no evidence either way → pass (or soften), never correct.
    const unbacked = !askedTurn && checkins.length === 0;
    if (askedTurn || unbacked) {
      const soften = askedTurn || (filterCfg && filterCfg.persistClaimUnbackedMode === "soften");
      if (!soften) {
        // telemetry only for a real bare claim (negated / recap / modal sentences are not claims)
        if (!_rfHasBareClaim(text)) return text;
        if (stats) {
          stats.pu = (stats.pu || 0) + 1;
          stats.k.push({ y: "claim-unbacked", p: text.slice(0, 90) });
        }
        try {
          console.log(
            "[reply-filter] persist-claim unbacked (passed) agent=" +
              agentId +
              " tools=" +
              ((state.tools || []).join(",") || "-") +
              " text=" +
              JSON.stringify(text.slice(0, 100)),
          );
        } catch {}
        return text;
      }
      const { out, n } = _rfSoftenClaimVerbs(text);
      if (n && out !== text) {
        if (stats) {
          stats.pc = (stats.pc || 0) + n;
          stats.k.push({ y: askedTurn ? "claim-ask" : "claim-soft", p: text.slice(0, 90) });
        }
        try {
          console.log(
            "[reply-filter] persist-claim softened (" +
              (askedTurn ? "ask turn" : "no evidence") +
              ") agent=" +
              agentId +
              " verbs=" +
              n,
          );
        } catch {}
        return out;
      }
      return text;
    }
    // refuted: meal_checkin ran and persisted nothing (none/error), the
    // workspace agrees — the only path that asserts "didn't get saved".
    const removed = [];
    const lines = text.split("\n").map((line) => {
      if (!_RF_CLAIM_RE.test(line)) return line;
      const parts = line.match(/[^.!?。!?]+[.!?。!?]*\s*/g) || [line];
      const kept = parts.filter((s) => {
        if (_rfIsBareClaim(s)) {
          removed.push(s.trim());
          return false;
        }
        return true;
      });
      return kept
        .join("")
        .replace(/^\s*[—–\-:,，:]\s*/, "")
        .trim();
    });
    if (!removed.length) return text;
    // v34 (#313 reopen): recap-shaped claims are about the record's state —
    // a member data write in the last 30 min backs them (050306: written 25 s
    // earlier, in the previous turn, outside this turn's inbound window).
    if (removed.some((s) => _RF_CLAIM_RECAP_WORD_RE.test(s))) {
      const recapWindow =
        filterCfg && Number.isFinite(Number(filterCfg.persistClaimRecapWindowMs))
          ? Math.max(0, Number(filterCfg.persistClaimRecapWindowMs))
          : _RF_CLAIM_RECAP_WINDOW_MS;
      const recent = _rfWorkspaceRecentWriteMs(cfg, agentId, recapWindow);
      if (recent != null) {
        if (stats) {
          stats.pr = (stats.pr || 0) + 1;
          stats.k.push({ y: "claim-recap-recent", p: removed[0].slice(0, 90) });
        }
        try {
          console.log(
            "[reply-filter] persist-claim recap backed by a data write " +
              Math.round((Date.now() - recent) / 1000) +
              " s ago agent=" +
              agentId +
              " claim=" +
              JSON.stringify(removed[0].slice(0, 100)),
          );
        } catch {}
        return text;
      }
    }
    const zh = removed.some((s) => /[一-鿿]/.test(s));
    // v31 (#331): the third refuted claim inside 30 min is a loop — the
    // resend the copy asks for has already failed twice. Say so instead,
    // never ask for it again, and wake a human on the first loop hit.
    const now = Date.now();
    const loopOn = !(filterCfg && filterCfg.persistClaimLoopBreak === false);
    const loopN =
      filterCfg && Number.isFinite(Number(filterCfg.persistClaimLoopN))
        ? Math.max(1, Math.floor(Number(filterCfg.persistClaimLoopN)))
        : _RF_CLAIM_LOOP_N;
    const prior = loopOn ? _rfClaimLoopCount(agentId, now) : 0;
    const looping = loopOn && prior >= loopN;
    const correction = looping
      ? zh
        ? "更正——这条还是没保存成功,重发也没用。我已经把它标记上报,你不用再发了。"
        : "Correction — that still didn't get saved on my end, and resending won't fix it. I've flagged it so it gets sorted — no need to send it again."
      : zh
        ? "更正——这条其实没有保存成功。再发一次,我马上记上。"
        : "Correction — that didn't actually get saved on my end. Send it again and I'll log it properly.";
    const rest = lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (stats) {
      stats.pc = (stats.pc || 0) + removed.length;
      stats.k.push({ y: looping ? "claim-loop" : "claim", p: removed[0].slice(0, 90) });
      if (looping) stats.pl = (stats.pl || 0) + 1;
    }
    try {
      console.log(
        "[reply-filter] persist-claim corrected agent=" +
          agentId +
          " tools=" +
          ((state.tools || []).join(",") || "-") +
          " checkins=" +
          JSON.stringify((state.checkins || []).map((c) => c.outcome + "/" + c.save)) +
          " claim=" +
          JSON.stringify(removed[0].slice(0, 120)),
      );
    } catch {}
    if (loopOn) _rfClaimLoopRecord(agentId, now);
    if (looping) {
      try {
        console.error(
          "[reply-filter] persist-claim LOOP agent=" +
            agentId +
            " corrections=" +
            (prior + 1) +
            " in " +
            Math.round(_RF_CLAIM_LOOP_MS / 60000) +
            " min — resend copy suppressed; the answer has no write behind it (missing storage or tool never called). infra#331",
        );
      } catch {}
      if (prior === loopN) {
        _rfAlert({
          jobId: "reply-filter-claim-loop",
          jobName: "persist-claim loop",
          message:
            "⚠️ persist-claim 死循环 agent=" +
            agentId +
            ":30 分钟内第 " +
            (prior + 1) +
            " 次纠正,claim=" +
            JSON.stringify(removed[0].slice(0, 80)) +
            " — 已改用不要求重发的文案。多半是回答没有落盘位(补剂/习惯类)或写入工具没被调用,请看该户工作区。infra#331",
        });
      }
    }
    _rfPersistClaimCanary(cfg, filterCfg, agentId, state.userAt, removed[0]);
    return rest ? correction + "\n\n" + rest : correction;
  } catch (e) {
    try {
      console.error("[reply-filter] persist-claim gate error:", e?.message?.slice(0, 120));
    } catch {}
    return text;
  }
}
// ── v25 preference belt for the deliver path (openclaw-infra#250) ──
const _RF_PREF_NO_ALCOHOL_RE =
  /\b(?:does(?:n'?t| not) drink|don'?t drink|not drink(?:ing)?|no alcohol|alcohol[- ]free|sober|recovering alcoholic|teetotal)\b|禁酒|不喝酒|戒酒|滴酒不沾/iu;
const _RF_PREF_NO_SCALE_RE =
  /\b(?:recovery mode|zero scale pressure|no scale pressure|avoid_weight_focus|history_of_ed|do not (?:push|mention) (?:the )?scale|skip (?:the )?scale)\b|不称重|不要提体重/iu;
const _RF_ALCOHOL_PARA_RE =
  /\b(?:alcohol(?:ic)?|wine|beer|cocktails?|liquor|vodka|whisk(?:e)?y|tequila|margaritas?|a drink or two|drinks? (?:count|loosen|add up|carr(?:y|ies)))\b|(?:酒|饮酒)/iu;
const _RF_SCALE_PARA_RE =
  /\b(?:the scale|weigh(?:-?ins?|ing)?|weigh yourself|step on)\b|称重|上秤/iu;
const _RF_PREF_TTL_MS = 10 * 60 * 1000;
const _rfPrefCache = new Map();
function _rfWorkspaceDir(cfg, agentId) {
  const home = process.env.HOME ?? "/root";
  const list = cfg && cfg.agents && Array.isArray(cfg.agents.list) ? cfg.agents.list : [];
  const ent = list.find((a) => a && a.id === agentId);
  if (ent && ent.workspace) return String(ent.workspace).replace(/^~(?=$|\/)/, home);
  return home + "/.openclaw/workspace-nutritionist/" + agentId;
}
function _rfPrefExclusions(cfg, agentId) {
  try {
    const now = Date.now();
    const hit = _rfPrefCache.get(agentId);
    if (hit && now - hit.at < _RF_PREF_TTL_MS) return hit.ex;
    const ws = _rfWorkspaceDir(cfg, agentId);
    let blob = "";
    for (const f of ["health-preferences.md", "USER.md", "MEMORY.md", "health-profile.md"]) {
      try {
        blob += "\n" + _replyFilterFs.readFileSync(ws + "/" + f, "utf8");
      } catch {}
    }
    const ex = new Set();
    if (_RF_PREF_NO_ALCOHOL_RE.test(blob)) ex.add("alcohol");
    if (_RF_PREF_NO_SCALE_RE.test(blob)) ex.add("scale");
    if (_rfPrefCache.size > 1000) _rfPrefCache.clear();
    _rfPrefCache.set(agentId, { at: now, ex });
    return ex;
  } catch {
    return new Set();
  }
}
function _rfPrefParaBlocked(p, ex) {
  if (!ex || !ex.size) return null;
  if (ex.has("alcohol") && _RF_ALCOHOL_PARA_RE.test(p)) return "alcohol";
  if (ex.has("scale") && _RF_SCALE_PARA_RE.test(p)) return "scale";
  return null;
}
// ── v24 card reconciliation (openclaw-infra#286) — see changelog ──
const _RF_SLOT_WORDS = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack" };
// v37: a bullet whose "name" is a slot word is a day-list line, not a card row.
const _RF_DAYLIST_ROW_RE = /^(?:breakfast|lunch|dinner|supper|snack|早餐|午餐|晚餐|加餐)$/iu;
const _RF_CARD_TITLE_RE =
  /^(\s*📝\s*)(Breakfast|Lunch|Dinner|Supper|Snack|早餐|午餐|晚餐|加餐)(\b[^\n]*?logged!?)/imu;
// v30: label captured separately — an addition card is relabelled "This addition".
const _RF_CARD_TOTAL_RE =
  /^(\s*🍽\s*This\s+)(meal|snack|breakfast|lunch|dinner|addition)(\s*:\s*)(\d[\d,]*)(\s*kcal)/imu;
const _RF_CARD_ROW_RE =
  /^(\s*[·•]\s*)(.+?)(\s+[—–-]\s+)(\d[\d,]*)(\s*g\s+[—–-]\s+)(\d[\d,]*)(\s*kcal\b)/imu;
// v35 (#300 reopen, 050313 2026-09-20): a card row is ANY bullet that ends in
// "N kcal" — "· TRIP Calm L-theanine drink — 355ml — 30 kcal" and
// "· Premier Protein Shake (Vanilla) — 160 kcal" are rows too. The grams-only
// regex above missed them, the card counted 2 rows against a 3-row record,
// the addition-view branch fired and the total became the sum of the two
// gram rows (157→127) — the coach had it right. Groups: bullet, name, sep,
// middle ("355ml — " / "" ), kcal, unit. Grams are only rewritten on g rows.
const _RF_CARD_ROWANY_RE =
  /^(\s*[·•]\s*)(.+?)(\s+[—–-]\s+)((?:.*?[—–-]\s+)?)(\d[\d,]*)(\s*kcal\b)/imu;
const _rfNormName = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .trim();
function _rfRowMatch(name, dishes) {
  const n = _rfNormName(name);
  if (!n) return null;
  let best = null,
    bestScore = 0;
  for (const d of dishes) {
    const dn = _rfNormName(d.name);
    if (!dn) continue;
    let score = 0;
    if (dn === n) score = 3;
    else if (dn.includes(n) || n.includes(dn)) score = 2;
    else {
      const a = new Set(n.split(" ")),
        b = new Set(dn.split(" "));
      const inter = [...a].filter((w) => w.length > 2 && b.has(w)).length;
      if (inter >= 1 && inter >= Math.min(a.size, b.size) / 2) score = 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}
// v38 (#300 5th reopen, 060329 2026-09-23 02:07Z): the coach summed five
// itemized record rows — "Egg (cooked in omelette)", "Spinach (in omelette)",
// "Tomato …", "Onion …", "Butter (for eggs)" — into ONE card row "Egg omelette
// (2 eggs, spinach, tomato, onion, butter) — 174g — 261 kcal" and wrote the
// record's 821. The addition view matched that row to the single best record
// row (egg, 100 g / 143), rewrote it and set the total to the listed rows' sum
// (703). A card row COVERS every record row whose head word the row names
// (egg / spinach / tomato / onion / butter) when it names two or more distinct
// heads; its record value is their sum, and coverage is counted in record rows.
const _RF_TOK_STOP = new Set([
  "and",
  "the",
  "with",
  "for",
  "from",
  "cooked",
  "made",
  "plain",
  "large",
  "small",
  "medium",
  "slices",
  "slice",
  "pieces",
  "piece",
  "cup",
  "cups",
  "tbsp",
  "tsp",
  "half",
  "whole",
  "fresh",
  "raw",
  "extra",
]);
const _rfTok = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[()]/g, " ")
    .replace(/[^a-z0-9一-鿿]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 2 && !_RF_TOK_STOP.has(w) && !/^\d+$/.test(w));
function _rfCoverRow(name, dishes) {
  const full = new Set(_rfTok(name));
  const heads = new Map();
  for (const d of dishes || []) {
    const t = _rfTok(d.name);
    if (!t.length) continue;
    const head = t[0];
    if (full.has(head) && !heads.has(head)) heads.set(head, d);
  }
  if (heads.size >= 2) {
    const parts = [...heads.values()];
    return {
      dishes: parts,
      g: parts.reduce((s, d) => s + (Number(d.g) || 0), 0),
      kcal: parts.reduce((s, d) => s + (Number(d.kcal) || 0), 0),
      aggregate: true,
    };
  }
  const best = _rfRowMatch(name, dishes);
  return best ? { dishes: [best], g: best.g, kcal: best.kcal, aggregate: false } : null;
}
function _rfLatestRender(state) {
  for (let i = (state.checkins || []).length - 1; i >= 0; i--) {
    const c = state.checkins[i];
    if (
      c &&
      Array.isArray(c.render) &&
      c.render.length === 1 &&
      !_RF_NON_PERSIST_OUTCOMES.has(String(c.outcome))
    )
      return c.render[0];
  }
  return null;
}
// v27 (#303, 050298 2026-09-15): "212 down to 213 — that's -1 lb since
// yesterday" — the verdict and the delta were right, the two readings were
// written in the wrong order. Deterministic: when "A down to B" has B > A (or
// "A up to B" has B < A) the numbers are swapped; the direction word is the
// engine's verdict and stays. Same-number pairs and non-numeric text untouched.
const _RF_WEIGH_DIR_RE =
  /\b(\d{2,3}(?:\.\d)?)(\s*(?:lb|lbs|kg)?\s+)(down|up)(\s+to\s+)(\d{2,3}(?:\.\d)?)(\s*(?:lb|lbs|kg)?)\b/giu;
function _rfWeighDirectionFix(text, agentId, stats) {
  try {
    if (!/\b(?:down|up) to\b/iu.test(text)) return text;
    let n = 0;
    const out = text.replace(_RF_WEIGH_DIR_RE, (m, a, sp1, dir, sp2, b, sp3) => {
      const av = Number(a),
        bv = Number(b);
      if (!Number.isFinite(av) || !Number.isFinite(bv) || av === bv) return m;
      const wrong =
        (dir.toLowerCase() === "down" && bv > av) || (dir.toLowerCase() === "up" && bv < av);
      if (!wrong) return m;
      n++;
      return b + sp1 + dir + sp2 + a + sp3;
    });
    if (n && stats) {
      stats.wd = (stats.wd || 0) + n;
      stats.k.push({ y: "weigh-dir", p: text.slice(0, 90) });
    }
    if (n) {
      try {
        console.log("[reply-filter] weigh-in direction fixed agent=" + agentId + " n=" + n);
      } catch {}
    }
    return out;
  } catch {
    return text;
  }
}
function _rfCardReconcile(text, agentId, stats) {
  try {
    if (!/📝/u.test(text)) return text;
    const reg = globalThis.__nrTurnState;
    if (!(reg instanceof Map)) return text;
    const state = reg.get(String(agentId));
    if (
      !state ||
      typeof state.userAt !== "number" ||
      Date.now() - state.userAt > _RF_CLAIM_FRESH_MS
    )
      return text;
    const r = _rfLatestRender(state);
    if (!r || !r.slot || !_RF_SLOT_WORDS[r.slot]) return text;
    const fixes = [];
    const lines = text.split("\n");
    let titleSeen = false;
    // v26 (#300, 050225 2026-09-14): a render that carries FEWER rows than
    // the card lists is a partial record (an append's own rows, not the
    // whole meal) — its total is a delta, and "fixing" the coach's whole-meal
    // total to it produced "🍽 This meal: 1 kcal" over a 160 kcal shake.
    // Numbers are only reconciled when the render covers the whole card.
    // v37 (#300 4th reopen, 050281 2026-09-20 22:28Z): a "full day" list under
    // the card ("· lunch — 488 kcal (shrimp, …)") is not a card row — counted
    // as rows it made a 2-row snack card look like 6 rows against a 4-row
    // lunch record ("partial render"), and the slot-only branch retitled the
    // snack card "Lunch" over its own "🍽 This snack" line.
    const rowLines = lines.filter((l) => {
      const mm = _RF_CARD_ROWANY_RE.exec(l);
      return mm && !_RF_DAYLIST_ROW_RE.test(mm[2].trim());
    }); // v35: any "… — N kcal" bullet
    // v37: which of the card's rows the render actually holds, and the slot
    // the card names for ITSELF on the total line ("🍽 This snack:").
    // v38: each card row covers one record row, or several (a summed composite).
    const covers = new Map();
    for (const l of rowLines) {
      const mm = _RF_CARD_ROWANY_RE.exec(l);
      const c = mm ? _rfCoverRow(mm[2], r.dishes) : null;
      if (c) covers.set(l, c);
    }
    const matchedRows = covers.size;
    const coveredRecord = new Set();
    for (const c of covers.values()) for (const d of c.dishes) coveredRecord.add(d);
    const tm = _RF_CARD_TOTAL_RE.exec(text);
    const bodySlot = tm && _RF_SLOT_WORDS[tm[2].toLowerCase()] ? tm[2].toLowerCase() : null;
    const cardRows = rowLines.length;
    const renderRows = Array.isArray(r.dishes) ? r.dishes.length : 0;
    // v30 (#300 reopen, 050225 2026-09-16): the OTHER direction. After the
    // engine fix the render is the whole meal (6 rows, 1730 kcal) while the
    // coach writes an ADDITION card — only the cupcake row, "This meal: 350",
    // macros of the cupcake. v26's "cardRows <= renderRows" then replaced
    // 350 with 1730 over a single 350 kcal row (five cards that day, ×4.9).
    // Three scopes now:
    //   fullCard      rows match → whole-meal reconcile (title, rows, total);
    //   additionCard  fewer rows than the record → an addition view: rows
    //                 reconcile by name, the total is the SUM of the listed
    //                 rows' record values, and the label says "This addition";
    //   partialRender more rows than the record → slot title only (v26).
    // v37: equal row COUNTS are not the same meal — every listed row must be in the render.
    // v38: coverage is counted in RECORD rows — a summed composite row covers several.
    const fullCard =
      renderRows > 0 && matchedRows === cardRows && coveredRecord.size === renderRows;
    const additionCard =
      renderRows > 0 &&
      cardRows > 0 &&
      !fullCard &&
      cardRows < renderRows &&
      coveredRecord.size < renderRows;
    let additionTotal = null;
    if (additionCard) {
      let sum = 0,
        all = true;
      for (const l of rowLines) {
        const c = covers.get(l);
        if (!c || c.kcal == null) {
          all = false;
          break;
        }
        sum += c.kcal;
      }
      additionTotal = all ? sum : null;
    }
    const numbersOk = fullCard || additionCard;
    // v37: a card that names a DIFFERENT slot for itself than the render, and
    // whose rows the render does not fully cover, is about another meal (the
    // engine's write this turn was the lunch confirm; the coach's card is the
    // snack it also mentioned). Nothing in it is ours to reconcile.
    if (bodySlot && bodySlot !== r.slot && !fullCard) {
      try {
        console.log(
          "[reply-filter] card reconcile: card is about " +
            bodySlot +
            ", render is " +
            r.slot +
            " (" +
            matchedRows +
            "/" +
            cardRows +
            " rows match) — skipped agent=" +
            agentId,
        );
      } catch {}
      return text;
    }
    if (!numbersOk) {
      try {
        console.log(
          "[reply-filter] card reconcile: partial render (" +
            renderRows +
            " rows vs " +
            cardRows +
            " on the card) — slot only agent=" +
            agentId,
        );
      } catch {}
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m = _RF_CARD_TITLE_RE.exec(line);
      if (m && !titleSeen) {
        titleSeen = true;
        const want = _RF_SLOT_WORDS[r.slot];
        const have = m[2];
        const haveSlot = /^(?:supper|晚餐)$/iu.test(have)
          ? "dinner"
          : /^早餐$/u.test(have)
            ? "breakfast"
            : /^午餐$/u.test(have)
              ? "lunch"
              : /^加餐$/u.test(have)
                ? "snack"
                : have.toLowerCase();
        // v37: the title only follows the render when the render is demonstrably
        // THIS card's meal \u2014 every listed row is in it (full card), or at
        // least one row is and the card does not call itself another slot.
        // 050244 (13:24Z): a breakfast card retitled "Lunch" from a lunch
        // render that shared none of its rows; the member had to correct it.
        const titleOk =
          fullCard || (cardRows > 0 && matchedRows >= 1 && !(bodySlot && bodySlot !== r.slot));
        if (haveSlot !== r.slot && !titleOk) {
          try {
            console.log(
              "[reply-filter] card reconcile: title " +
                have +
                " kept \u2014 render " +
                r.slot +
                " covers " +
                matchedRows +
                "/" +
                cardRows +
                " rows agent=" +
                agentId,
            );
          } catch {}
        }
        if (haveSlot !== r.slot && titleOk && !/[\u4e00-\u9fff]/u.test(have)) {
          lines[i] = m[1] + want + m[3] + line.slice(m[0].length);
          fixes.push("title " + have + "→" + want);
        }
        continue;
      }
      m = _RF_CARD_TOTAL_RE.exec(line);
      if (m && numbersOk) {
        const label = m[2],
          have = Number(m[4].replace(/,/g, ""));
        if (fullCard && r.total_kcal != null) {
          const wantLabel = /^addition$/iu.test(label) ? "meal" : label;
          if (have !== r.total_kcal || wantLabel !== label) {
            lines[i] =
              m[1] + wantLabel + m[3] + String(r.total_kcal) + m[5] + line.slice(m[0].length);
            fixes.push("total " + have + "→" + r.total_kcal);
          }
        } else if (additionCard && additionTotal != null) {
          if (have !== additionTotal || !/^addition$/iu.test(label)) {
            lines[i] =
              m[1] + "addition" + m[3] + String(additionTotal) + m[5] + line.slice(m[0].length);
            fixes.push("addition " + label + " " + have + "→" + additionTotal);
          }
        }
        continue;
      }
      m = _RF_CARD_ROW_RE.exec(line);
      if (m && numbersOk) {
        const d = covers.get(line);
        if (!d) continue;
        const haveG = Number(m[4].replace(/,/g, "")),
          haveK = Number(m[6].replace(/,/g, ""));
        const wantG = d.g != null ? d.g : haveG,
          wantK = d.kcal != null ? d.kcal : haveK;
        if (haveG !== wantG || haveK !== wantK) {
          lines[i] =
            m[1] +
            m[2] +
            m[3] +
            String(wantG) +
            m[5] +
            String(wantK) +
            m[7] +
            line.slice(m[0].length);
          fixes.push(
            "row " +
              m[2].trim().slice(0, 30) +
              " " +
              haveG +
              "g/" +
              haveK +
              "→" +
              wantG +
              "g/" +
              wantK,
          );
        }
        continue;
      }
      // v35: a non-gram row ("355ml", no quantity) — reconcile the kcal only.
      m = _RF_CARD_ROWANY_RE.exec(line);
      if (m && numbersOk) {
        const d = covers.get(line);
        if (!d || d.kcal == null) continue;
        const haveK = Number(m[5].replace(/,/g, ""));
        if (haveK !== d.kcal) {
          lines[i] = m[1] + m[2] + m[3] + m[4] + String(d.kcal) + m[6] + line.slice(m[0].length);
          fixes.push("row " + m[2].trim().slice(0, 30) + " " + haveK + "→" + d.kcal + " kcal");
        }
      }
    }
    if (!fixes.length) return text;
    if (stats) {
      stats.cc = (stats.cc || 0) + fixes.length;
      stats.k.push({ y: "card", p: fixes.join("; ").slice(0, 90) });
    }
    try {
      console.log("[reply-filter] card reconciled agent=" + agentId + " " + fixes.join("; "));
    } catch {}
    return lines.join("\n");
  } catch (e) {
    try {
      console.error("[reply-filter] card reconcile error:", e?.message?.slice(0, 120));
    } catch {}
    return text;
  }
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
// ── v36 (#372): registration gate ──
// Returns null when the agent may proceed to the mode lists, else a short
// reason string. Registered = the id has an entry in cfg.agents.list, or it is
// on the filter's exclude list (operator agents such as main). "unknown" (no
// sessionKey) is never registered. When the config carries no agents list at
// all (unit tests, a 3-arg call with a bare config) registration cannot be
// judged and the gate stays out of the way — the gate's job is the agent that
// LEFT the list, not a missing config.
function _rfUnregisteredReason(cfg, agentId, filterCfg) {
  try {
    if (filterCfg && filterCfg.unregisteredGate === false) return null;
    const agents = cfg && cfg.agents && Array.isArray(cfg.agents.list) ? cfg.agents.list : null;
    if (!agents || agents.length === 0) return null;
    if (!agentId || agentId === "unknown") return "unresolvable agent (no sessionKey)";
    const excluded =
      filterCfg &&
      filterCfg.mode === "exclude" &&
      Array.isArray(filterCfg.exclude) &&
      filterCfg.exclude.includes(agentId);
    if (excluded) return null;
    if (agents.some((a) => a && String(a.id) === String(agentId))) return null;
    return "unregistered agent " + agentId + " (not in agents.list)";
  } catch {
    return null;
  }
}
// One operator ping per agent per 10 minutes — a runaway cron would
// otherwise turn the alert channel into the leak.
function _rfAlertUnregistered(agentId, reason, path, chars) {
  try {
    const g = globalThis;
    if (!g.__nrUnregAlerted) g.__nrUnregAlerted = new Map();
    const last = g.__nrUnregAlerted.get(agentId) || 0;
    if (Date.now() - last < 10 * 60 * 1000) return;
    g.__nrUnregAlerted.set(agentId, Date.now());
    _rfAlert({
      jobId: "reply-filter-unregistered",
      jobName: "reply-filter unregistered agent",
      message:
        "reply filter withheld " +
        path +
        " text: " +
        reason +
        " (" +
        chars +
        " chars). A member agent outside agents.list, or a delivery with no session key — check openclaw.json agents.list and the cron that produced it (#372).",
    });
  } catch {}
}
// ── Main filter logic ──
// opts.path: "deliver" (Path 2 — cron/announce/message-tool; fail-closed on
// classify failure, longer timeout) | anything else = interactive dispatch
// semantics (fail-open). The deliver chokepoint passes the hint; the dispatch
// chokepoints stay 3-arg on purpose.
// v28 (#301, 050025 2026-09-15): two dinner-reminder crons 2 minutes apart in
// the same direct session — the second one's model copied the first one's
// text verbatim, and the user got the same nudge twice (two Twilio SIDs) as
// the "reply" to his answer. Deliver path only (cron/announce output): a
// payload identical to a body this agent already sent in the last 30 minutes
// is dropped. The record is the agent's own outbound.jsonl (last 64 KB).
const _RF_DEDUPE_WINDOW_MS = 30 * 60 * 1000;
function _rfNormBody(t) {
  return String(t || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
function _rfDeliverDedupe(text, agentId, stats) {
  try {
    const norm = _rfNormBody(text);
    if (norm.length < 20) return false;
    const p = (process.env.HOME ?? "/root") + "/.openclaw/agents/" + agentId + "/outbound.jsonl";
    let st;
    try {
      st = _replyFilterFs.statSync(p);
    } catch {
      return false;
    }
    const size = st.size,
      start = Math.max(0, size - 65536);
    const fd = _replyFilterFs.openSync(p, "r");
    let buf;
    try {
      buf = Buffer.alloc(size - start);
      _replyFilterFs.readSync(fd, buf, 0, size - start, start);
    } finally {
      _replyFilterFs.closeSync(fd);
    }
    const now = Date.now();
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i].trim();
      if (!l.startsWith("{")) continue;
      let rec;
      try {
        rec = JSON.parse(l);
      } catch {
        continue;
      }
      const ts = Date.parse(rec.ts || "");
      if (Number.isFinite(ts) && now - ts > _RF_DEDUPE_WINDOW_MS) break;
      if (rec.kind && rec.kind !== "text") continue;
      if (_rfNormBody(rec.body) === norm) {
        if (stats) {
          stats.dd = (stats.dd || 0) + 1;
          stats.k.push({ y: "dedupe", p: text.slice(0, 90) });
        }
        try {
          console.log(
            "[reply-filter] deliver dedupe: identical to a body sent " +
              Math.round((now - ts) / 1000) +
              " s ago agent=" +
              agentId,
          );
        } catch {}
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
async function _filterReplyText(text, cfg, sessionKey, opts) {
  const _t0 = Date.now();
  const _rfPath = opts && opts.path === "deliver" ? "deliver" : "dispatch";
  // Strip non-NanoRhino URLs on EVERY reply — before the enabled/exclude
  // early-returns — so no off-brand link can ever reach a user.
  if (text) text = _stripNonBrandUrls(text);
  const filterCfg = _loadReplyFilterCfg();
  if (!filterCfg?.enabled) return { drop: false, text };
  // v36 (#372, Jason 2026-09-20): the agent must be resolvable AND registered
  // before the mode lists are consulted. A missing sessionKey used to fall
  // to "main" — which sits on the exclude list — so an unregistered agent's
  // cron announce (bench 060374, dropped from agents.list on 08-21) reached
  // the channel with no decision line and no journal line at all. Now:
  // unknown or unregistered → the text is withheld on every path, a
  // decision line says why, and the operator gets one alert per agent.
  const agentId = sessionKey?.split(":")?.[1] ?? "unknown";
  const list = filterCfg.exclude ?? filterCfg.include ?? [];
  const _unreg = _rfUnregisteredReason(cfg, agentId, filterCfg);
  if (_unreg) {
    _rfLogDecision({
      t: new Date().toISOString(),
      v: _REPLY_FILTER_HEADER_VERSION,
      a: agentId,
      path: _rfPath,
      in: text ? text.length : 0,
      drop: 1,
      out: 0,
      ur: 1,
      k: [{ y: "unregistered", p: _unreg }],
    });
    try {
      console.warn(
        `[reply-filter] BLOCKED ${_rfPath} text for ${_unreg} (agent=${agentId}, ${text ? text.length : 0} chars) — #372 fail-closed`,
      );
    } catch {}
    _rfAlertUnregistered(agentId, _unreg, _rfPath, text ? text.length : 0);
    return { drop: true, text: "" };
  }
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
    lv: 0,
    pc: 0,
    pu: 0,
    pl: 0,
    pr: 0,
    tl: 0,
    cc: 0,
    pf: 0,
    wd: 0,
    dd: 0,
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
  // v28: deliver-path dedupe — a proactive payload identical to something this
  // agent sent in the last 30 min is dropped outright (#301).
  if (
    _rfPath === "deliver" &&
    filterCfg.deliverDedupe !== false &&
    _rfDeliverDedupe(text, agentId, stats)
  ) {
    return _done(true, "");
  }
  // v22: persist-claim gate (dispatch only) — runs first so the correction line
  // is ordinary coach copy for every later phase.
  if (_rfPath !== "deliver" && filterCfg.persistClaimGate !== false) {
    const _pre = text;
    text = _rfPersistClaimGate(text, agentId, stats, cfg, filterCfg);
    if (text !== _pre) stats.in = _pre.length;
  }
  // v24: card reconciliation (dispatch only) — the record's slot and numbers
  // win over the coach's retelling of them.
  if (_rfPath !== "deliver" && filterCfg.cardReconcile !== false) {
    text = _rfCardReconcile(text, agentId, stats);
  }
  // v27: weigh-in "A down to B" with B > A → numbers swapped (verdict stays).
  if (filterCfg.weighDirectionFix !== false) {
    text = _rfWeighDirectionFix(text, agentId, stats);
  }
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
  // v25 (#250): deliver-path preference belt — never push alcohol / scale copy
  // at a member whose files say not to.
  const _prefEx =
    _rfPath === "deliver" && filterCfg.preferenceBelt !== false
      ? _rfPrefExclusions(cfg, agentId)
      : null;
  const afterRegex = _dedupParagraphs(
    _rfDropKilledTails(
      paragraphs.map((p) => {
        if (_isUserFacingUrlPara(p)) return p;
        if (_prefEx && _prefEx.size) {
          const why = _rfPrefParaBlocked(p, _prefEx);
          if (why) {
            stats.pf = (stats.pf || 0) + 1;
            stats.k.push({ y: "pref", p: why + ": " + p.trim().slice(0, 80) });
            try {
              console.log(
                "[reply-filter] preference belt dropped a " + why + " paragraph agent=" + agentId,
              );
            } catch {}
            return null;
          }
        }
        if (_fastReject(p.trim())) {
          stats.rk++;
          stats.k.push({ y: "rx", p: p.trim().slice(0, 90) });
          return null;
        }
        return p;
      }),
      stats,
      agentId,
    ),
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
          // v21: on the interactive path the classifier alone cannot kill an
          // unmarked paragraph — every such kill since v16 was member copy.
          // Logged as a veto so the weekly review still sees what it wanted.
          if (
            _rfPath !== "deliver" &&
            filterCfg.classifierAdvisoryOnDispatch !== false &&
            !_RF_HARD_MARK.test(p)
          ) {
            stats.lv++;
            stats.k.push({ y: "llm-veto", p: _pt.slice(0, 90) });
            return p;
          }
          stats.lk++;
          stats.k.push({ y: "llm", p: _pt.slice(0, 90) });
          return null;
        }
        return p;
      }),
    );
    const kept = _rfDropKilledTails(results, stats, agentId);
    if (kept.length === 0) {
      if (stats.fc > 0) _rfAlertFailClosed(agentId, stats.fc);
      return _done(true, "");
    }
    return _done(false, kept.join("\n\n"));
  }
  return _done(false, afterRegex.join("\n\n"));
}
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
