/**
 * Pre-serialization bounding for trajectory runtime event payloads.
 *
 * Several runtime events embed the full message transcript: `context.compiled`
 * and `prompt.submitted` carry `messages`, and `model.completed` carries
 * `messagesSnapshot`. For large sessions that transcript is multiple megabytes.
 * The recorder used to deep-clone the whole payload (via sanitizeDiagnosticPayload)
 * and fully JSON.stringify the event *before* a post-hoc size check discarded the
 * oversized line — allocating those megabytes twice per event, several events per
 * turn, under concurrency. That transient allocation churn was the leading suspect
 * for the dinner-peak GC storms.
 *
 * This module bounds oversized fields *before* the clone/stringify: any top-level
 * field whose estimated serialized size exceeds a budget is replaced with a compact
 * digest (kind + count/length + a bounded head/tail preview + approximate bytes).
 * Payloads that fit within budget are returned untouched by reference, so on-disk
 * output for the common case is byte-for-byte identical. The size estimate is an
 * early-exiting walk, so a 5 MB field costs at most ~budget bytes of traversal
 * rather than a full serialization.
 *
 * The recorder keeps its post-hoc truncation as a final safety net for pathological
 * payloads (e.g. many medium fields summing past the cap); this pass only removes
 * the megabyte transients from the common whale-transcript path.
 */

// Both budgets sit below the 256 KB per-event cap so a digested event clears it
// with headroom for the event envelope. The byte estimate counts UTF-16 code
// units for strings, so heavily non-ASCII payloads are under-counted; the
// recorder's post-hoc byte check is the authoritative backstop in that case.
const DEFAULT_DATA_BUDGET_BYTES = 200 * 1024;
const DEFAULT_FIELD_BUDGET_BYTES = 64 * 1024;
const PREVIEW_MAX_STRING = 200;
const PREVIEW_MAX_TOTAL = 1024;
const PREVIEW_MAX_DEPTH = 4;

export type TrajectoryFieldDigest = {
  __trajectoryDigest: true;
  kind: "array" | "string" | "object" | "other";
  approxBytes: number;
  /** True when the estimate stopped early at the budget, so approxBytes is a lower bound. */
  truncatedEstimate: boolean;
  length?: number;
  head?: unknown;
  tail?: unknown;
  preview?: unknown;
};

export type BoundTrajectoryEventDataOptions = {
  dataBudgetBytes?: number;
  fieldBudgetBytes?: number;
};

/**
 * Estimate the JSON-serialized byte size of a value, stopping as soon as the
 * running total exceeds `budget`. Returns the accumulated total and whether the
 * budget was exceeded. The walk is iterative and refuses to enqueue the children
 * of a container once the budget is already blown, so peak memory stays bounded
 * even for pathologically large flat arrays.
 */
export function estimateJsonBytes(
  value: unknown,
  budget: number,
): { bytes: number; exceeded: boolean } {
  let total = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    if (total > budget) {
      return { bytes: total, exceeded: true };
    }
    const current = stack.pop();
    if (current === null || current === undefined) {
      total += 4; // "null"
      continue;
    }
    const type = typeof current;
    if (type === "string") {
      total += (current as string).length + 2;
      continue;
    }
    if (type === "number") {
      total += 12;
      continue;
    }
    if (type === "boolean") {
      total += 5;
      continue;
    }
    if (type === "bigint") {
      total += (current as bigint).toString().length + 2;
      continue;
    }
    if (type === "function") {
      total += 12; // "[Function]"
      continue;
    }
    if (current instanceof Uint8Array) {
      // safeJsonStringify encodes byte arrays as base64 strings (~4/3 expansion).
      total += Math.ceil((current.length * 4) / 3) + 24;
      continue;
    }
    if (current instanceof Error) {
      total += (current.message?.length ?? 0) + (current.stack?.length ?? 0) + 40;
      continue;
    }
    if (Array.isArray(current)) {
      total += 2 + current.length; // brackets + separators
      if (total > budget) {
        continue; // already over; do not enqueue children
      }
      for (const item of current) {
        stack.push(item);
      }
      continue;
    }
    if (type === "object") {
      for (const [key, val] of Object.entries(current as Record<string, unknown>)) {
        total += key.length + 4; // "key":,
        if (total > budget) {
          break; // already over; stop enqueuing
        }
        stack.push(val);
      }
      continue;
    }
    total += 4;
  }
  return { bytes: total, exceeded: total > budget };
}

