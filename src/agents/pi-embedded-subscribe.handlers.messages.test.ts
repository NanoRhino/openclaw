import { describe, expect, it, vi } from "vitest";
import { createStreamingDirectiveAccumulator } from "../auto-reply/reply/streaming-directives.js";
import { createInlineCodeState } from "../markdown/code-spans.js";
import {
  buildAssistantStreamData,
  consumePendingAssistantReplyDirectivesIntoReply,
  consumePendingToolMediaIntoReply,
  consumePendingToolMediaReply,
  handleMessageEnd,
  handleMessageUpdate,
  hasAssistantVisibleReply,
  recordPendingAssistantReplyDirectives,
  resolveSilentReplyFallbackText,
} from "./pi-embedded-subscribe.handlers.messages.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import {
  createOpenAiResponsesPartial,
  createOpenAiResponsesTextBlock,
  createOpenAiResponsesTextEvent as createTextUpdateEvent,
} from "./pi-embedded-subscribe.openai-responses.test-helpers.js";

function createMessageUpdateContext(
  params: {
    onAgentEvent?: ReturnType<typeof vi.fn>;
    onPartialReply?: ReturnType<typeof vi.fn>;
    flushBlockReplyBuffer?: ReturnType<typeof vi.fn>;
    resetAssistantMessageState?: ReturnType<typeof vi.fn>;
    debug?: ReturnType<typeof vi.fn>;
    shouldEmitPartialReplies?: boolean;
    consumePartialReplyDirectives?: ReturnType<typeof vi.fn>;
    state?: Record<string, unknown>;
  } = {},
) {
  return {
    params: {
      runId: "run-1",
      session: { id: "session-1" },
      ...(params.onAgentEvent ? { onAgentEvent: params.onAgentEvent } : {}),
      ...(params.onPartialReply ? { onPartialReply: params.onPartialReply } : {}),
    },
    state: {
      deterministicApprovalPromptPending: false,
      deterministicApprovalPromptSent: false,
      reasoningStreamOpen: false,
      streamReasoning: false,
      deltaBuffer: "",
      blockBuffer: "",
      partialBlockState: {
        thinking: false,
        final: false,
        inlineCode: createInlineCodeState(),
      },
      lastStreamedAssistant: undefined,
      lastStreamedAssistantCleaned: undefined,
      emittedAssistantUpdate: false,
      shouldEmitPartialReplies: params.shouldEmitPartialReplies ?? true,
      blockReplyBreak: "text_end",
      assistantMessageIndex: 0,
      lastAssistantStreamItemId: undefined,
      assistantTexts: [],
      pendingAssistantReplyDirectives: undefined,
      ...params.state,
    },
    log: { debug: params.debug ?? vi.fn() },
    noteLastAssistant: vi.fn(),
    stripBlockTags: (text: string) => text,
    consumePartialReplyDirectives: params.consumePartialReplyDirectives ?? vi.fn(() => null),
    emitReasoningStream: vi.fn(),
    flushBlockReplyBuffer: params.flushBlockReplyBuffer ?? vi.fn(),
    resetAssistantMessageState: params.resetAssistantMessageState ?? vi.fn(),
    recordAssistantUsage: vi.fn(),
    commitAssistantUsage: vi.fn(),
  } as unknown as EmbeddedPiSubscribeContext;
}

