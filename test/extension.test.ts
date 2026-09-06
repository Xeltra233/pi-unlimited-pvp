import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
        widgets[key] = { content, options };
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
    expect(handlers.has("message_end")).toBe(true);
    expect(handlers.has("turn_end")).toBe(true);
    expect(handlers.has("agent_settled")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);
  });

  it("simulates full persistent retry flow: prompt -> failure -> retry -> failure -> retry -> success -> remains enabled", async () => {
    vi.useFakeTimers();
    const { api, handlers, commands, sentMessages } = createMockExtensionApi();
    pvpExtension(api);
    const ctx = createMockContext();

    // 1. User enters /pvp
    const pvpCmd = commands.get("pvp");
    await pvpCmd.handler("", ctx);
    expect(ctx.statuses[PVP_STATUS_KEY]).toBe("● PVP ON");
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toEqual(["● PVP ON"]);
    expect(ctx.widgets[PVP_WIDGET_KEY]?.options).toEqual({ placement: "belowEditor" });
    expect(ctx.notifications[0]?.msg).toBe("PVP ON");

    // 2. User submits prompt
    const beforeAgentStart = handlers.get("before_agent_start")![0];
    beforeAgentStart({ type: "before_agent_start", prompt: "Build a feature" }, ctx);

    // 3. Turn 1 fails
    const messageEnd = handlers.get("message_end")![0];
    const turnEnd = handlers.get("turn_end")![0];
    const agentSettled = handlers.get("agent_settled")![0];

    const errorMsg = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "HTTP 500 Server Error",
    };

    const replacement = messageEnd({ type: "message_end", message: errorMsg }, ctx);
    expect(replacement?.message.errorMessage).toContain("quota exceeded");

    turnEnd({ type: "turn_end", turnIndex: 0, message: errorMsg, toolResults: [] }, ctx);

    // Agent run settles -> schedules immediate retry
    agentSettled({ type: "agent_settled" }, ctx);
    vi.runAllTimers();

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].content).toBe("Build a feature");
    expect(sentMessages[0].options?.deliverAs).toBe("followUp");

    // 4. Turn 2 fails again (infinite retry)
    turnEnd({ type: "turn_end", turnIndex: 1, message: errorMsg, toolResults: [] }, ctx);
    agentSettled({ type: "agent_settled" }, ctx);
    vi.runAllTimers();

    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[1].content).toBe("Build a feature");

    // Turn 3 succeeds
    const successMsg = {
      role: "assistant",
      content: [{ type: "text", text: "Done!" }],
      stopReason: "stop",
    };
    turnEnd({ type: "turn_end", turnIndex: 2, message: successMsg, toolResults: [] }, ctx);

    // Persistent mode keeps status bar and widget active
    expect(ctx.statuses[PVP_STATUS_KEY]).toBe("● PVP ON");
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toEqual(["● PVP ON"]);

    vi.useRealTimers();
  });

  it("simulates /pvp one flow: failure -> retry -> success -> automatically closes", async () => {
    vi.useFakeTimers();
    const { api, handlers, commands, sentMessages } = createMockExtensionApi();
    pvpExtension(api);
    const ctx = createMockContext();

    // 1. User enters /pvp one
    const pvpCmd = commands.get("pvp");
    await pvpCmd.handler("one", ctx);
    expect(ctx.statuses[PVP_STATUS_KEY]).toBe("● PVP ONE");
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toEqual(["● PVP ONE"]);
    expect(ctx.widgets[PVP_WIDGET_KEY]?.options).toEqual({ placement: "belowEditor" });
    expect(ctx.notifications[0]?.msg).toBe("PVP ONE");

    // 2. User submits prompt
    const beforeAgentStart = handlers.get("before_agent_start")![0];
    beforeAgentStart({ type: "before_agent_start", prompt: "One shot prompt" }, ctx);

    // 3. Turn fails
    const turnEnd = handlers.get("turn_end")![0];
    const agentSettled = handlers.get("agent_settled")![0];

    const errorMsg = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Network error",
    };

    turnEnd({ type: "turn_end", turnIndex: 0, message: errorMsg, toolResults: [] }, ctx);
    agentSettled({ type: "agent_settled" }, ctx);
    vi.runAllTimers();

    expect(sentMessages).toHaveLength(1);
    expect(ctx.statuses[PVP_STATUS_KEY]).toBe("● PVP ONE (第 1 次重试)");
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toEqual(["● PVP ONE (第 1 次重试)"]);

    // 4. Retry turn succeeds
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

    vi.useRealTimers();
  });

  it("cleans up on session shutdown", async () => {
    const { api, handlers, commands } = createMockExtensionApi();
    pvpExtension(api);
    const ctx = createMockContext();

    const pvpCmd = commands.get("pvp");
    await pvpCmd.handler("", ctx);
    expect(ctx.statuses[PVP_STATUS_KEY]).toBe("● PVP ON");
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toEqual(["● PVP ON"]);

    const sessionShutdown = handlers.get("session_shutdown")![0];
    sessionShutdown({ type: "session_shutdown", reason: "quit" }, ctx);

    expect(ctx.statuses[PVP_STATUS_KEY]).toBeUndefined();
    expect(ctx.widgets[PVP_WIDGET_KEY]?.content).toBeUndefined();
  });
});
