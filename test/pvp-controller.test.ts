import { describe, expect, it, vi } from "vitest";
import {
  formatPvpStatus,
  getPvpArgumentCompletions,
  PvpController,
  PVP_STATUS_KEY,
  PVP_WIDGET_KEY,
  type PvpAgentMessage,
  type PvpUi,
} from "../src/pvp-controller.js";

function createMockUi(): PvpUi & {
  statuses: Record<string, string | undefined>;
  widgets: Record<string, { content: string[] | undefined; options?: any }>;
  notifications: Array<{ msg: string; type?: string }>;
} {
  const statuses: Record<string, string | undefined> = {};
  const widgets: Record<string, { content: string[] | undefined; options?: any }> = {};
  const notifications: Array<{ msg: string; type?: string }> = [];

  return {
    statuses,
    widgets,
    notifications,
    setStatus: vi.fn((key: string, value: string | undefined) => {
      statuses[key] = value;
    }),
    setWidget: vi.fn((key: string, content: any, options?: any) => {
      widgets[key] = { content, options };
    }),
    notify: vi.fn((msg: string, type?: "info" | "warning" | "error") => {
      notifications.push({ msg, type });
    }),
  };
}

describe("PvpController State & Commands", () => {
  it("starts in 'off' mode with no status bar marker", () => {
    const controller = new PvpController();
    expect(controller.currentMode).toBe("off");
    expect(controller.enabled).toBe(false);
    expect(controller.isPendingRetry).toBe(false);
    expect(controller.currentAttempt).toBe(0);
    expect(controller.hasTimer).toBe(false);
  });

  it("handles '/pvp' and '/pvp on' to enable persistent mode", () => {
    const controller = new PvpController();
    const ui = createMockUi();

    controller.handleCommand("", { ui });
    expect(controller.currentMode).toBe("persistent");
    expect(controller.enabled).toBe(true);
    expect(ui.statuses[PVP_STATUS_KEY]).toBe("● PVP ON");
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["● PVP ON"]);
    expect(ui.widgets[PVP_WIDGET_KEY]?.options).toEqual({ placement: "belowEditor" });
    expect(ui.notifications[0]?.msg).toBe("PVP ON");

    controller.handleCommand("on", { ui });
    expect(controller.currentMode).toBe("persistent");
    expect(ui.statuses[PVP_STATUS_KEY]).toBe("● PVP ON");
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["● PVP ON"]);
    expect(ui.notifications[1]?.msg).toBe("PVP ON");
  });

  it("handles '/pvp one' to enable one-success mode", () => {
    const controller = new PvpController();
    const ui = createMockUi();

    controller.handleCommand("one", { ui });
    expect(controller.currentMode).toBe("one");
    expect(controller.enabled).toBe(true);
    expect(ui.statuses[PVP_STATUS_KEY]).toBe("● PVP ONE");
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["● PVP ONE"]);
    expect(ui.widgets[PVP_WIDGET_KEY]?.options).toEqual({ placement: "belowEditor" });
    expect(ui.notifications[0]?.msg).toBe("PVP ONE");
  });

  it("handles '/pvp off' to disable and clear status and widget", () => {
    const controller = new PvpController();
    const ui = createMockUi();

    controller.enable("persistent", ui);
    expect(ui.statuses[PVP_STATUS_KEY]).toBe("● PVP ON");
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["● PVP ON"]);

    controller.handleCommand("off", { ui });
    expect(controller.currentMode).toBe("off");
    expect(controller.enabled).toBe(false);
    expect(ui.statuses[PVP_STATUS_KEY]).toBeUndefined();
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toBeUndefined();
    expect(ui.notifications.some((n) => n.msg === "PVP OFF")).toBe(true);
  });

  it("warns on unknown command and preserves mode", () => {
    const controller = new PvpController();
    const ui = createMockUi();

    controller.enable("persistent", ui);
    controller.handleCommand("unknown-arg", { ui });

    expect(controller.currentMode).toBe("persistent");
    expect(ui.notifications.some((n) => n.type === "warning")).toBe(true);
  });

  it("provides argument completions correctly", () => {
    expect(getPvpArgumentCompletions("")).toEqual([
      { value: "on", label: "on" },
      { value: "one", label: "one" },
      { value: "off", label: "off" },
    ]);
    expect(getPvpArgumentCompletions("o")).toEqual([
      { value: "on", label: "on" },
      { value: "one", label: "one" },
      { value: "off", label: "off" },
    ]);
    expect(getPvpArgumentCompletions("on")).toEqual([
      { value: "on", label: "on" },
      { value: "one", label: "one" },
    ]);
    expect(getPvpArgumentCompletions("of")).toEqual([
      { value: "off", label: "off" },
    ]);
    expect(getPvpArgumentCompletions("invalid")).toBeNull();
  });
});

