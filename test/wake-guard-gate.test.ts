import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  installPvpRetryHook,
  PvpController,
  PVP_WAKE_GUARD_CHANNEL,
  type PvpRetryGateRequest,
} from "../src/pvp-controller.js";
import pvpExtension from "../src/index.js";

const proto = AgentSession.prototype as any;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const MODEL = {
  provider: "pvp-fixture",
  id: "fixture",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:9/v1",
};

const FAILURE = { role: "assistant", stopReason: "error", errorMessage: "Upstream stream disconnected" };

function createUi() {
  const notifications: Array<{ msg: string; type?: string }> = [];
  return {
    notifications,
    notify: vi.fn((msg: string, type?: "info" | "warning" | "error") => {
      notifications.push({ msg, type });
    }),
    setStatus: vi.fn(),
    setWidget: vi.fn(),
  };
}

/** Fake host session with the fields the retry hook and omission path touch. */
function createSession(overrides: Record<string, unknown> = {}) {
  const user = { role: "user", content: "hello" };
  const session: any = {
    model: MODEL,
    _extensionUIContext: undefined,
    agent: { state: { messages: [user, FAILURE] } },
    _omitRecoveryAttempt: vi.fn(() => {
      session.agent.state.messages = [user];
    }),
    ...overrides,
  };
  return session;
}

function setup(options?: Parameters<typeof installPvpRetryHook>[1]) {
  const controller = new PvpController();
  cleanups.push(installPvpRetryHook(controller, options));
  return controller;
}

describe("wake-guard retry gate", () => {
  it("keeps the pre-gate behaviour when the gate is not installed", async () => {
    const controller = setup();
    controller.enable("persistent");
    const session = createSession();
    expect(await proto._prepareRetry.call(session, FAILURE)).toBe(true);
    expect(session._omitRecoveryAttempt).toHaveBeenCalledExactlyOnceWith(FAILURE);
    expect(controller.currentAttempt).toBe(1);
  });

  it("keeps native retry when no listener attaches a wait", async () => {
    const emit = vi.fn(() => {});
    const controller = setup({ emitRetryGate: emit });
    controller.enable("persistent");
    const session = createSession();
    expect(await proto._prepareRetry.call(session, FAILURE)).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(session._omitRecoveryAttempt).toHaveBeenCalledTimes(1);
    expect(controller.currentAttempt).toBe(1);
  });

  it("parks the run without omitting or counting while the wait is pending", async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const controller = setup({ emitRetryGate: (request) => { request.wait = promise; } });
    controller.enable("persistent");
    const session = createSession();
    const pending = proto._prepareRetry.call(session, FAILURE);

    // The emit adapter and the wait are set up synchronously before the first await.
    expect(controller.isAwaitingRetryWait).toBe(true);
    expect(session._omitRecoveryAttempt).not.toHaveBeenCalled();
    expect(session.agent.state.messages).toHaveLength(2);
    expect(controller.currentAttempt).toBe(0);

    resolve(true);
    expect(await pending).toBe(true);
    expect(session._omitRecoveryAttempt).toHaveBeenCalledTimes(1);
    expect(controller.currentAttempt).toBe(1);
    expect(controller.isAwaitingRetryWait).toBe(false);
  });

  it("resolves true to resume the same run and keeps the bounded-mode success count", async () => {
    const controller = setup({ emitRetryGate: (request) => { request.wait = Promise.resolve(true); } });
    controller.enable("limited", undefined, 2);
    controller.handleSuccess();
    expect(controller.currentSuccessCount).toBe(1);

    const session = createSession();
    expect(await proto._prepareRetry.call(session, FAILURE)).toBe(true);
    expect(controller.currentMode).toBe("limited");
    expect(controller.currentSuccessCount).toBe(1);
  });

  it("resolves false to cancel this run only, without omitting or touching counters", async () => {
    const controller = setup({ emitRetryGate: (request) => { request.wait = Promise.resolve(false); } });
    controller.enable("limited", undefined, 3);
    controller.handleSuccess();
    const session = createSession();

    expect(await proto._prepareRetry.call(session, FAILURE)).toBe(false);
    expect(session._omitRecoveryAttempt).not.toHaveBeenCalled();
    expect(session.agent.state.messages).toHaveLength(2);
    expect(controller.currentMode).toBe("limited");
    expect(controller.currentSuccessCount).toBe(1);
    expect(controller.currentAttempt).toBe(0);
    expect(session._retryAbortController).toBeUndefined();
  });

  it("rejects the wait to cancel without leaking probe details", async () => {
    const ui = createUi();
    const controller = setup({
      emitRetryGate: (request) => { request.wait = Promise.reject(new Error("secret-token-abc")); },
    });
    controller.enable("limited", undefined, 3);
    controller.handleSuccess();
    const session = createSession({ _extensionUIContext: ui });

    expect(await proto._prepareRetry.call(session, FAILURE)).toBe(false);
    expect(session._omitRecoveryAttempt).not.toHaveBeenCalled();
    expect(controller.currentMode).toBe("limited");
    expect(controller.currentSuccessCount).toBe(1);
    expect(controller.currentAttempt).toBe(0);
    expect(JSON.stringify(ui.notifications)).not.toContain("secret-token-abc");
  });

  it("cancels the gate when the user aborts during a stream-disconnect failure", async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    let captured: PvpRetryGateRequest | undefined;
    const controller = setup({ emitRetryGate: (request) => { captured = request; request.wait = promise; } });
    controller.enable("persistent");
    controller.handleTurnEnd(FAILURE as any);
    const session = createSession({
      _isAgentRunActive: true,
      _lastAssistantMessage: FAILURE,
      isIdle: true,
      agent: { abort: vi.fn(), state: { messages: [] } },
      // Orig abort() requires these host collaborators.
      abortRetry: vi.fn(),
      abortCompaction: vi.fn(),
      abortBranchSummary: vi.fn(),
      waitForIdle: async () => {},
    });
    const pending = proto._prepareRetry.call(session, FAILURE);
    expect(controller.isAwaitingRetryWait).toBe(true);

    // The goal-style force-abort suppression must not swallow an explicit cancel while parked.
    await proto.abort.call(session);
    resolve(true);
    expect(await pending).toBe(false);
    expect(captured?.signal.aborted).toBe(true);
    expect(session._omitRecoveryAttempt).not.toHaveBeenCalled();
    expect(controller.currentAttempt).toBe(0);
  });

  it("does not revive a cancelled gate after /pvp off and a late resume", async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const controller = setup({ emitRetryGate: (request) => { request.wait = promise; } });
    controller.enable("persistent");
    const session = createSession();
    const pending = proto._prepareRetry.call(session, FAILURE);
    expect(controller.isAwaitingRetryWait).toBe(true);

    controller.disable();
    resolve(true);
    expect(await pending).toBe(false);
    expect(controller.currentMode).toBe("off");
    expect(session._omitRecoveryAttempt).not.toHaveBeenCalled();
  });

  it("does not revive after session shutdown cleanup", async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const controller = setup({ emitRetryGate: (request) => { request.wait = promise; } });
    controller.enable("persistent");
    const session = createSession();
    const pending = proto._prepareRetry.call(session, FAILURE);
    expect(controller.isAwaitingRetryWait).toBe(true);

    // Teardown is exactly what session_shutdown runs.
    for (const cleanup of cleanups.splice(0)) cleanup();
    resolve(true);
    expect(await pending).toBe(false);
    expect(session._omitRecoveryAttempt).not.toHaveBeenCalled();
  });

  it("cancels a parked gate when a new prompt starts", async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const controller = setup({ emitRetryGate: (request) => { request.wait = promise; } });
    controller.enable("persistent");
    const session = createSession();
    const pending = proto._prepareRetry.call(session, FAILURE);
    expect(controller.isAwaitingRetryWait).toBe(true);

    controller.handleNewPrompt();
    resolve(true);
    expect(await pending).toBe(false);
    expect(session._omitRecoveryAttempt).not.toHaveBeenCalled();
  });

  it("fails closed without retrying when the emit adapter throws", async () => {
    const ui = createUi();
    const controller = setup({ emitRetryGate: () => { throw new Error("bus down"); } });
    controller.enable("persistent");
    const session = createSession({ _extensionUIContext: ui });
    expect(await proto._prepareRetry.call(session, FAILURE)).toBe(false);
    expect(session._omitRecoveryAttempt).not.toHaveBeenCalled();
    expect(ui.notifications[0]?.msg).toBe("PVP: 看门狗接口调用失败，本次不重试");
  });
});