function createMessageEndContext(
  params: {
    onAgentEvent?: ReturnType<typeof vi.fn>;
    onBlockReply?: ReturnType<typeof vi.fn>;
    emitBlockReply?: ReturnType<typeof vi.fn>;
    finalizeAssistantTexts?: ReturnType<typeof vi.fn>;
    consumeReplyDirectives?: ReturnType<typeof vi.fn>;
    state?: Record<string, unknown>;
  } = {},
) {
  return {
    params: {
      runId: "run-1",
      session: { id: "session-1" },
      ...(params.onAgentEvent ? { onAgentEvent: params.onAgentEvent } : {}),
      ...(params.onBlockReply ? { onBlockReply: params.onBlockReply } : { onBlockReply: vi.fn() }),
    },
    state: {
      assistantTexts: [],
      assistantTextBaseline: 0,
      emittedAssistantUpdate: false,
      deterministicApprovalPromptPending: false,
      deterministicApprovalPromptSent: false,
      messagingToolSentTexts: [],
      messagingToolSentTextsNormalized: [],
      includeReasoning: false,
      streamReasoning: false,
      blockReplyBreak: "message_end",
      deltaBuffer: "Need send.",
      blockBuffer: "Need send.",
      blockState: {
        thinking: false,
        final: false,
        inlineCode: createInlineCodeState(),
      },
      lastStreamedAssistant: undefined,
      lastStreamedAssistantCleaned: undefined,
      lastReasoningSent: undefined,
      reasoningStreamOpen: false,
      ...params.state,
    },
    noteLastAssistant: vi.fn(),
    recordAssistantUsage: vi.fn(),
    commitAssistantUsage: vi.fn(),
    log: { debug: vi.fn(), warn: vi.fn() },
    stripBlockTags: (text: string) => text,
    finalizeAssistantTexts: params.finalizeAssistantTexts ?? vi.fn(),
    emitBlockReply: params.emitBlockReply ?? vi.fn(),
    consumeReplyDirectives: params.consumeReplyDirectives ?? vi.fn(() => ({ text: "Need send." })),
    emitReasoningStream: vi.fn(),
    flushBlockReplyBuffer: vi.fn(),
    blockChunker: null,
  } as unknown as EmbeddedPiSubscribeContext;
}

describe("resolveSilentReplyFallbackText", () => {
  it("replaces NO_REPLY with latest messaging tool text when available", () => {
    expect(
      resolveSilentReplyFallbackText({
        text: "NO_REPLY",
        messagingToolSentTexts: ["first", "final delivered text"],
      }),
    ).toBe("final delivered text");
  });

  it("keeps original text when response is not NO_REPLY", () => {
    expect(
      resolveSilentReplyFallbackText({
        text: "normal assistant reply",
        messagingToolSentTexts: ["final delivered text"],
      }),
    ).toBe("normal assistant reply");
  });

  it("keeps NO_REPLY when there is no messaging tool text to mirror", () => {
    expect(
      resolveSilentReplyFallbackText({
        text: "NO_REPLY",
        messagingToolSentTexts: [],
      }),
    ).toBe("NO_REPLY");
  });

  it("tolerates malformed text payloads without throwing", () => {
    expect(
      resolveSilentReplyFallbackText({
        text: undefined,
        messagingToolSentTexts: ["final delivered text"],
      }),
    ).toBe("");
    expect(
      resolveSilentReplyFallbackText({
        text: "NO_REPLY",
        messagingToolSentTexts: [42 as unknown as string],
      }),
    ).toBe("42");
  });
});

describe("hasAssistantVisibleReply", () => {
  it("treats audio-only payloads as visible", () => {
    expect(hasAssistantVisibleReply({ audioAsVoice: true })).toBe(true);
  });

  it("detects text or media visibility", () => {
    expect(hasAssistantVisibleReply({ text: "hello" })).toBe(true);
    expect(hasAssistantVisibleReply({ mediaUrls: ["https://example.com/a.png"] })).toBe(true);
    expect(hasAssistantVisibleReply({})).toBe(false);
  });
});

describe("buildAssistantStreamData", () => {
  it("normalizes media payloads for assistant stream events", () => {
    expect(
      buildAssistantStreamData({
        text: "hello",
        delta: "he",
        replace: true,
        mediaUrl: "https://example.com/a.png",
        phase: "final_answer",
      }),
    ).toEqual({
      text: "hello",
      delta: "he",
      replace: true,
      mediaUrls: ["https://example.com/a.png"],
      phase: "final_answer",
    });
  });
});

