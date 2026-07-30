// Type surface for the vendored reply filter (filter-v5.js, header v13 —
// verbatim from openclaw-infra patches/002-reply-filter-v5). The engine is
// battle-tested plain JS; only the two call sites below are typed.
export declare function _filterReplyText(
  text: string,
  cfg: unknown,
  sessionKey?: string,
  opts?: { path?: "deliver" | "dispatch" },
): Promise<{ drop: boolean; text: string }>;
export declare const _REPLY_FILTER_SOURCE_NATIVE_MARKER: string;
