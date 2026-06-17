// Narrow session-store helpers for channel hot paths.

export { loadSessionStore } from "../config/sessions/store-load.js";
export { resolveSessionStoreEntry } from "../config/sessions/store-entry.js";
export { resolveSessionTranscriptPathInDir, resolveStorePath } from "../config/sessions/paths.js";
export { resolveAndPersistSessionFile } from "../config/sessions/session-file.js";
// Channel plugins (e.g. human-handoff: mirror 客服工作台 / user messages into the
// agent's transcript without triggering a turn) need a parentId-safe assistant
// append keyed by sessionKey. Goes through SessionManager.appendMessage path,
// not raw JSONL writes.
export { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
// human-handoff: mirror the user's OWN messages with real role:"user" (symmetric
// to the assistant one above). Same resolve/idempotency/parentId-safe path, no
// agent turn. So after a human takeover the agent reads the resumed conversation
// exactly like normal inbound turns (correct role → correct reference handling).
export { appendUserMessageToSessionTranscript } from "../config/sessions/transcript.js";
export { resolveSessionKey } from "../config/sessions/session-key.js";
export { resolveGroupSessionKey } from "../config/sessions/group.js";
export { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
export {
  clearSessionStoreCacheForTest,
  readSessionUpdatedAt,
  recordSessionMetaFromInbound,
  saveSessionStore,
  updateLastRoute,
  updateSessionStore,
  updateSessionStoreEntry,
} from "../config/sessions/store.js";
export {
  evaluateSessionFreshness,
  resolveChannelResetConfig,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveThreadFlag,
} from "../config/sessions/reset.js";
export type { SessionEntry, SessionScope } from "../config/sessions/types.js";