describe("pending assistant reply directives", () => {
  it("merges directive metadata into the next non-reasoning block reply", () => {
    const state = { pendingAssistantReplyDirectives: undefined };

    recordPendingAssistantReplyDirectives(state, {
      text: "",
      mediaUrls: ["/tmp/reply.ogg"],
      replyToCurrent: true,
      replyToTag: true,
      audioAsVoice: true,
      isSilent: false,
    });

    expect(
      consumePendingAssistantReplyDirectivesIntoReply(state, {
        text: "Done.",
      }),
    ).toEqual({
      text: "Done.",
      mediaUrls: ["/tmp/reply.ogg"],
      audioAsVoice: true,
      replyToId: undefined,
      replyToTag: true,
      replyToCurrent: true,
    });
    expect(state.pendingAssistantReplyDirectives).toBeUndefined();
  });

  it("does not consume pending directive metadata on reasoning replies", () => {
    const state = {
      pendingAssistantReplyDirectives: {
        mediaUrls: ["/tmp/reply.png"],
      },
    };

    expect(
      consumePendingAssistantReplyDirectivesIntoReply(state, {
        text: "Thinking...",
        isReasoning: true,
      }),
    ).toEqual({
      text: "Thinking...",
      isReasoning: true,
    });
    expect(state.pendingAssistantReplyDirectives?.mediaUrls).toEqual(["/tmp/reply.png"]);
  });
});

describe("handleMessageUpdate", () => {
  it("treats phased textSignature item changes as assistant-message boundaries", () => {
    const flushBlockReplyBuffer = vi.fn();
    const resetAssistantMessageState = vi.fn();
    const onAssistantMessageStart = vi.fn();
    const context = createMessageUpdateContext({
      flushBlockReplyBuffer,
      resetAssistantMessageState,
    });
    context.params.onAssistantMessageStart = onAssistantMessageStart;
    context.state.lastAssistantStreamItemId = "item-1";
    context.state.assistantMessageIndex = 7;

    handleMessageUpdate(context, {
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 1,
        delta: "Second block",
        partial: {
          role: "assistant",
          phase: "final_answer",
          content: [
            createOpenAiResponsesTextBlock({
              text: "First block",
              id: "item-1",
              phase: "final_answer",
            }),
            createOpenAiResponsesTextBlock({
              text: "Second block",
              id: "item-2",
              phase: "final_answer",
            }),
          ],
          stopReason: "stop",
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.2",
          usage: {},
          timestamp: 0,
        },
      },
    } as never);

    expect(flushBlockReplyBuffer).toHaveBeenCalledWith({ assistantMessageIndex: 7 });
    expect(resetAssistantMessageState).toHaveBeenCalledWith(0);
    expect(onAssistantMessageStart).toHaveBeenCalledTimes(1);
    expect(context.state.lastAssistantStreamItemId).toBe("item-2");
  });

  it("preserves phase-aware media, voice, and reply directives for block delivery", () => {
    const accumulator = createStreamingDirectiveAccumulator();
    const ctx = createMessageUpdateContext({
      consumePartialReplyDirectives: vi.fn((text: string, options?: { final?: boolean }) =>
        accumulator.consume(text, options),
      ),
      state: {
        blockReplyBreak: "message_end",
      },
    });
    const replyText = "Done.\n\n[[reply_to_current]]\n[[audio_as_voice]]\nMEDIA:/tmp/reply.ogg";

    handleMessageUpdate(
      ctx,
      createTextUpdateEvent({
        type: "text_delta",
        text: replyText,
        id: "item-final",
        signaturePhase: "final_answer",
        partialPhase: "final_answer",
      }),
    );
    handleMessageUpdate(
      ctx,
      createTextUpdateEvent({
        type: "text_end",
        text: replyText,
        id: "item-final",
        signaturePhase: "final_answer",
        partialPhase: "final_answer",
      }),
    );

    expect(ctx.state.blockBuffer).toBe("Done.");
    expect(
      consumePendingAssistantReplyDirectivesIntoReply(ctx.state, {
        text: "Done.",
      }),
    ).toEqual({
      text: "Done.",
      mediaUrls: ["/tmp/reply.ogg"],
      audioAsVoice: true,
      replyToId: undefined,
      replyToTag: true,
      replyToCurrent: true,
    });
  });
});