describe("PvpController Prompt Recording & Message Interception", () => {
  it("records prompt text and image attachments", () => {
    const controller = new PvpController();
    controller.recordPrompt("Test prompt", [{ type: "image", data: "base64", mimeType: "image/png" }]);

    expect(controller.recordedPrompt).toBe("Test prompt");
    expect(controller.recordedImages).toHaveLength(1);
    expect(controller.recordedImages?.[0]?.type).toBe("image");
  });

  it("intercepts message_end on error to bypass pi built-in backoff when PVP is enabled", () => {
    const controller = new PvpController();
    const ui = createMockUi();

    const errorMessage: PvpAgentMessage = {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      stopReason: "error",
      errorMessage: "Rate limit reached (429)",
      timestamp: Date.now(),
    };

    // When disabled, should not modify
    expect(controller.handleMessageEnd(errorMessage)).toBeUndefined();

    // When enabled, appends bypass marker
    controller.enable("persistent", ui);
    const modified = controller.handleMessageEnd(errorMessage);
    expect(modified).toBeDefined();
    expect(modified?.errorMessage).toContain("Rate limit reached (429)");
    expect(modified?.errorMessage).toContain("quota exceeded");

    // Idempotent: should not duplicate marker
    if (modified) {
      expect(controller.handleMessageEnd(modified)).toBeUndefined();
    }
  });

  it("does not intercept non-error or non-assistant messages", () => {
    const controller = new PvpController();
    const ui = createMockUi();
    controller.enable("persistent", ui);

    const successMessage: PvpAgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "OK" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    expect(controller.handleMessageEnd(successMessage)).toBeUndefined();
  });
});

