import fs from "node:fs/promises";
import { formatErrorMessage } from "../../infra/errors.js";
import { acquireSessionWriteLock } from "../session-write-lock.js";
import { historyImagePlaceholderForBase64 } from "./history-image-placeholder.js";
import { log } from "./logger.js";

// Substring present on any JSONL line that carries an image content block. pi
// serializes entries with JSON.stringify (no spaces), so this is exact. Used as a
// cheap gate so text-only / already-evicted lines are never parsed, and as the
// idempotency guard (evicted lines carry {"type":"text",...} instead).
const IMAGE_MARKER = '"type":"image"';

// Bound the lock wait so a contended session never stalls the turn's hot path;
// eviction is best-effort and simply retries on the next load.
const EVICT_LOCK_TIMEOUT_MS = 5_000;

function evictImagesInContentArray(content: unknown[]): number {
  let evicted = 0;
  for (let i = 0; i < content.length; i += 1) {
    const block = content[i];
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "image" &&
      typeof (block as { data?: unknown }).data === "string"
    ) {
      // 1:1 replacement (never delete the block) so message shape / arity is
      // preserved and the entry still opens cleanly in SessionManager.
      content[i] = {
        type: "text",
        text: historyImagePlaceholderForBase64((block as { data: string }).data),
      };
      evicted += 1;
    }
  }
  return evicted;
}

function evictImagesInEntry(entry: unknown): number {
  if (!entry || typeof entry !== "object") {
    return 0;
  }
  const rec = entry as { type?: unknown; message?: unknown };
  // Images only live in a message entry's content array (user + toolResult
  // roles). Entry id / parentId / timestamp and all other fields are untouched.
  if (rec.type !== "message") {
    return 0;
  }
  const message = rec.message as { content?: unknown } | undefined;
  if (!message || !Array.isArray(message.content)) {
    return 0;
  }
  return evictImagesInContentArray(message.content);
}

/**
 * Rewrite a raw transcript (JSONL) string, replacing every image content block's
 * base64 with a byte-stable `[photo <hash8>: analyzed meal image]` text block
 * (same format as the Bedrock payload projection, so the prompt-cache prefix is
 * preserved). Returns null when nothing changed.
 *
 * Guardrails:
 * - Lines without the image marker (and empty lines) are copied byte-for-byte
 *   without parsing — text-only turns and no-image files are untouched.
 * - A line that fails to JSON.parse (e.g. a torn trailing write) is kept verbatim
 *   rather than dropped or throwing.
 * - Idempotent: a re-run finds only text placeholders and returns null.
 */
export function evictHistoryImagesFromTranscript(
  content: string,
): { content: string; imagesEvicted: number } | null {
  if (!content.includes(IMAGE_MARKER)) {
    return null;
  }
  const lines = content.split("\n");
  let imagesEvicted = 0;
  let changed = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.length === 0 || !line.includes(IMAGE_MARKER)) {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const evicted = evictImagesInEntry(entry);
    if (evicted > 0) {
      lines[i] = JSON.stringify(entry);
      imagesEvicted += evicted;
      changed = true;
    }
  }
  if (!changed) {
    return null;
  }
  return { content: lines.join("\n"), imagesEvicted };
}

/**
 * Evict history image base64 from a session transcript file in place, before
 * SessionManager.open reads it (so neither the resident branch index nor disk
 * retains the base64). Best-effort: any failure is logged and the run proceeds
 * with the un-evicted file (it is retried on the next load).
 *
 * Concurrency: the runner already holds this session's write lock across the
 * load path, so the read-modify-rename runs under a reentrant acquire of that
 * same lock (no self-deadlock; the outer critical section is preserved). When
 * invoked without an outer lock (standalone), it takes the lock itself so an
 * external writer cannot interleave a torn write.
 */
export async function evictHistoryImagesFromSessionFile(
  sessionFile: string,
): Promise<{ rewritten: boolean; imagesEvicted: number }> {
  const skipped = { rewritten: false, imagesEvicted: 0 };
  try {
    // Cheap unlocked pre-scan: skip the lock entirely for text-only / already-
    // evicted files. A torn read here only affects whether we bother locking.
    let raw: string;
    try {
      raw = await fs.readFile(sessionFile, "utf-8");
    } catch {
      return skipped; // no file yet — SessionManager will create it
    }
    if (!raw.includes(IMAGE_MARKER)) {
      return skipped;
    }

    // Reentrant acquire: the runner already holds this session's write lock
    // across the whole load path (attempt.ts:624 acquires it, and it is not
    // released until after the turn — well past this call). A non-reentrant
    // acquire would self-deadlock (same pid) and time out every image turn. The
    // lock is reference-counted (session-write-lock.ts:503-509 increments count;
    // releaseHeldLock:141-144 decrements and returns early while count>0 without
    // unlinking), so this inner release only decrements — the runner's outer
    // critical section is preserved. When the lock is NOT already held
    // (standalone/defensive), this performs a real acquire bounded by the
    // timeout.
    const lock = await acquireSessionWriteLock({
      sessionFile,
      timeoutMs: EVICT_LOCK_TIMEOUT_MS,
      allowReentrant: true,
    });
    try {
      const locked = await fs.readFile(sessionFile, "utf-8").catch(() => undefined);
      if (locked === undefined) {
        return skipped;
      }
      const result = evictHistoryImagesFromTranscript(locked);
      if (!result) {
        return skipped;
      }
      // Atomic replace (tmp + rename), preserving file mode. No local backup:
      // the MMS original is kept in the S3 media backup and the weekly full-store
      // S3 backup, so the transcript base64 is a third copy, safe to reclaim.
      const tmpPath = `${sessionFile}.evict-${process.pid}-${Date.now()}.tmp`;
      const stat = await fs.stat(sessionFile).catch(() => null);
      try {
        await fs.writeFile(tmpPath, result.content, "utf-8");
        if (stat) {
          await fs.chmod(tmpPath, stat.mode);
        }
        await fs.rename(tmpPath, sessionFile);
      } catch (err) {
        await fs.unlink(tmpPath).catch(() => undefined);
        throw err;
      }
      log.info(
        `[evict-transcript-images] evicted ${result.imagesEvicted} image(s) from ${sessionFile}`,
      );
      return { rewritten: true, imagesEvicted: result.imagesEvicted };
    } finally {
      await lock.release();
    }
  } catch (err) {
    log.warn(`[evict-transcript-images] ${sessionFile}: ${formatErrorMessage(err)}`);
    return skipped;
  }
}