describe("consumePendingToolMediaIntoReply", () => {
  it("attaches queued tool media to the next assistant reply", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/a.png", "/tmp/b.png"],
      pendingToolAudioAsVoice: false,
      pendingToolTrustedLocalMedia: false,
    };

    expect(
      consumePendingToolMediaIntoReply(state, {
        text: "done",
      }),
    ).toEqual({
      text: "done",
      mediaUrls: ["/tmp/a.png", "/tmp/b.png"],
      audioAsVoice: undefined,
    });
    expect(state.pendingToolMediaUrls).toEqual([]);
  });

  it("preserves reasoning replies without consuming queued media", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/a.png"],
      pendingToolAudioAsVoice: true,
      pendingToolTrustedLocalMedia: false,
    };

    expect(
      consumePendingToolMediaIntoReply(state, {
        text: "thinking",
        isReasoning: true,
      }),
    ).toEqual({
      text: "thinking",
      isReasoning: true,
    });
    expect(state.pendingToolMediaUrls).toEqual(["/tmp/a.png"]);
    expect(state.pendingToolAudioAsVoice).toBe(true);
  });
});

describe("consumePendingToolMediaReply", () => {
  it("builds a media-only reply for orphaned tool media", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/reply.opus"],
      pendingToolAudioAsVoice: true,
      pendingToolTrustedLocalMedia: false,
    };

    expect(consumePendingToolMediaReply(state)).toEqual({
      mediaUrls: ["/tmp/reply.opus"],
      audioAsVoice: true,
    });
    expect(state.pendingToolMediaUrls).toEqual([]);
    expect(state.pendingToolAudioAsVoice).toBe(false);
  });
});

describe("handleMessageUpdate", () => {
  it("suppresses commentary-phase partial delivery and text_end flush", async () => {
    const onAgentEvent = vi.fn();
    const onPartialReply = vi.fn();
    const flushBlockReplyBuffer = vi.fn();
    const ctx = createMessageUpdateContext({
      onAgentEvent,
      onPartialReply,
      flushBlockReplyBuffer,
    });

    handleMessageUpdate(
      ctx,
      createTextUpdateEvent({ type: "text_delta", text: "Need send.", messagePhase: "commentary" }),
    );
    handleMessageUpdate(
      ctx,
      createTextUpdateEvent({ type: "text_end", text: "Need send.", messagePhase: "commentary" }),
    );

    await Promise.resolve();

    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(flushBlockReplyBuffer).not.toHaveBeenCalled();
  });

  it("suppresses commentary partials when phase exists only in textSignature metadata", async () => {
    const onAgentEvent = vi.fn();
    const onPartialReply = vi.fn();
    const flushBlockReplyBuffer = vi.fn();
    const commentaryBlock = createOpenAiResponsesTextBlock({
      text: "Need send.",
      id: "msg_sig",
      phase: "commentary",
    });
    const ctx = createMessageUpdateContext({
      onAgentEvent,
      onPartialReply,
      flushBlockReplyBuffer,
    });

    handleMessageUpdate(
      ctx,
      createTextUpdateEvent({
        type: "text_delta",
        text: "Need send.",
        content: [commentaryBlock],
      }),
    );
    handleMessageUpdate(
      ctx,
      createTextUpdateEvent({
        type: "text_end",
        text: "Need send.",
        content: [commentaryBlock],
      }),
    );

    await Promise.resolve();

    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(flushBlockReplyBuffer).not.toHaveBeenCalled();
    expect(ctx.state.deltaBuffer).toBe("");
    expect(ctx.state.blockBuffer).toBe("");
  });

  it("suppresses commentary partials even when they contain visible text", () => {
    const onAgentEvent = vi.fn();
    const ctx = createMessageUpdateContext({
      onAgentEvent,
      shouldEmitPartialReplies: false,
    });

    handleMessageUpdate(
      ctx,
      createTextUpdateEvent({
        type: "text_delta",
        text: "Working...",
        partial: createOpenAiResponsesPartial({
          text: "Working...",
          id: "item_commentary",
          signaturePhase: "commentary",
          partialPhase: "commentary",
        }),
      }),
    );

    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(ctx.state.deltaBuffer).toBe("");
    expect(ctx.state.blockBuffer).toBe("");

    handleMessageUpdate(
      ctx,
      createTextUpdateEvent({
        type: "text_delta",
        text: "Done.",
        partial: createOpenAiResponsesPartial({
          text: "Done.",
          id: "item_final",
          signaturePhase: "final_answer",
          partialPhase: "final_answer",
        }),
      }),
    );

    expect(onAgentEvent).toHaveBeenCalledTimes(1);
    expect(onAgentEvent.mock.calls[0]?.[0]).toMatchObject({
      stream: "assistant",
      data: {
        text: "Done.",
        delta: "Done.",
      },
    });
  });

  it("contains synchronous text_end flush failures", async () => {
    const debug = vi.fn();
    const ctx = createMessageUpdateContext({
      debug,
      shouldEmitPartialReplies: false,
      flushBlockReplyBuffer: vi.fn(() => {
        throw new Error("boom");
      }),
    });

    handleMessageUpdate(ctx, createTextUpdateEvent({ type: "text_end", text: "" }));

    await vi.waitFor(() => {
      expect(debug).toHaveBeenCalledWith("text_end block reply flush failed: Error: boom");
    });
  });
});

