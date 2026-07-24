import crypto from "node:crypto";

/**
 * Shared placeholder contract for evicted/analyzed meal-photo image blocks.
 *
 * Two independent paths must produce a BYTE-IDENTICAL placeholder for the same
 * image so it stays inside the Bedrock prompt-cache prefix without invalidating
 * it:
 *   1. The Bedrock Converse payload projection (history images -> placeholder on
 *      the wire; see bedrock-stream-wrappers.ts).
 *   2. The resident/on-disk transcript eviction (history images -> placeholder
 *      in the JSONL before SessionManager.open; see evict-transcript-images.ts).
 *
 * The hash is over the DECODED image bytes so both callers agree regardless of
 * how they hold the image (Converse `source.bytes` Uint8Array vs the base64
 * `data` string in the transcript — `atob` and `Buffer.from(..,"base64")`
 * produce the same bytes). Keep this the single source of truth; do not inline a
 * second copy of the format.
 */
export function imageContentHash8(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 8);
}

export function historyImagePlaceholderText(hash8: string): string {
  return `[photo ${hash8}: analyzed meal image]`;
}

/** Placeholder for a base64-encoded image (transcript `data` field). */
export function historyImagePlaceholderForBase64(base64Data: string): string {
  return historyImagePlaceholderText(imageContentHash8(Buffer.from(base64Data, "base64")));
}
