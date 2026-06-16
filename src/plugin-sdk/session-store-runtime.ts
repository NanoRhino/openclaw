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