describe("PvpController Turn Outcomes & Retries", () => {
  it("flags pending retry upon error in persistent mode", () => {
    const controller = new PvpController();
    const ui = createMockUi();
    controller.enable("persistent", ui);

    const errorMessage: PvpAgentMessage = {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      stopReason: "error",
      errorMessage: "Connection dropped",
      timestamp: Date.now(),
    };

    const result = controller.handleTurnEnd(errorMessage, ui);
    expect(result.shouldRetry).toBe(true);
    expect(result.success).toBe(false);
    expect(controller.isPendingRetry).toBe(true);
    expect(controller.lastErrorMessage).toBe("Connection dropped");
  });

  it("schedules retry without cooldown and dispatches sendFn", async () => {
    vi.useFakeTimers();
    const controller = new PvpController();
    const ui = createMockUi();
    controller.enable("persistent", ui);
    controller.recordPrompt("My original task");

    const errorMessage: PvpAgentMessage = {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      stopReason: "error",
      errorMessage: "Connection dropped",
      timestamp: Date.now(),
    };

    controller.handleTurnEnd(errorMessage, ui);

    const sendFn = vi.fn();
    const scheduled = controller.scheduleRetry(sendFn, ui);
    expect(scheduled).toBe(true);
    expect(controller.currentAttempt).toBe(1);
    expect(controller.hasTimer).toBe(true);
    expect(ui.notifications.some((n) => n.msg.includes("正在无延迟重试 (第 1 次)"))).toBe(true);

    // Concurrency guard: calling scheduleRetry again before timer elapses returns false
    expect(controller.scheduleRetry(sendFn, ui)).toBe(false);

    // Fast-forward immediate timer
    vi.runAllTimers();

    expect(controller.hasTimer).toBe(false);
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(sendFn).toHaveBeenCalledWith("My original task", undefined);

    vi.useRealTimers();
  });

  it("retries infinitely across multiple consecutive failures", async () => {
    vi.useFakeTimers();
    const controller = new PvpController();
    const ui = createMockUi();
    controller.enable("persistent", ui);
    controller.recordPrompt("Infinite test");

    const errorMessage: PvpAgentMessage = {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      stopReason: "error",
      errorMessage: "503 Service Unavailable",
      timestamp: Date.now(),
    };

    const sendFn = vi.fn();

    for (let i = 1; i <= 10; i++) {
      controller.handleTurnEnd(errorMessage, ui);
      expect(controller.isPendingRetry).toBe(true);
      controller.scheduleRetry(sendFn, ui);
      expect(controller.currentAttempt).toBe(i);
      vi.runAllTimers();
      expect(sendFn).toHaveBeenCalledTimes(i);
    }

    vi.useRealTimers();
  });

  it("persistent mode remains enabled after success", () => {
    const controller = new PvpController();
    const ui = createMockUi();
    controller.enable("persistent", ui);

    const successMessage: PvpAgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Answer" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    const result = controller.handleTurnEnd(successMessage, ui);
    expect(result.success).toBe(true);
    expect(result.shouldRetry).toBe(false);
    expect(controller.enabled).toBe(true);
    expect(controller.currentMode).toBe("persistent");
    expect(ui.statuses[PVP_STATUS_KEY]).toBe("● PVP ON");
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["● PVP ON"]);
  });

  it("one mode automatically closes upon success and removes status and widget", () => {
    const controller = new PvpController();
    const ui = createMockUi();
    controller.enable("one", ui);
    expect(ui.statuses[PVP_STATUS_KEY]).toBe("● PVP ONE");
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["● PVP ONE"]);

    const successMessage: PvpAgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Answer" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    const result = controller.handleTurnEnd(successMessage, ui);
    expect(result.success).toBe(true);
    expect(result.shouldRetry).toBe(false);
    expect(controller.enabled).toBe(false);
    expect(controller.currentMode).toBe("off");
    expect(ui.statuses[PVP_STATUS_KEY]).toBeUndefined();
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toBeUndefined();
    expect(ui.notifications.some((n) => n.msg === "PVP OFF")).toBe(true);
  });

  it("one mode does not close on intermediate toolUse turns", () => {
    const controller = new PvpController();
    const ui = createMockUi();
    controller.enable("one", ui);
    expect(ui.statuses[PVP_STATUS_KEY]).toBe("● PVP ONE");
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["● PVP ONE"]);

    const toolUseMessage: PvpAgentMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "t1", name: "bash", args: {} }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      stopReason: "toolUse",
      timestamp: Date.now(),
    };

    const result = controller.handleTurnEnd(toolUseMessage, ui);
    expect(result.success).toBe(false);
    expect(result.shouldRetry).toBe(false);
    expect(controller.enabled).toBe(true);
    expect(controller.currentMode).toBe("one");
    expect(ui.statuses[PVP_STATUS_KEY]).toBe("● PVP ONE");
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["● PVP ONE"]);
  });
});

