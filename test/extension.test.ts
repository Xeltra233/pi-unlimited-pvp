import { describe, expect, it, vi } from "vitest";
import {
  AgentSession,
  createAgentSession,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import pvpExtension, { PVP_STATUS_KEY, PVP_WIDGET_KEY } from "../src/index.js";

type EventHandler = (event: any, ctx: ExtensionContext) => any;

function createMockExtensionApi(): {
  api: ExtensionAPI;
  handlers: Map<string, EventHandler[]>;
  commands: Map<string, any>;
  sentMessages: Array<{ content: any; options?: any }>;
} {
  const handlers = new Map<string, EventHandler[]>();
  const commands = new Map<string, any>();
  const sentMessages: Array<{ content: any; options?: any }> = [];

  const api: Partial<ExtensionAPI> = {
    on(event: string, handler: EventHandler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name: string, options: any) {
      commands.set(name, options);
    },
    sendUserMessage(content: any, options?: any) {
      sentMessages.push({ content, options });
    },
  };

  return {
    api: api as ExtensionAPI,
    handlers,
    commands,
    sentMessages,
  };
}

function createMockContext(): ExtensionCommandContext & {
  statuses: Record<string, string | undefined>;
  widgets: Record<string, { content: string[] | undefined; options?: any }>;
  notifications: Array<{ msg: string; type?: string }>;
} {
  const statuses: Record<string, string | undefined> = {};
  const widgets: Record<string, { content: string[] | undefined; options?: any }> = {};
  const notifications: Array<{ msg: string; type?: string }> = [];

  return {
    ui: {
      setStatus: vi.fn((key: string, value: string | undefined) => {
        statuses[key] = value;
      }),
      setWidget: vi.fn((key: string, content: any, options?: any) => {
        let resolvedContent: string[] | undefined;
        if (typeof content === "function") {
          const comp = content({}, undefined);
          resolvedContent = comp?.render?.(80);
        } else {
          resolvedContent = content;
        }
        widgets[key] = { content: resolvedContent, options };
      }),
      notify: vi.fn((msg: string, type?: string) => {
        notifications.push({ msg, type });
      }),
      select: vi.fn(),
      confirm: vi.fn(),
      input: vi.fn(),
    } as any,
    statuses,
    widgets,
    notifications,
    mode: "tui",
    hasUI: true,
    cwd: "/mock/cwd",
    sessionManager: {} as any,
    modelRegistry: {} as any,
    model: undefined,
    scopedModels: [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: vi.fn(),
    hasPendingMessages: () => false,
    shutdown: vi.fn(),
    getContextUsage: () => undefined,
    compact: vi.fn(),
    getSystemPrompt: () => "",
    getSystemPromptOptions: () => ({ cwd: "/mock/cwd" }),
    waitForIdle: async () => {},
  };
}

describe("PVP Extension End-to-End Lifecycle", () => {
  it("registers /pvp command and required lifecycle hooks", () => {
    const { api, commands, handlers } = createMockExtensionApi();
    pvpExtension(api);

    expect(commands.has("pvp")).toBe(true);
    expect(handlers.has("before_agent_start")).toBe(true);
    expect(handlers.has("turn_end")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);
  });

  it("simulates full persistent retry flow with native in-place retry (never sends user messages)", async () => {
    const { api, handlers, commands, sentMessages } = createMockExtensionApi();
    pvpExtension(api);
    const ctx = createMockContext();

    // 1. User enters /pvp
    const pvpCmd = commands.get("pvp");
    await pvpCmd.handler("", ctx);
    expect(ctx.statuses[PVP_STATUS_KEY]).toBe("pvp on");
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on"]);
    expect(ctx.widgets[PVP_WIDGET_KEY]?.options).toEqual({ placement: "belowEditor" });
    expect(ctx.notifications[0]?.msg).toBe("PVP ON");

    // 2. User submits prompt
    const beforeAgentStart = handlers.get("before_agent_start")![0];
    beforeAgentStart({ type: "before_agent_start", prompt: "Build a feature" }, ctx);

    // 3. Model turn 1 fails -> native AgentSession._prepareRetry intercepts
    const sessionProto = AgentSession.prototype as any;
    const fakeSession = {
      _extensionUIContext: ctx.ui,
      agent: {
        state: {
          messages: [
            { role: "user", content: [{ type: "text", text: "Build a feature" }] },
            { role: "assistant", stopReason: "error", errorMessage: "HTTP 500 Server Error" },
          ],
        },
      },
    };

    const willRetry1 = await sessionProto._prepareRetry.call(fakeSession, {
      role: "assistant",
      stopReason: "error",
      errorMessage: "HTTP 500 Server Error",
    });

    expect(willRetry1).toBe(true);
    // CRITICAL: NEVER sends a user message into the chat!
    expect(sentMessages).toHaveLength(0);
    // Assistant error message must be removed from agent state so it can continue in place
    expect(fakeSession.agent.state.messages).toHaveLength(1);
    expect(fakeSession.agent.state.messages[0].role).toBe("user");
    // UI reflects retry count
    expect(ctx.statuses[PVP_STATUS_KEY]).toBe("pvp on (第 1 次重试)");
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on (第 1 次重试)"]);

    // 4. Model turn 2 fails again -> native retry 2
    fakeSession.agent.state.messages.push({
      role: "assistant",
      stopReason: "error",
      errorMessage: "HTTP 503 Service Unavailable",
    });
    const willRetry2 = await sessionProto._prepareRetry.call(fakeSession, {
      role: "assistant",
      stopReason: "error",
      errorMessage: "HTTP 503 Service Unavailable",
    });

    expect(willRetry2).toBe(true);
    expect(sentMessages).toHaveLength(0);
    expect(fakeSession.agent.state.messages).toHaveLength(1);
    expect(ctx.statuses[PVP_STATUS_KEY]).toBe("pvp on (第 2 次重试)");
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on (第 2 次重试)"]);

    // 5. Turn 3 succeeds!
    const turnEnd = handlers.get("turn_end")![0];
    const successMsg = {
      role: "assistant",
      content: [{ type: "text", text: "Done!" }],
      stopReason: "stop",
    };
    turnEnd({ type: "turn_end", turnIndex: 2, message: successMsg, toolResults: [] }, ctx);

    // Success resets count: status bar and widget return to clean "pvp on" without retry count
    expect(ctx.statuses[PVP_STATUS_KEY]).toBe("pvp on");
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on"]);
    // Still zero user messages sent
    expect(sentMessages).toHaveLength(0);

    // 6. Subsequent new prompt failure must restart counting from 1
    beforeAgentStart({ type: "before_agent_start", prompt: "New separate task" }, ctx);
    fakeSession.agent.state.messages = [
      { role: "user", content: [{ type: "text", text: "New separate task" }] },
      { role: "assistant", stopReason: "error", errorMessage: "Fail again" },
    ];
    await sessionProto._prepareRetry.call(fakeSession, {
      role: "assistant",
      stopReason: "error",
      errorMessage: "Fail again",
    });
    expect(ctx.statuses[PVP_STATUS_KEY]).toBe("pvp on (第 1 次重试)");
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on (第 1 次重试)"]);

    // 7. Aborting the turn cancels retry and cleans up status bar back to "pvp on"
    const abortMsg = {
      role: "assistant",
      content: [],
      stopReason: "aborted",
    };
    turnEnd({ type: "turn_end", turnIndex: 1, message: abortMsg, toolResults: [] }, ctx);
    expect(ctx.statuses[PVP_STATUS_KEY]).toBe("pvp on");
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on"]);
  });

  it("simulates /pvp one flow: failure -> native in-place retry -> success -> automatically closes", async () => {
    const { api, handlers, commands, sentMessages } = createMockExtensionApi();
    pvpExtension(api);
    const ctx = createMockContext();

    // 1. User enters /pvp one
    const pvpCmd = commands.get("pvp");
    await pvpCmd.handler("one", ctx);
    expect(ctx.statuses[PVP_STATUS_KEY]).toBe("pvp one");
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp one"]);
    expect(ctx.widgets[PVP_WIDGET_KEY]?.options).toEqual({ placement: "belowEditor" });
    expect(ctx.notifications[0]?.msg).toBe("PVP ONE");

    // 2. User submits prompt
    const beforeAgentStart = handlers.get("before_agent_start")![0];
    beforeAgentStart({ type: "before_agent_start", prompt: "One shot prompt" }, ctx);

    // 3. Turn fails -> native retry 1
    const sessionProto = AgentSession.prototype as any;
    const fakeSession = {
      _extensionUIContext: ctx.ui,
      agent: {
        state: {
          messages: [
            { role: "user", content: [{ type: "text", text: "One shot prompt" }] },
            { role: "assistant", stopReason: "error", errorMessage: "Network error" },
          ],
        },
      },
    };

    const willRetry = await sessionProto._prepareRetry.call(fakeSession, {
      role: "assistant",
      stopReason: "error",
      errorMessage: "Network error",
    });

    expect(willRetry).toBe(true);
    expect(sentMessages).toHaveLength(0);
    expect(ctx.statuses[PVP_STATUS_KEY]).toBe("pvp one (第 1 次重试)");
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp one (第 1 次重试)"]);

    // 4. Retry turn succeeds
    const turnEnd = handlers.get("turn_end")![0];
    const successMsg = {
      role: "assistant",
      content: [{ type: "text", text: "Success" }],
      stopReason: "stop",
    };
    turnEnd({ type: "turn_end", turnIndex: 1, message: successMsg, toolResults: [] }, ctx);

    // Status bar and widget must be cleared automatically
    expect(ctx.statuses[PVP_STATUS_KEY]).toBeUndefined();
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toBeUndefined();
    expect(ctx.notifications.some((n) => n.msg === "PVP OFF")).toBe(true);
    expect(sentMessages).toHaveLength(0);
  });

  it("cleans up on session shutdown", async () => {
    const { api, handlers, commands } = createMockExtensionApi();
    pvpExtension(api);
    const ctx = createMockContext();

    const pvpCmd = commands.get("pvp");
    await pvpCmd.handler("", ctx);
    expect(ctx.statuses[PVP_STATUS_KEY]).toBe("pvp on");
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on"]);

    const sessionShutdown = handlers.get("session_shutdown")![0];
    sessionShutdown({ type: "session_shutdown", reason: "quit" }, ctx);

    expect(ctx.statuses[PVP_STATUS_KEY]).toBeUndefined();
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toBeUndefined();
  });

  it("verifies real AgentSession integration: retries in place without chat history duplication", async () => {
    const { api } = createMockExtensionApi();
    pvpExtension(api);

    const result = await createAgentSession({
      cwd: process.cwd(),
      sessionStartEvent: { type: "session_start", reason: "startup" },
    });
    const session = result.session;
    const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 };

    // Initial user prompt
    session.agent.state.messages.push({
      role: "user",
      content: [{ type: "text", text: "Real task" }],
    });

    // Turn 1 fails
    session.agent.state.messages.push({
      role: "assistant",
      stopReason: "error",
      errorMessage: "HTTP 500",
      content: [],
      usage,
    });
    session._lastAssistantMessage = session.agent.state.messages[session.agent.state.messages.length - 1];

    const willContinue1 = await session._handlePostAgentRun();
    expect(willContinue1).toBe(true);
    // Failed assistant message was removed, ONLY the user message remains
    expect(session.agent.state.messages).toHaveLength(1);
    expect(session.agent.state.messages[0].role).toBe("user");

    // Turn 2 succeeds
    session.agent.state.messages.push({
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "Task done!" }],
      usage,
    });
    session._lastAssistantMessage = session.agent.state.messages[session.agent.state.messages.length - 1];

    const willContinue2 = await session._handlePostAgentRun();
    expect(willContinue2).toBe(false);
    // Transcript has exactly 1 user message and 1 assistant message - ZERO duplicated user messages!
    expect(session.agent.state.messages).toHaveLength(2);
    expect(session.agent.state.messages[0].role).toBe("user");
    expect(session.agent.state.messages[1].role).toBe("assistant");
  }, 15000);
});
