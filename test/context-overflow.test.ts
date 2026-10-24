import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  installPvpRetryHook,
  isPvpContextOverflow,
  PvpController,
  PVP_CONTEXT_OVERFLOW_PATTERNS,
} from "../src/pvp-controller.js";

const proto = AgentSession.prototype as any;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function setup() {
  const controller = new PvpController();
  controller.enable("persistent");
  cleanups.push(installPvpRetryHook(controller));
  const session: any = {
    model: { contextWindow: 200000 },
    _modelForMessage: () => ({ contextWindow: 200000 }),
    agent: { state: { messages: [{ role: "user", content: "hello" }] } },
  };
  return { controller, session };
}

const OVERFLOW_SAMPLES = [
  "prompt is too long: 213462 tokens > 200000 maximum", // Anthropic
  "Your input exceeds the context window of this model", // [OI]
  "This endpoint's maximum context length is 128000 tokens. However, you requested about 200000 tokens", // OpenRouter
  "Input length (265330) exceeds model's maximum context length (262144).", // [OI]-compatible
  "Please reduce the length of the messages or completion", // Groq
  "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)", // Google
  "prompt too long; exceeded max context length by 12 tokens", // Ollama
  "context_length_exceeded", // generic fallback
];

const RETRYABLE_SAMPLES = [
  "Upstream stream disconnected",
  "rate limit exceeded",
  "Too many requests",
  "Throttling error: Too many tokens, please wait before trying again.",
  "503 Service Unavailable",
  "socket hang up",
];

describe("context overflow classification", () => {
  it.each(OVERFLOW_SAMPLES)("treats %j as context overflow", (errorMessage) => {
    expect(isPvpContextOverflow({ role: "assistant", stopReason: "error", errorMessage })).toBe(true);
  });

  it.each(RETRYABLE_SAMPLES)("keeps %j retryable", (errorMessage) => {
    expect(isPvpContextOverflow({ role: "assistant", stopReason: "error", errorMessage })).toBe(false);
  });

  it("ignores successful turns and empty messages", () => {
    expect(isPvpContextOverflow({ role: "assistant", stopReason: "stop", errorMessage: "prompt is too long" })).toBe(false);
    expect(isPvpContextOverflow({ role: "assistant", stopReason: "error" })).toBe(false);
    expect(isPvpContextOverflow(undefined)).toBe(false);
  });

  it("exposes the overflow pattern list for host-specific extension", () => {
    expect(PVP_CONTEXT_OVERFLOW_PATTERNS.length).toBeGreaterThan(10);
  });
});

describe("auto-compaction survives PVP", () => {
  it("does not classify a context overflow as retryable", () => {
    const { session } = setup();
    const overflow = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
      timestamp: 1,
    };
    expect(proto._isRetryableError.call(session, overflow)).toBe(false);
  });

  it("keeps retrying genuine transport failures", () => {
    const { session } = setup();
    expect(
      proto._isRetryableError.call(session, {
        role: "assistant",
        stopReason: "error",
        errorMessage: "Upstream stream disconnected",
      })
    ).toBe(true);
  });

  it("refuses to prepare a retry for a context overflow and leaves context intact", async () => {
    const { controller, session } = setup();
    const overflow = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
    };
    const before = [...session.agent.state.messages];
    session._omitRecoveryAttempt = vi.fn();

    expect(await proto._prepareRetry.call(session, overflow)).toBe(false);
    expect(session._omitRecoveryAttempt).not.toHaveBeenCalled();
    expect(session.agent.state.messages).toEqual(before);
    expect(controller.currentAttempt).toBe(0);
  });

  it("does not latch a pending retry on a context-overflow turn_end", () => {
    const controller = new PvpController();
    controller.enable("persistent");
    const result = controller.handleTurnEnd({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
    } as any);

    expect(result).toEqual({ shouldRetry: false, success: false });
    expect(controller.isPendingRetry).toBe(false);
    expect(controller.pendingErrorTurn).toBeUndefined();
    expect(controller.lastErrorMessage).toContain("prompt is too long");
  });

  it("still latches a pending retry on a transport failure", () => {
    const controller = new PvpController();
    controller.enable("persistent");
    const result = controller.handleTurnEnd({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Upstream stream disconnected",
    } as any);

    expect(result).toEqual({ shouldRetry: true, success: false });
    expect(controller.isPendingRetry).toBe(true);
  });

  it("does not swallow a goal-style abort for a context overflow", async () => {
    const { controller } = setup();
    const overflow = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
      timestamp: 11,
    };
    controller.handleTurnEnd(overflow as any);

    const session: any = {
      _isAgentRunActive: true,
      _lastAssistantMessage: overflow,
      _extensionUIContext: undefined,
      agent: { abort: vi.fn() },
      abortRetry: vi.fn(),
      abortCompaction: vi.fn(),
      abortBranchSummary: vi.fn(),
      isIdle: true,
      waitForIdle: async () => {},
    };
    await proto.abort.call(session);
    // A real abort must go through so Pi can stop and compact instead of reconnecting.
    expect(session.agent.abort).toHaveBeenCalledTimes(1);
  });
});