describe("PvpController Abort & Lifecycle Cleanup", () => {
  it("cancels retry and does not retry when turn is aborted", () => {
    const controller = new PvpController();
    const ui = createMockUi();
    controller.enable("persistent", ui);

    // First an error flags pending retry
    controller.handleTurnEnd({
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "m",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      stopReason: "error",
      timestamp: Date.now(),
    }, ui);
    expect(controller.isPendingRetry).toBe(true);

    // Then user aborts
    const abortResult = controller.handleTurnEnd({
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "m",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      stopReason: "aborted",
      timestamp: Date.now(),
    }, ui);

    expect(abortResult.shouldRetry).toBe(false);
    expect(controller.isPendingRetry).toBe(false);
    expect(controller.hasTimer).toBe(false);
  });

  it("cancels timer and clears status on cleanup", () => {
    vi.useFakeTimers();
    const controller = new PvpController();
    const ui = createMockUi();
    controller.enable("persistent", ui);
    controller.recordPrompt("Prompt");

    controller.handleTurnEnd({
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "m",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      stopReason: "error",
      timestamp: Date.now(),
    }, ui);

    const sendFn = vi.fn();
    controller.scheduleRetry(sendFn, ui);
    expect(controller.hasTimer).toBe(true);

    controller.cleanup(ui);
    expect(controller.hasTimer).toBe(false);
    expect(controller.enabled).toBe(false);
    expect(ui.statuses[PVP_STATUS_KEY]).toBeUndefined();
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toBeUndefined();

    vi.runAllTimers();
    expect(sendFn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("updates widget and status with retry count during scheduling", () => {
    const controller = new PvpController();
    const ui = createMockUi();
    controller.enable("persistent", ui);
    controller.recordPrompt("Test prompt");

    controller.handleTurnEnd({
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "m",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      stopReason: "error",
      timestamp: Date.now(),
    }, ui);

    const sendFn = vi.fn();
    controller.scheduleRetry(sendFn, ui);

    expect(ui.statuses[PVP_STATUS_KEY]).toBe("● PVP ON (第 1 次重试)");
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["● PVP ON (第 1 次重试)"]);
    expect(ui.widgets[PVP_WIDGET_KEY]?.options).toEqual({ placement: "belowEditor" });
  });

  it("formats status with native theme colors and styling", () => {
    const mockTheme = {
      fg: vi.fn((color: string, text: string) => `[fg:${color}]${text}[/fg]`),
      bold: vi.fn((text: string) => `[b]${text}[/b]`),
      dim: vi.fn((text: string) => `[dim]${text}[/dim]`),
    } as any;

    const persistentStatus = formatPvpStatus("persistent", 0, mockTheme);
    expect(persistentStatus).toBe("[fg:accent]●[/fg] [b][fg:accent]PVP[/fg][/b] [fg:accent]ON[/fg]");

    const oneStatus = formatPvpStatus("one", 2, mockTheme);
    expect(oneStatus).toBe(
      "[fg:warning]●[/fg] [b][fg:warning]PVP[/fg][/b] [fg:warning]ONE[/fg] [fg:dim](第 2 次重试)[/fg]"
    );
  });

  it("works gracefully when setWidget is undefined (headless / minimal UI context)", () => {
    const controller = new PvpController();
    const headlessUi: PvpUi = {
      setStatus: vi.fn(),
      notify: vi.fn(),
    };

    expect(() => {
      controller.enable("persistent", headlessUi);
      controller.recordPrompt("prompt");
      controller.handleTurnEnd({
        role: "assistant",
        content: [],
        stopReason: "error",
      }, headlessUi);
      controller.scheduleRetry(vi.fn(), headlessUi);
      controller.disable(headlessUi);
    }).not.toThrow();

    expect(headlessUi.setStatus).toHaveBeenCalledWith(PVP_STATUS_KEY, "● PVP ON");
    expect(headlessUi.setStatus).toHaveBeenCalledWith(PVP_STATUS_KEY, "● PVP ON (第 1 次重试)");
    expect(headlessUi.setStatus).toHaveBeenCalledWith(PVP_STATUS_KEY, undefined);
  });
});