describe("index wiring for the wake guard", () => {
  function createHarness() {
    const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
    const commands = new Map<string, any>();
    let listener: ((request: PvpRetryGateRequest) => void) | undefined;
    const emit = vi.fn((channel: string, request: PvpRetryGateRequest) => {
      if (channel !== PVP_WAKE_GUARD_CHANNEL) throw new Error(`unexpected channel ${channel}`);
      listener?.(request);
    });
    const api = {
      on(event: string, handler: (event: any, ctx: any) => any) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      registerCommand(name: string, definition: any) {
        commands.set(name, definition);
      },
      events: { emit },
    } as unknown as ExtensionAPI;
    pvpExtension(api);
    const shutdown = handlers.get("session_shutdown")?.[0];
    cleanups.push(() => shutdown?.({}, { ui: createUi() }));
    return {
      handlers,
      commands,
      emit,
      listen: (next: (request: PvpRetryGateRequest) => void) => {
        listener = next;
      },
    };
  }

  it("parks a real /pvp retry through pi.events and cancels it on model change", async () => {
    const harness = createHarness();
    const ui = createUi();
    await harness.commands.get("pvp").handler("on", { ui });

    const { promise, resolve } = Promise.withResolvers<boolean>();
    harness.listen((request) => {
      request.wait = promise;
    });

    const session = createSession({ _extensionUIContext: ui });
    const pending = proto._prepareRetry.call(session, FAILURE);
    expect(harness.emit).toHaveBeenCalledTimes(1);
    expect(session._omitRecoveryAttempt).not.toHaveBeenCalled();

    harness.handlers.get("model_select")?.[0]?.({}, { ui });
    resolve(true);
    expect(await pending).toBe(false);
    expect(session._omitRecoveryAttempt).not.toHaveBeenCalled();
  });

  it("cancels a parked gate on session switch", async () => {
    const harness = createHarness();
    const ui = createUi();
    await harness.commands.get("pvp").handler("on", { ui });

    const { promise, resolve } = Promise.withResolvers<boolean>();
    harness.listen((request) => { request.wait = promise; });

    const session = createSession({ _extensionUIContext: ui });
    const pending = proto._prepareRetry.call(session, FAILURE);
    harness.handlers.get("session_before_switch")?.[0]?.({}, { ui });
    resolve(true);
    expect(await pending).toBe(false);
    expect(session._omitRecoveryAttempt).not.toHaveBeenCalled();
  });
});
