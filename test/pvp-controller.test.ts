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
      let resolvedContent: string[] | undefined;
      if (typeof content === "function") {
        const comp = content({}, undefined);
        resolvedContent = comp?.render?.(80);
      } else {
        resolvedContent = content;
      }
      widgets[key] = { content: resolvedContent, options };
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
    expect(ui.statuses[PVP_STATUS_KEY]).toBe("pvp on");
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on"]);
    expect(ui.widgets[PVP_WIDGET_KEY]?.options).toEqual({ placement: "belowEditor" });
    expect(ui.notifications[0]?.msg).toBe("PVP ON");

    controller.handleCommand("on", { ui });
    expect(controller.currentMode).toBe("persistent");
    expect(ui.statuses[PVP_STATUS_KEY]).toBe("pvp on");
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on"]);
    expect(ui.notifications[1]?.msg).toBe("PVP ON");
  });

  it("handles '/pvp <n>' to enable bounded mode that turns off after n successes", () => {
    const controller = new PvpController();
    const ui = createMockUi();

    controller.handleCommand("3", { ui });
    expect(controller.currentMode).toBe("limited");
    expect(controller.currentSuccessTarget).toBe(3);
    expect(controller.currentSuccessCount).toBe(0);
    expect(controller.enabled).toBe(true);
    expect(ui.statuses[PVP_STATUS_KEY]).toBe("pvp 3");
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp 3"]);
    expect(ui.widgets[PVP_WIDGET_KEY]?.options).toEqual({ placement: "belowEditor" });
    expect(ui.notifications[0]?.msg).toBe("PVP 3");

    // Multi-digit targets and re-enabling with another target
    controller.handleCommand("12", { ui });
    expect(controller.currentSuccessTarget).toBe(12);
    expect(ui.statuses[PVP_STATUS_KEY]).toBe("pvp 12");
    expect(ui.notifications[1]?.msg).toBe("PVP 12");
  });

  it("rejects non-positive and non-numeric targets and the removed 'one' keyword", () => {
    const controller = new PvpController();
    const ui = createMockUi();

    for (const arg of ["0", "-2", "1.5", "one", "abc"]) {
      ui.notifications.length = 0;
      controller.handleCommand(arg, { ui });
      expect(controller.enabled).toBe(false);
      expect(ui.notifications[0]?.type).toBe("warning");
    }
  });

  it("handles '/pvp off' to disable and clear status and widget", () => {
    const controller = new PvpController();
    const ui = createMockUi();

    controller.enable("persistent", ui);
    expect(ui.statuses[PVP_STATUS_KEY]).toBe("pvp on");
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on"]);

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
      { value: "off", label: "off" },
    ]);
    expect(getPvpArgumentCompletions("o")).toEqual([
      { value: "on", label: "on" },
      { value: "off", label: "off" },
    ]);
    expect(getPvpArgumentCompletions("on")).toEqual([
      { value: "on", label: "on" },
    ]);
    expect(getPvpArgumentCompletions("of")).toEqual([
      { value: "off", label: "off" },
    ]);
    expect(getPvpArgumentCompletions("3")).toBeNull();
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
      // Simulate Pi firing before_agent_start on the retried run:
      controller.recordPrompt("Infinite test");
      // Counter must be preserved and NOT reset to zero!
      expect(controller.currentAttempt).toBe(i);
    }

    vi.useRealTimers();
  });

  it("resets retry count on success, and restarts count from 1 on subsequent failure", () => {
    vi.useFakeTimers();
    const controller = new PvpController();
    const ui = createMockUi();
    controller.enable("persistent", ui);
    controller.recordPrompt("Task 1");

    const errorMessage: PvpAgentMessage = {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "m",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      stopReason: "error",
      errorMessage: "500 Error",
      timestamp: Date.now(),
    };

    const sendFn = vi.fn();

    // Round 1: fail -> retry (attempt 1)
    controller.handleTurnEnd(errorMessage, ui);
    controller.scheduleRetry(sendFn, ui);
    expect(controller.currentAttempt).toBe(1);
    expect(ui.statuses[PVP_STATUS_KEY]).toBe("pvp on (第 1 次重试)");
    vi.runAllTimers();
    controller.recordPrompt("Task 1");
    expect(controller.currentAttempt).toBe(1);

    // Round 2: fail -> retry (attempt 2)
    controller.handleTurnEnd(errorMessage, ui);
    controller.scheduleRetry(sendFn, ui);
    expect(controller.currentAttempt).toBe(2);
    expect(ui.statuses[PVP_STATUS_KEY]).toBe("pvp on (第 2 次重试)");
    vi.runAllTimers();
    controller.recordPrompt("Task 1");
    expect(controller.currentAttempt).toBe(2);

    // Round 3: succeeds!
    const successMessage: PvpAgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Done" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "m",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const successResult = controller.handleTurnEnd(successMessage, ui);
    expect(successResult.success).toBe(true);
    // Count must be reset to 0!
    expect(controller.currentAttempt).toBe(0);
    // Status must be restored to clean "pvp on" without attempt counter
    expect(ui.statuses[PVP_STATUS_KEY]).toBe("pvp on");
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on"]);

    // Subsequent prompt or failure must restart count from 1!
    controller.recordPrompt("Task 2", undefined, ui);
    expect(controller.currentAttempt).toBe(0);

    controller.handleTurnEnd(errorMessage, ui);
    controller.scheduleRetry(sendFn, ui);
    expect(controller.currentAttempt).toBe(1);
    expect(ui.statuses[PVP_STATUS_KEY]).toBe("pvp on (第 1 次重试)");
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on (第 1 次重试)"]);

    vi.useRealTimers();
  });

  it("resets retry count and cleans UI when a brand new user prompt is submitted", () => {
    vi.useFakeTimers();
    const controller = new PvpController();
    const ui = createMockUi();
    controller.enable("persistent", ui);
    controller.recordPrompt("Task A");

    const errorMessage: PvpAgentMessage = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Fail",
    };

    const sendFn = vi.fn();
    controller.handleTurnEnd(errorMessage, ui);
    controller.scheduleRetry(sendFn, ui);
    expect(controller.currentAttempt).toBe(1);
    expect(ui.statuses[PVP_STATUS_KEY]).toBe("pvp on (第 1 次重试)");

    // User submits a new prompt manually before/during retry:
    controller.recordPrompt("Brand new task B", undefined, ui);
    expect(controller.currentAttempt).toBe(0);
    expect(controller.recordedPrompt).toBe("Brand new task B");
    expect(ui.statuses[PVP_STATUS_KEY]).toBe("pvp on");
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on"]);

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
    expect(ui.statuses[PVP_STATUS_KEY]).toBe("pvp on");
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on"]);
  });

  it("bounded mode closes automatically after the n-th success and removes status and widget", () => {
    const controller = new PvpController();
    const ui = createMockUi();
    controller.enable("limited", ui, 1);
    expect(ui.statuses[PVP_STATUS_KEY]).toBe("pvp 1");
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp 1"]);

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
    expect(ui.notifications.some((n) => n.msg === "PVP OFF (已达 1 次成功)")).toBe(true);
  });

  it("bounded mode does not close on intermediate toolUse turns", () => {
    const controller = new PvpController();
    const ui = createMockUi();
    controller.enable("limited", ui, 2);
    expect(ui.statuses[PVP_STATUS_KEY]).toBe("pvp 2");
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp 2"]);

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
    expect(controller.currentMode).toBe("limited");
    expect(controller.currentSuccessCount).toBe(0);
    expect(ui.statuses[PVP_STATUS_KEY]).toBe("pvp 2");
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp 2"]);
  });

  it("bounded mode counts successes only, keeps PVP on until the n-th success, then closes", () => {
    const controller = new PvpController();
    const ui = createMockUi();
    controller.handleCommand("3", { ui });

    const success: PvpAgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const failure: PvpAgentMessage = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Upstream stream disconnected",
      timestamp: Date.now(),
    };

    // Failures never consume the success target
    controller.handleTurnEnd(failure, ui);
    expect(controller.currentSuccessCount).toBe(0);
    expect(controller.enabled).toBe(true);

    controller.handleTurnEnd(success, ui);
    expect(controller.currentSuccessCount).toBe(1);
    expect(controller.enabled).toBe(true);
    expect(ui.statuses[PVP_STATUS_KEY]).toBe("pvp 3 (1/3)");
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp 3 (1/3)"]);

    controller.handleTurnEnd(success, ui);
    expect(controller.currentSuccessCount).toBe(2);
    expect(ui.statuses[PVP_STATUS_KEY]).toBe("pvp 3 (2/3)");

    const result = controller.handleTurnEnd(success, ui);
    expect(result.success).toBe(true);
    expect(controller.enabled).toBe(false);
    expect(controller.currentMode).toBe("off");
    expect(ui.statuses[PVP_STATUS_KEY]).toBeUndefined();
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toBeUndefined();
    expect(ui.notifications.some((n) => n.msg === "PVP OFF (已达 3 次成功)")).toBe(true);
  });

  it("recognises only the recorded stream-disconnect failure as the force-retry abort case", () => {
    const controller = new PvpController();
    const ui = createMockUi();
    const errorMessage: PvpAgentMessage = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Upstream stream disconnected",
      timestamp: 1,
    };

    // Disabled: never treats an abort as a retryable failure
    expect(controller.shouldForceRetryOverAbort(errorMessage)).toBe(false);

    controller.enable("persistent", ui);
    // Enabled but nothing failed yet
    expect(controller.shouldForceRetryOverAbort(errorMessage)).toBe(false);

    controller.handleTurnEnd(errorMessage, ui);
    expect(controller.shouldForceRetryOverAbort(errorMessage)).toBe(true);
    // Only the recorded failure instance qualifies
    expect(controller.shouldForceRetryOverAbort({ ...errorMessage, timestamp: 2 })).toBe(false);
    expect(controller.shouldForceRetryOverAbort({ ...errorMessage, errorMessage: "rate limit" })).toBe(false);
    expect(controller.shouldForceRetryOverAbort(undefined)).toBe(false);

    // Unrelated failures replace the recorded turn and are not force-retryable
    const other: PvpAgentMessage = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "different failure",
      timestamp: 2,
    };
    controller.handleTurnEnd(other, ui);
    expect(controller.shouldForceRetryOverAbort(errorMessage)).toBe(false);
    expect(controller.shouldForceRetryOverAbort(other)).toBe(false);

    // A success clears the recorded failure
    controller.handleTurnEnd({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      stopReason: "stop",
      timestamp: 3,
    } as PvpAgentMessage, ui);
    expect(controller.shouldForceRetryOverAbort(other)).toBe(false);
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
    expect(controller.currentAttempt).toBe(0);
    expect(ui.statuses[PVP_STATUS_KEY]).toBe("pvp on");
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on"]);
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

    expect(ui.statuses[PVP_STATUS_KEY]).toBe("pvp on (第 1 次重试)");
    expect(ui.widgets[PVP_WIDGET_KEY]?.content).toEqual(["pvp on (第 1 次重试)"]);
    expect(ui.widgets[PVP_WIDGET_KEY]?.options).toEqual({ placement: "belowEditor" });
  });

  it("formats status with native theme colors and styling", () => {
    const mockTheme = {
      fg: vi.fn((color: string, text: string) => `[fg:${color}]${text}[/fg]`),
      bold: vi.fn((text: string) => `[b]${text}[/b]`),
      dim: vi.fn((text: string) => `[dim]${text}[/dim]`),
    } as any;

    const persistentStatus = formatPvpStatus("persistent", 0, mockTheme);
    expect(persistentStatus).toBe("[fg:muted]pvp on[/fg]");

    const boundedStatus = formatPvpStatus("limited", 2, mockTheme, 3, 1);
    expect(boundedStatus).toBe("[fg:muted]pvp 3[/fg] [fg:dim](1/3)[/fg] [fg:dim](第 2 次重试)[/fg]");
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

    expect(headlessUi.setStatus).toHaveBeenCalledWith(PVP_STATUS_KEY, "pvp on");
    expect(headlessUi.setStatus).toHaveBeenCalledWith(PVP_STATUS_KEY, "pvp on (第 1 次重试)");
    expect(headlessUi.setStatus).toHaveBeenCalledWith(PVP_STATUS_KEY, undefined);
  });
});
