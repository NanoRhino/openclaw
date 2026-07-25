import type { MsgContext } from "../auto-reply/templating.js";
import type { GroupKeyResolution } from "../config/sessions/types.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import type { InboundLastRouteUpdate } from "./session.types.js";
export type { InboundLastRouteUpdate, RecordInboundSession } from "./session.types.js";

let inboundSessionRuntimePromise: Promise<
  typeof import("../config/sessions/inbound.runtime.js")
> | null = null;

function loadInboundSessionRuntime() {
  inboundSessionRuntimePromise ??= import("../config/sessions/inbound.runtime.js");
  return inboundSessionRuntimePromise;
}

function shouldSkipPinnedMainDmRouteUpdate(
  pin: InboundLastRouteUpdate["mainDmOwnerPin"] | undefined,
): boolean {
  if (!pin) {
    return false;
  }
  const owner = normalizeLowercaseStringOrEmpty(pin.ownerRecipient);
  const sender = normalizeLowercaseStringOrEmpty(pin.senderRecipient);
  if (!owner || !sender || owner === sender) {
    return false;
  }
  pin.onSkip?.({ ownerRecipient: pin.ownerRecipient, senderRecipient: pin.senderRecipient });
  return true;
}

export async function recordInboundSession(params: {
  storePath: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
  updateLastRoute?: InboundLastRouteUpdate;
  onRecordError: (err: unknown) => void;
}): Promise<void> {
  const { storePath, sessionKey, ctx, groupResolution, createIfMissing } = params;
  const canonicalSessionKey = normalizeLowercaseStringOrEmpty(sessionKey);
  const runtime = await loadInboundSessionRuntime();
  // Deliberate: the meta write and the last-route write are kept as two separate
  // store transactions and NOT coalesced into one. Once the store is slimmed
  // (cron-entry prune + skillsSnapshot dedup) each write is ~1-3ms on a
  // ~100-150KB store, so merging them saves almost nothing — while coalescing
  // would entangle the fire-and-forget meta write with the awaited route write
  // and force one path to cover the case where the route targets a DIFFERENT
  // session key than canonicalSessionKey (main-DM owner pin). Not worth changing
  // inbound timing semantics on the money path for a sub-millisecond gain.
  void runtime
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: canonicalSessionKey,
      ctx,
      groupResolution,
      createIfMissing,
    })
    .catch(params.onRecordError);

  const update = params.updateLastRoute;
  if (!update) {
    return;
  }
  if (shouldSkipPinnedMainDmRouteUpdate(update.mainDmOwnerPin)) {
    return;
  }
  const targetSessionKey = normalizeLowercaseStringOrEmpty(update.sessionKey);
  await runtime.updateLastRoute({
    storePath,
    sessionKey: targetSessionKey,
    deliveryContext: {
      channel: update.channel,
      to: update.to,
      accountId: update.accountId,
      threadId: update.threadId,
    },
    // Avoid leaking inbound origin metadata into a different target session.
    ctx: targetSessionKey === canonicalSessionKey ? ctx : undefined,
    groupResolution,
  });
}