function previewWalk(value: unknown, ctx: { remaining: number }, depth: number): unknown {
  if (ctx.remaining <= 0 || depth > PREVIEW_MAX_DEPTH) {
    return "…";
  }
  if (value === null || value === undefined) {
    ctx.remaining -= 4;
    return null;
  }
  const type = typeof value;
  if (type === "string") {
    const str = value as string;
    const clipped = str.length > PREVIEW_MAX_STRING ? `${str.slice(0, PREVIEW_MAX_STRING)}…` : str;
    ctx.remaining -= clipped.length;
    return clipped;
  }
  if (type === "number" || type === "boolean") {
    ctx.remaining -= 6;
    return value;
  }
  if (type === "bigint") {
    ctx.remaining -= 8;
    return (value as bigint).toString();
  }
  if (value instanceof Uint8Array) {
    ctx.remaining -= 16;
    return `[bytes:${value.length}]`;
  }
  if (value instanceof Error) {
    ctx.remaining -= 24;
    return `[Error:${value.name}]`;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      if (ctx.remaining <= 0) {
        out.push("…");
        break;
      }
      out.push(previewWalk(item, ctx, depth + 1));
    }
    return out;
  }
  if (type === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (ctx.remaining <= 0) {
        out["…"] = "…";
        break;
      }
      ctx.remaining -= key.length;
      out[key] = previewWalk(val, ctx, depth + 1);
    }
    return out;
  }
  ctx.remaining -= 4;
  return null;
}

/** Produce a small, structurally-similar, size-capped preview of a value. */
function boundedPreview(value: unknown): unknown {
  return previewWalk(value, { remaining: PREVIEW_MAX_TOTAL }, 0);
}

function digestOversizedValue(
  value: unknown,
  estimate: { bytes: number; exceeded: boolean },
): TrajectoryFieldDigest {
  const approxBytes = estimate.bytes;
  const truncatedEstimate = estimate.exceeded;
  if (Array.isArray(value)) {
    return {
      __trajectoryDigest: true,
      kind: "array",
      length: value.length,
      approxBytes,
      truncatedEstimate,
      head: value.length > 0 ? boundedPreview(value[0]) : undefined,
      tail: value.length > 1 ? boundedPreview(value[value.length - 1]) : undefined,
    };
  }
  if (typeof value === "string") {
    return {
      __trajectoryDigest: true,
      kind: "string",
      length: value.length,
      approxBytes,
      truncatedEstimate,
      preview: boundedPreview(value),
    };
  }
  if (value && typeof value === "object") {
    return {
      __trajectoryDigest: true,
      kind: "object",
      length: Object.keys(value as Record<string, unknown>).length,
      approxBytes,
      truncatedEstimate,
      preview: boundedPreview(value),
    };
  }
  return { __trajectoryDigest: true, kind: "other", approxBytes, truncatedEstimate };
}

/**
 * Replace oversized top-level fields of a trajectory event payload with compact
 * digests, before the payload is cloned and serialized. Payloads whose whole
 * estimated size is within `dataBudgetBytes` are returned unchanged by reference.
 */
export function boundTrajectoryEventData(
  data: Record<string, unknown>,
  opts?: BoundTrajectoryEventDataOptions,
): Record<string, unknown> {
  const dataBudget = opts?.dataBudgetBytes ?? DEFAULT_DATA_BUDGET_BYTES;
  const fieldBudget = opts?.fieldBudgetBytes ?? DEFAULT_FIELD_BUDGET_BYTES;

  if (!estimateJsonBytes(data, dataBudget).exceeded) {
    return data;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const estimate = estimateJsonBytes(value, fieldBudget);
    out[key] = estimate.exceeded ? digestOversizedValue(value, estimate) : value;
  }
  return out;
}