describe("handleMessageEnd", () => {
  it("suppresses commentary-phase replies from user-visible output", () => {
    const onAgentEvent = vi.fn();
    const emitBlockReply = vi.fn();
    const finalizeAssistantTexts = vi.fn();
    const ctx = createMessageEndContext({
      onAgentEvent,
      finalizeAssistantTexts,
      emitBlockReply,
    });

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        phase: "commentary",
        content: [{ type: "text", text: "Need send." }],
        usage: { input: 1, output: 1, total: 2 },
      },
    } as never);

    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(emitBlockReply).not.toHaveBeenCalled();
    expect(finalizeAssistantTexts).not.toHaveBeenCalled();
  });

  it("suppresses commentary message_end when phase exists only in textSignature metadata", () => {
    const onAgentEvent = vi.fn();
    const emitBlockReply = vi.fn();
    const finalizeAssistantTexts = vi.fn();
    const ctx = createMessageEndContext({
      onAgentEvent,
      finalizeAssistantTexts,
      emitBlockReply,
    });

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          createOpenAiResponsesTextBlock({
            text: "Need send.",
            id: "msg_sig",
            phase: "commentary",
          }),
        ],
        usage: { input: 1, output: 1, total: 2 },
      },
    } as never);

    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(emitBlockReply).not.toHaveBeenCalled();
    expect(finalizeAssistantTexts).not.toHaveBeenCalled();
  });

  it("does not duplicate block reply for text_end channels when text was already delivered", () => {
    const onBlockReply = vi.fn();
    const emitBlockReply = vi.fn();
    // In real usage, the directive accumulator returns null for empty/consumed
    // input. The non-empty call shouldn't happen for text_end channels (that's
    // the safety send we're guarding against).
    const consumeReplyDirectives = vi.fn((text: string) => (text ? { text } : null));
    const ctx = createMessageEndContext({
      onBlockReply,
      emitBlockReply,
      consumeReplyDirectives,
      state: {
        emittedAssistantUpdate: true,
        lastStreamedAssistantCleaned: "Hello world",
        blockReplyBreak: "text_end",
        // Simulate text_end already delivered this text through emitBlockChunk
        lastBlockReplyText: "Hello world",
        deltaBuffer: "",
        blockBuffer: "",
      },
    });

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
        usage: { input: 10, output: 5, total: 15 },
      },
    } as never);

    // The block reply should NOT fire again since text_end already delivered it.
    // consumeReplyDirectives is called once with "" (the final flush for
    // text_end channels) but returns null, so emitBlockReply is never called.
    expect(emitBlockReply).not.toHaveBeenCalled();
  });

  it("does not duplicate block reply for text_end channels even when stripping differs", () => {
    const onBlockReply = vi.fn();
    const emitBlockReply = vi.fn();
    // Same pattern: directive accumulator returns null for empty final flush
    const consumeReplyDirectives = vi.fn((text: string) => (text ? { text } : null));
    const ctx = createMessageEndContext({
      onBlockReply,
      emitBlockReply,
      consumeReplyDirectives,
      state: {
        emittedAssistantUpdate: true,
        lastStreamedAssistantCleaned: "Hello world",
        blockReplyBreak: "text_end",
        // text_end delivered via emitBlockChunk which uses different stripping
        lastBlockReplyText: "Hello world.",
        deltaBuffer: "",
        blockBuffer: "",
      },
    });

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        // The raw text differs slightly from lastBlockReplyText due to stripping
        content: [{ type: "text", text: "Hello world" }],
        usage: { input: 10, output: 5, total: 15 },
      },
    } as never);

    // Even though text !== lastBlockReplyText (different stripping), the safety
    // send should NOT fire for text_end channels. The only consumeReplyDirectives
    // call is the final empty flush which returns null.
    expect(emitBlockReply).not.toHaveBeenCalled();
  });

  it("emits a replacement final assistant event when final_answer appears only at message_end", () => {
    const onAgentEvent = vi.fn();
    const ctx = createMessageEndContext({
      onAgentEvent,
      state: {
        emittedAssistantUpdate: true,
        lastStreamedAssistantCleaned: "Working...",
        blockReplyBreak: "text_end",
        deltaBuffer: "",
        blockBuffer: "",
      },
    });

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          createOpenAiResponsesTextBlock({
            text: "Working...",
            id: "item_commentary",
            phase: "commentary",
          }),
          createOpenAiResponsesTextBlock({
            text: "Done.",
            id: "item_final",
            phase: "final_answer",
          }),
        ],
        stopReason: "stop",
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.2",
        usage: {},
        timestamp: 0,
      },
    } as never);

    expect(onAgentEvent).toHaveBeenCalledTimes(1);
    expect(onAgentEvent.mock.calls[0]?.[0]).toMatchObject({
      stream: "assistant",
      data: {
        text: "Done.",
        delta: "",
        replace: true,
      },
    });
  });

  it("warns [final-tag] when the gate discards the entire visible reply", () => {
    const ctx = createMessageEndContext();
    Object.assign(ctx.params, {
      enforceFinalTag: true,
      agentId: "nutritionist-1",
      sessionKey: "agent:nutritionist-1:main",
    });
    // Simulate a reply the model never wrapped in <final>: the gate strips it all.
    (ctx as unknown as { stripBlockTags: () => string }).stripBlockTags = () => "";

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Locating the macros for this meal..." }],
        usage: { input: 1, output: 1, total: 2 },
      },
    } as never);

    const warn = ctx.log.warn as unknown as ReturnType<typeof vi.fn>;
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("[final-tag]");
    expect(line).toContain("agentId=nutritionist-1");
    expect(line).toContain("sessionKey=agent:nutritionist-1:main");
    // Length is reported, but never the discarded content itself.
    expect(line).toContain("discardedChars=");
    expect(line).not.toContain("Locating the macros");
  });

  it("does not warn [final-tag] when the gate keeps visible text", () => {
    const ctx = createMessageEndContext();
    Object.assign(ctx.params, { enforceFinalTag: true, agentId: "nutritionist-1" });
    (ctx as unknown as { stripBlockTags: (t: string) => string }).stripBlockTags = (t) => t;

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Logged: 420 kcal, 38g protein." }],
        usage: { input: 1, output: 1, total: 2 },
      },
    } as never);

    expect(ctx.log.warn as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("restores a bare NO_REPLY sentinel discarded by the final-tag gate as intentional silence", () => {
    const finalizeAssistantTexts = vi.fn();
    const emitBlockReply = vi.fn();
    const ctx = createMessageEndContext({ finalizeAssistantTexts, emitBlockReply });
    Object.assign(ctx.params, { enforceFinalTag: true, agentId: "nutritionist-1" });
    // The model emitted a bare NO_REPLY without wrapping it in <final>, so the
    // gate strips the whole reply to "" (the production regression fingerprint:
    // discardedChars=8, zero payloads -> incomplete-turn error to the user).
    (ctx as unknown as { stripBlockTags: () => string }).stripBlockTags = () => "";

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "NO_REPLY" }],
        usage: { input: 1, output: 1, total: 2 },
      },
    } as never);

    // Sentinel restored so the turn flows through the silent-reply path
    // (assistantTexts gets NO_REPLY -> incomplete-turn guard exempts it; the
    // payload is suppressed downstream). No user-facing error is produced.
    expect(finalizeAssistantTexts).toHaveBeenCalledTimes(1);
    expect(finalizeAssistantTexts).toHaveBeenCalledWith(
      expect.objectContaining({ text: "NO_REPLY" }),
    );
    // A discarded sentinel is intentional silence, not lost content: no canary.
    expect(ctx.log.warn as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("restores a whitespace-padded NO_REPLY sentinel discarded by the final-tag gate", () => {
    const finalizeAssistantTexts = vi.fn();
    const ctx = createMessageEndContext({ finalizeAssistantTexts });
    Object.assign(ctx.params, { enforceFinalTag: true, agentId: "nutritionist-1" });
    (ctx as unknown as { stripBlockTags: () => string }).stripBlockTags = () => "";

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "  NO_REPLY\n" }],
        usage: { input: 1, output: 1, total: 2 },
      },
    } as never);

    expect(finalizeAssistantTexts).toHaveBeenCalledWith(
      expect.objectContaining({ text: "NO_REPLY" }),
    );
    expect(ctx.log.warn as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("turns non-sentinel content discarded by the final-tag gate into silence, never an error", () => {
    const finalizeAssistantTexts = vi.fn();
    const ctx = createMessageEndContext({ finalizeAssistantTexts });
    Object.assign(ctx.params, {
      enforceFinalTag: true,
      agentId: "nutritionist-1",
      sessionKey: "agent:nutritionist-1:main",
    });
    // Real content the model forgot to wrap in <final>: the gate eats it whole.
    // Ending the turn with empty assistantTexts would let the incomplete-turn
    // guard deliver the raw "⚠️ Agent couldn't generate a response." harness
    // string to the member (three real SMS, 2026-07-28/29 breakfast nudges).
    // The contract is silence + canary: restore the silent sentinel so the turn
    // flows the intentional-silence path, and keep the warn for rate watching.
    (ctx as unknown as { stripBlockTags: () => string }).stripBlockTags = () => "";

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Locating the macros for this meal..." }],
        usage: { input: 1, output: 1, total: 2 },
      },
    } as never);

    expect(finalizeAssistantTexts).toHaveBeenCalledWith(
      expect.objectContaining({ text: "NO_REPLY" }),
    );
    // The over-suppression canary still fires for real discarded content.
    const warn = ctx.log.warn as unknown as ReturnType<typeof vi.fn>;
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("[final-tag]");
    // And the runner-facing flag is raised so the wrap-in-<final> retry can
    // recover the reply instead of ending the member's turn in silence.
    expect(ctx.state.finalTagDiscardedEntireReply).toBe(true);
  });

  it("does not raise the discard flag for a bare NO_REPLY sentinel", () => {
    const finalizeAssistantTexts = vi.fn();
    const ctx = createMessageEndContext({ finalizeAssistantTexts });
    Object.assign(ctx.params, { enforceFinalTag: true, agentId: "nutritionist-1" });
    (ctx as unknown as { stripBlockTags: () => string }).stripBlockTags = () => "";

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "NO_REPLY" }],
        usage: { input: 1, output: 1, total: 2 },
      },
    } as never);

    // Intentional silence: no retry signal, no canary.
    expect(ctx.state.finalTagDiscardedEntireReply).not.toBe(true);
    expect(ctx.log.warn as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("recovers a literally-tagged reply the sanitizer de-tagged before the gate", () => {
    // Bedrock lane: the model wrote "<final>…</final>" as plain text (no phase
    // annotations). extractAssistantVisibleText sanitizes the markers away, so
    // the gate's literal-tag strip sees tagless text and returns "" — but the
    // UNSANITIZED block text still carries the tags, and re-running the
    // extraction there recovers the compliant reply (2026-07-29 loopback
    // validation: every cron announce reply died here).
    const finalizeAssistantTexts = vi.fn();
    const ctx = createMessageEndContext({ finalizeAssistantTexts });
    Object.assign(ctx.params, { enforceFinalTag: true, agentId: "nutritionist-1" });
    // Behave like the real enforcement strip: tagged input yields the inner
    // content, tagless input yields nothing.
    (ctx as unknown as { stripBlockTags: (t: string) => string }).stripBlockTags = (t: string) => {
      const m = /<final>([\s\S]*?)<\/final>/.exec(t);
      return m ? m[1] : "";
    };

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        // Raw block text keeps the tags; the sanitized visible text will not.
        content: [{ type: "text", text: "<final>Validation ping — all good.</final>" }],
        usage: { input: 1, output: 1, total: 2 },
      },
    } as never);

    expect(finalizeAssistantTexts).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Validation ping — all good." }),
    );
    expect(ctx.log.warn as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("accepts final_answer-phase content without re-requiring literal tags", () => {
    // The streaming layer already parsed the model's <final> block into a
    // final_answer-phase text block — the literal tags are consumed and the
    // visible text is tagless. The gate must accept the phase attribution as
    // provenance: re-stripping ate every compliant cron announce reply
    // (2026-07-29 make-up reminders, wrapped correctly and discarded whole).
    const finalizeAssistantTexts = vi.fn();
    const ctx = createMessageEndContext({ finalizeAssistantTexts });
    Object.assign(ctx.params, { enforceFinalTag: true, agentId: "nutritionist-1" });
    // Literal-tag strip would return "" for this tagless text; the phase
    // bypass must win before it is consulted.
    (ctx as unknown as { stripBlockTags: () => string }).stripBlockTags = () => "";

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          createOpenAiResponsesTextBlock({
            text: "Sorry about the odd text earlier — all fixed now!",
            id: "item_final",
            phase: "final_answer",
          }),
        ],
        usage: { input: 1, output: 1, total: 2 },
      },
    } as never);

    expect(finalizeAssistantTexts).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Sorry about the odd text earlier — all fixed now!" }),
    );
    expect(ctx.log.warn as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("keeps a <final>-wrapped NO_REPLY flowing as a silent reply", () => {
    const finalizeAssistantTexts = vi.fn();
    const ctx = createMessageEndContext({ finalizeAssistantTexts });
    Object.assign(ctx.params, { enforceFinalTag: true, agentId: "nutritionist-1" });
    // Model wrapped the sentinel correctly: the gate keeps the inner NO_REPLY,
    // so strippedVisibleText is non-empty and the normal silent path applies.
    (ctx as unknown as { stripBlockTags: () => string }).stripBlockTags = () => "NO_REPLY";

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "<final>NO_REPLY</final>" }],
        usage: { input: 1, output: 1, total: 2 },
      },
    } as never);

    expect(finalizeAssistantTexts).toHaveBeenCalledWith(
      expect.objectContaining({ text: "NO_REPLY" }),
    );
    expect(ctx.log.warn as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});
