import fs from "node:fs";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import type { MsgContext } from "./templating.js";

function sanitizeInlineMediaNoteValue(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed
    .replace(/[\p{Cc}\]]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatMediaAttachedLine(params: {
  path: string;
  url?: string;
  type?: string;
  index?: number;
  total?: number;
}): string {
  const prefix =
    typeof params.index === "number" && typeof params.total === "number"
      ? `[media attached ${params.index}/${params.total}: `
      : "[media attached: ";
  const path = sanitizeInlineMediaNoteValue(params.path);
  const typeRaw = sanitizeInlineMediaNoteValue(params.type);
  const typePart = typeRaw ? ` (${typeRaw})` : "";
  const urlRaw = sanitizeInlineMediaNoteValue(params.url);
  const urlPart = urlRaw ? ` | ${urlRaw}` : "";
  return `${prefix}${path}${typePart}${urlPart}]`;
}

// Common audio file extensions for transcription detection
const AUDIO_EXTENSIONS = new Set([
  ".ogg",
  ".opus",
  ".mp3",
  ".m4a",
  ".wav",
  ".webm",
  ".flac",
  ".aac",
  ".wma",
  ".aiff",
  ".alac",
  ".oga",
]);

function isAudioPath(path: string | undefined): boolean {
  if (!path) {
    return false;
  }
  const lower = normalizeLowercaseStringOrEmpty(path);
  for (const ext of AUDIO_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      return true;
    }
  }
  return false;
}

function isValidAttachmentIndex(index: number, attachmentCount: number): boolean {
  return Number.isSafeInteger(index) && index >= 0 && index < attachmentCount;
}

function collectTranscribedAudioAttachmentIndices(
  ctx: MsgContext,
  attachmentCount: number,
): Set<number> {
  // Only audio transcription should suppress the raw attachment in prompt notes.
  // Image/video descriptions are lossy derived context, so the original attachment
  // must stay available to multimodal models and downstream tools.
  const transcribedAudioIndices = new Set<number>();
  if (Array.isArray(ctx.MediaUnderstanding)) {
    for (const output of ctx.MediaUnderstanding) {
      if (
        output.kind === "audio.transcription" &&
        isValidAttachmentIndex(output.attachmentIndex, attachmentCount)
      ) {
        transcribedAudioIndices.add(output.attachmentIndex);
      }
    }
  }
  if (Array.isArray(ctx.MediaUnderstandingDecisions)) {
    for (const decision of ctx.MediaUnderstandingDecisions) {
      if (decision.capability !== "audio" || decision.outcome !== "success") {
        continue;
      }
      for (const attachment of decision.attachments) {
        if (
          attachment.chosen?.outcome === "success" &&
          isValidAttachmentIndex(attachment.attachmentIndex, attachmentCount)
        ) {
          transcribedAudioIndices.add(attachment.attachmentIndex);
        }
      }
    }
  }
  return transcribedAudioIndices;
}

export function buildInboundMediaNote(ctx: MsgContext): string | undefined {
  // Attachment indices follow MediaPaths/MediaUrls ordering as supplied by the channel.
  const pathsFromArray = Array.isArray(ctx.MediaPaths) ? ctx.MediaPaths : undefined;
  const paths =
    pathsFromArray && pathsFromArray.length > 0
      ? pathsFromArray
      : ctx.MediaPath?.trim()
        ? [ctx.MediaPath.trim()]
        : [];
  if (paths.length === 0) {
    return undefined;
  }

  const transcribedAudioIndices = collectTranscribedAudioAttachmentIndices(ctx, paths.length);

  const urls =
    Array.isArray(ctx.MediaUrls) && ctx.MediaUrls.length === paths.length
      ? ctx.MediaUrls
      : undefined;
  const types =
    Array.isArray(ctx.MediaTypes) && ctx.MediaTypes.length === paths.length
      ? ctx.MediaTypes
      : undefined;
  const hasTranscript = Boolean(ctx.Transcript?.trim());
  // Transcript alone does not identify an attachment index; only use it as a fallback
  // when there is a single attachment to avoid stripping unrelated audio files.
  const canStripSingleAttachmentByTranscript = hasTranscript && paths.length === 1;

  const entries = paths
    .map((entry, index) => ({
      path: entry ?? "",
      type: types?.[index] ?? ctx.MediaType,
      url: urls?.[index] ?? ctx.MediaUrl,
      index,
    }))
    .filter((entry) => {
      // Strip audio attachments when transcription succeeded - the transcript is already
      // available in the context, raw audio binary would only waste tokens (issue #4197)
      // Note: Only trust MIME type from per-entry types array, not fallback ctx.MediaType
      // which could misclassify non-audio attachments (greptile review feedback)
      const hasPerEntryType = types !== undefined;
      const isAudioByMime =
        hasPerEntryType && normalizeLowercaseStringOrEmpty(entry.type).startsWith("audio/");
      const isAudioEntry = isAudioPath(entry.path) || isAudioByMime;
      if (!isAudioEntry) {
        return true;
      }
      if (
        transcribedAudioIndices.has(entry.index) ||
        (canStripSingleAttachmentByTranscript && entry.index === 0)
      ) {
        return false;
      }
      return true;
    });
  if (entries.length === 0) {
    return undefined;
  }
  if (entries.length === 1) {
    return formatMediaAttachedLine({
      path: entries[0]?.path ?? "",
      type: entries[0]?.type,
      url: entries[0]?.url,
    });
  }

  const count = entries.length;
  const lines: string[] = [`[media attached: ${count} files]`];
  for (const [idx, entry] of entries.entries()) {
    lines.push(
      formatMediaAttachedLine({
        path: entry.path,
        index: idx + 1,
        total: count,
        type: entry.type,
        url: entry.url,
      }),
    );
  }
  return lines.join("\n");
}

