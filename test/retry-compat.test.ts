import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { installPvpRetryHook, PvpController } from "../src/pvp-controller.js";

const proto = AgentSession.prototype as any;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function setup() {
  const controller = new PvpController();
  controller.enable("persistent");
  const cleanup = installPvpRetryHook(controller);
  cleanups.push(cleanup);
  const message = { role: "assistant", stopReason: "error", errorMessage: "fixture failure" };
  const user = { role: "user", content: "hello" };
  const session: any = { agent: { state: { messages: [user, message] } } };
  return { controller, cleanup, session, message, user };
}

describe("native retry compatibility", () => {
  it("uses durable omission on pi 0.87+ instead of only changing memory", async () => {
    const { controller, session, message, user } = setup();
    session._omitRecoveryAttempt = vi.fn(() => { session.agent.state.messages = [user]; });
    expect(await proto._prepareRetry.call(session, message)).toBe(true);
    expect(session._omitRecoveryAttempt).toHaveBeenCalledExactlyOnceWith(message);
    expect(session.agent.state.messages).toEqual([user]);
    expect(controller.currentAttempt).toBe(1);
  });
  it("retains the in-memory path on pi 0.84–0.86", async () => {
    const { session, message, user } = setup();
    expect(await proto._prepareRetry.call(session, message)).toBe(true);
    expect(session.agent.state.messages).toEqual([user]);
  });
  it("does not hide a projection failure", async () => {
    const { session, message } = setup();
    session._omitRecoveryAttempt = () => { throw new Error("projection failed"); };
    await expect(proto._prepareRetry.call(session, message)).rejects.toThrow("projection failed");
  });
  it("does not continue after /pvp off during the event-loop yield", async () => {
    const { controller, session, message } = setup();
    const pending = proto._prepareRetry.call(session, message);
    controller.disable();
    expect(await pending).toBe(false);
  });
  it("honors the pi 0.86+ run-abort flag before modifying context", async () => {
    const { controller, session, message } = setup();
    session._agentRunAbortRequested = true;
    expect(await proto._prepareRetry.call(session, message)).toBe(false);
    expect(session.agent.state.messages).toHaveLength(2);
    expect(controller.currentAttempt).toBe(0);
  });
  it("aborts the native retry wait and releases its controller", async () => {
    const { controller, session, message } = setup();
    const pending = proto._prepareRetry.call(session, message);
    session._retryAbortController.abort();
    expect(await pending).toBe(false);
    expect(session._retryAbortController).toBeUndefined();
    expect(controller.currentAttempt).toBe(0);
  });
  it("old cleanup cannot uninstall a newer installation", () => {
    const { cleanup } = setup();
    const next = new PvpController();
    next.enable("limited", undefined, 1);
    cleanups.push(installPvpRetryHook(next));
    const current = proto._prepareRetry;
    cleanup();
    expect(proto._prepareRetry).toBe(current);
  });
  it("cleanup preserves hooks installed afterward by other extensions", () => {
    const original = proto._prepareRetry;
    const { cleanup } = setup();
    const later = async () => false;
    proto._prepareRetry = later;
    try { cleanup(); expect(proto._prepareRetry).toBe(later); }
    finally { proto._prepareRetry = original; }
  });

  it("ignores a foreign abort after a stream-disconnect failure so the retry can run", async () => {
    const { controller } = setup();
    const errorMessage = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "Upstream stream disconnected",
      timestamp: 7,
    };
    controller.handleTurnEnd(errorMessage as any);

    const session: any = {
      _isAgentRunActive: true,
      _lastAssistantMessage: errorMessage,
      _extensionUIContext: undefined,
      agent: { abort: vi.fn() },
      abortRetry: vi.fn(),
      isIdle: true,
    };
    await proto.abort.call(session);
    expect(session.abortRetry).not.toHaveBeenCalled();
    expect(session.agent.abort).not.toHaveBeenCalled();
  });

  it("forwards aborts for unrelated failures", async () => {
    const { controller } = setup();
    const errorMessage = { role: "assistant", stopReason: "error", errorMessage: "rate limit exceeded" };
    controller.handleTurnEnd(errorMessage as any);

    const session: any = {
      _isAgentRunActive: true,
      _lastAssistantMessage: errorMessage,
      _extensionUIContext: undefined,
      agent: { abort: vi.fn() },
      abortRetry: vi.fn(),
      abortCompaction: vi.fn(),
      abortBranchSummary: vi.fn(),
      isIdle: true,
      waitForIdle: async () => {},
    };
    await proto.abort.call(session);
    expect(session.abortRetry).toHaveBeenCalledTimes(1);
    expect(session.agent.abort).toHaveBeenCalledTimes(1);
  });
  it("installs on the Pi 1.x _startRun lifecycle", () => {
    expect(typeof proto._startRun).toBe("function");
    const controller = new PvpController();
    controller.enable("persistent");
    const cleanup = installPvpRetryHook(controller);
    cleanups.push(cleanup);
  });

  it("wraps _startRun and forwards its trigger and onStarted arguments", async () => {
    const original = proto._startRun;
    const calls: unknown[][] = [];
    proto._startRun = async function (...args: unknown[]) { calls.push(args); return "ran"; };
    try {
      const controller = new PvpController();
      controller.enable("persistent");
      const cleanup = installPvpRetryHook(controller);
      cleanups.push(cleanup);
      const trigger = { messageType: "user", prompt: "hello" };
      const onStarted = () => {};
      const session: any = {};
      expect(proto._startRun).not.toBe(original);
      expect(await proto._startRun.call(session, trigger, onStarted)).toBe("ran");
      expect(calls).toEqual([[trigger, onStarted]]);
    } finally {
      proto._startRun = original;
    }
  });

  it("wraps only the preferred lifecycle method when both exist", () => {
    const original = proto._startRun;
    const legacy = async function () {};
    proto._runAgentPrompt = legacy;
    try {
      const controller = new PvpController();
      controller.enable("persistent");
      const cleanup = installPvpRetryHook(controller);
      cleanups.push(cleanup);
      expect(proto._startRun).not.toBe(original);
      expect(proto._runAgentPrompt).toBe(legacy);
      cleanup();
      expect(proto._startRun).toBe(original);
      expect(proto._runAgentPrompt).toBe(legacy);
    } finally {
      delete proto._runAgentPrompt;
    }
  });

  it("falls back to the pre-1.x _runAgentPrompt lifecycle", async () => {
    const startRun = proto._startRun;
    const legacyCalls: unknown[][] = [];
    const legacy = async function (...args: unknown[]) { legacyCalls.push(args); };
    delete proto._startRun;
    proto._runAgentPrompt = legacy;
    try {
      const controller = new PvpController();
      controller.enable("persistent");
      const cleanup = installPvpRetryHook(controller);
      cleanups.push(cleanup);
      expect(proto._runAgentPrompt).not.toBe(legacy);
      await proto._runAgentPrompt.call({}, "legacy-messages");
      expect(legacyCalls).toEqual([["legacy-messages"]]);
      cleanup();
      expect(proto._runAgentPrompt).toBe(legacy);
    } finally {
      delete proto._runAgentPrompt;
      proto._startRun = startRun;
    }
  });
});