// ─── human-handoff: pending media injection ────────────────────────────────
// 工作台/人工模式期间 wechat 插件下载的图片,写进 workspace/data/pending-handoff-images.json
// (schema: {"images":[{"path":"/...","mime":"image/png"}, ...]}),用户切回机器模式后
// 第一条消息进 agent 时,prompt-prelude 调本函数把这些图也拼成 [media attached: ...]
// 注入 prompt,让 openclaw 框架的 detectImageReferences 当作"用户当轮发图"自动加载。
// 文件名前缀 "[Handoff·attached image from coach: ...]" 让 agent 知道这是教练之前发的、
// 不是用户当轮上传的。注入即消费,文件改成空 images 数组(保留外壳,简化删除竞态)。

const PENDING_HANDOFF_FILE = "data/pending-handoff-images.json";

export type PendingHandoffImage = { path: string; mime?: string };

export function readPendingHandoffImages(workspaceDir: string | undefined): PendingHandoffImage[] {
  if (!workspaceDir || !workspaceDir.trim()) return [];
  const file = path.join(workspaceDir, PENDING_HANDOFF_FILE);
  try {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as { images?: unknown };
    if (!Array.isArray(parsed.images)) return [];
    return parsed.images
      .map((e) => {
        if (!e || typeof e !== "object") return undefined;
        const p = (e as { path?: unknown }).path;
        const m = (e as { mime?: unknown }).mime;
        if (typeof p !== "string" || !p.trim()) return undefined;
        return { path: p.trim(), mime: typeof m === "string" ? m.trim() : undefined };
      })
      .filter((e): e is PendingHandoffImage => Boolean(e));
  } catch {
    return [];
  }
}

export function clearPendingHandoffImages(workspaceDir: string | undefined): void {
  if (!workspaceDir || !workspaceDir.trim()) return;
  const file = path.join(workspaceDir, PENDING_HANDOFF_FILE);
  try {
    if (!fs.existsSync(file)) return;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ images: [] }, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    /* best-effort */
  }
}

/**
 * Returns a `[Handoff·attached image from coach: <path> (<mime>) | <path>]` block
 * (one line per image) if the workspace has any pending handoff images, else undefined.
 * The marker still matches openclaw's `[media attached: ...]` detector via the inner
 * "attached image from coach: " pattern; we use the "Handoff·" prefix so the agent's
 * text-side reading knows the image came from the human coach during the handoff,
 * not from the user this turn.
 */
export function buildPendingHandoffMediaNote(
  workspaceDir: string | undefined,
): string | undefined {
  const pending = readPendingHandoffImages(workspaceDir);
  if (pending.length === 0) return undefined;
  // 复用 formatMediaAttachedLine,但 prefix 改为 Handoff;detectImageReferences 仍能识别
  // (它的正则 `\[media attached:` 在 pi-embedded-runner/run/images.ts 已被 detect)。
  // 为兼容,直接用同款 [media attached: ...] 格式,在前面单独加一行 context 说明来源。
  const count = pending.length;
  const header =
    count === 1
      ? "[Handoff context: 1 image from your human coach (delivered earlier during handoff)]"
      : `[Handoff context: ${count} images from your human coach (delivered earlier during handoff)]`;
  const lines = [header];
  for (const img of pending) {
    lines.push(
      formatMediaAttachedLine({
        path: img.path,
        type: img.mime ?? "image/png",
        url: img.path,
      }),
    );
  }
  return lines.join("\n");
}
