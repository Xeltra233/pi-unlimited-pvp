import type {
  BeforeAgentStartEvent,
  ExtensionCommandContext,
  ExtensionUIContext,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

export const PVP_STATUS_KEY = "pi-unlimited-pvp";
export const PVP_WIDGET_KEY = "pi-unlimited-pvp";
export type PvpMode = "off" | "persistent" | "one";

export type PvpAgentMessage = TurnEndEvent["message"];
export type PvpImageContent = NonNullable<BeforeAgentStartEvent["images"]>[number];

export type PvpUi = Pick<ExtensionUIContext, "notify" | "setStatus"> & {
  setWidget?: ExtensionUIContext["setWidget"];
};
export type PvpCommandContext = Pick<ExtensionCommandContext, "ui">;

const COMMAND_MODES = ["on", "one", "off"] as const;

export interface TurnEndResult {
  shouldRetry: boolean;
  success: boolean;
}

/**
 * Owns the PVP state machine, prompt tracking, and retry orchestration.
 *
 * Supported modes:
 * - "persistent": /pvp or /pvp on. Retries infinitely without cooldown upon failure,
 *   and remains enabled even after success until manually turned off.
 * - "one": /pvp one. Retries infinitely without cooldown upon failure,
 *   and automatically turns off when the model response succeeds.
 * - "off": disabled, no retries, status bar hidden.
 */
export class PvpController {
  private mode: PvpMode = "off";
  private lastPrompt: string | undefined = undefined;
  private lastImages: PvpImageContent[] | undefined = undefined;
  private pendingRetry: boolean = false;
  private retryTimer: NodeJS.Timeout | undefined = undefined;
  private attemptCount: number = 0;
  private isRetrying: boolean = false;
  private lastError: string | undefined = undefined;

  get currentMode(): PvpMode {
    return this.mode;
  }

  get enabled(): boolean {
    return this.mode !== "off";
  }

  get isPendingRetry(): boolean {
    return this.pendingRetry;
  }

  get currentAttempt(): number {
    return this.attemptCount;
  }

  get recordedPrompt(): string | undefined {
    return this.lastPrompt;
  }

  get recordedImages(): PvpImageContent[] | undefined {
    return this.lastImages;
  }

  get hasTimer(): boolean {
    return this.retryTimer !== undefined;
  }

  get lastErrorMessage(): string | undefined {
    return this.lastError;
  }

  /** Update footer status and persistent widget docked below the editor. */
  private updateUi(ui: PvpUi): void {
    if (this.mode === "off") {
      ui.setStatus(PVP_STATUS_KEY, undefined);
      if (typeof ui.setWidget === "function") {
        ui.setWidget(PVP_WIDGET_KEY, undefined);
      }
      return;
    }

    const modeLabel = this.mode === "one" ? "PVP ONE" : "PVP ON";
    const statusText =
      this.attemptCount > 0
        ? `${modeLabel} (第 ${this.attemptCount} 次重试...)`
        : modeLabel;
    const widgetText = `⚔️ ${statusText}`;

    ui.setStatus(PVP_STATUS_KEY, statusText);
    if (typeof ui.setWidget === "function") {
      ui.setWidget(PVP_WIDGET_KEY, [widgetText], { placement: "belowEditor" });
    }
  }

  /** Enable resident mode or one-success mode. */
  enable(mode: Exclude<PvpMode, "off">, ui: PvpUi): void {
    this.cancelRetry();
    this.mode = mode;
    this.attemptCount = 0;
    this.lastError = undefined;
    this.updateUi(ui);
  }

  /** Disable PVP, cancel pending retries, and clear the footer status marker and widget. */
  disable(ui: PvpUi): void {
    this.cancelRetry();
    this.mode = "off";
    this.lastPrompt = undefined;
    this.lastImages = undefined;
    this.attemptCount = 0;
    this.lastError = undefined;
    this.updateUi(ui);
  }

  /** Record prompt and images submitted by the user or agent run. */
  recordPrompt(prompt: string, images?: PvpImageContent[]): void {
    this.lastPrompt = prompt;
    this.lastImages = images && images.length > 0 ? [...images] : undefined;
    if (!this.isRetrying && !this.pendingRetry) {
      this.attemptCount = 0;
    }
  }

  /**
   * Intercept message_end to bypass pi's built-in exponential backoff retry.
   *
   * By appending " <!-- quota exceeded -->" to the assistant error message,
   * pi's internal classifier treats it as non-retryable provider limit error,
   * completely bypassing pi's default 2s/4s backoff delay and maxRetries cap.
   * This allows PVP to immediately take over scheduling without cooldown.
   */
  handleMessageEnd(message: PvpAgentMessage): PvpAgentMessage | undefined {
    if (
      this.enabled &&
      message &&
      message.role === "assistant" &&
      "stopReason" in message &&
      message.stopReason === "error" &&
      "errorMessage" in message &&
      typeof message.errorMessage === "string" &&
      message.errorMessage.length > 0 &&
      !message.errorMessage.includes("quota exceeded")
    ) {
      return {
        ...message,
        errorMessage: `${message.errorMessage} <!-- quota exceeded -->`,
      };
    }
    return undefined;
  }

  /**
   * Handle turn_end event. Detects failures, successes, and aborts.
   */
  handleTurnEnd(message: PvpAgentMessage, ui: PvpUi): TurnEndResult {
    if (!this.enabled) {
      return { shouldRetry: false, success: false };
    }

    if (!message || message.role !== "assistant") {
      return { shouldRetry: false, success: false };
    }

    const stopReason = "stopReason" in message ? message.stopReason : undefined;

    // User or system abort: cancel any retry and never retry
    if (stopReason === "aborted") {
      this.cancelRetry();
      return { shouldRetry: false, success: false };
    }

    // Model turn failed: flag for retry
    if (stopReason === "error") {
      this.pendingRetry = true;
      this.lastError = "errorMessage" in message && typeof message.errorMessage === "string"
        ? message.errorMessage
        : "Unknown error";
      return { shouldRetry: true, success: false };
    }

    // Model turn succeeded with final answer (stop) or max length limit
    if (stopReason === "stop" || stopReason === "length") {
      this.pendingRetry = false;
      this.attemptCount = 0;
      this.lastError = undefined;

      if (this.mode === "one") {
        this.disable(ui);
        ui.notify("PVP 一次性模式：模型请求成功，已自动关闭", "info");
      } else {
        this.updateUi(ui);
      }
      return { shouldRetry: false, success: true };
    }

    // Intermediate steps like "toolUse" keep PVP active without triggering retry or closing
    return { shouldRetry: false, success: false };
  }

  /**
   * Schedule immediate retry without cooldown when pendingRetry is true.
   *
   * Uses setTimeout(..., 0) to yield execution back to the event loop,
   * ensuring pi has completely settled before the new message is dispatched.
   */
  scheduleRetry(
    sendFn: (prompt: string, images?: PvpImageContent[]) => void,
    ui: PvpUi
  ): boolean {
    if (!this.enabled || !this.pendingRetry || this.retryTimer !== undefined) {
      return false;
    }

    if (this.lastPrompt === undefined) {
      this.pendingRetry = false;
      return false;
    }

    this.pendingRetry = false;
    this.attemptCount++;
    const currentAttempt = this.attemptCount;
    const promptToRetry = this.lastPrompt;
    const imagesToRetry = this.lastImages ? [...this.lastImages] : undefined;

    this.updateUi(ui);
    ui.notify(`PVP: 请求失败，正在无延迟重试 (第 ${currentAttempt} 次)...`, "info");

    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.enabled) {
        return;
      }

      this.isRetrying = true;
      try {
        sendFn(promptToRetry, imagesToRetry);
      } finally {
        this.isRetrying = false;
      }
    }, 0);

    return true;
  }

  /** Cancel any pending retry timer and clear the pending retry flag. */
  cancelRetry(): void {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.pendingRetry = false;
  }

  /** Apply the public `/pvp [on|one|off]` command grammar. */
  handleCommand(args: string, ctx: PvpCommandContext): void {
    const command = args.trim().toLowerCase();

    if (command === "" || command === "on") {
      this.enable("persistent", ctx.ui);
      ctx.ui.notify("PVP 常驻模式已开启", "info");
      return;
    }

    if (command === "one") {
      this.enable("one", ctx.ui);
      ctx.ui.notify("PVP 一次性模式已开启：成功后自动关闭", "info");
      return;
    }

    if (command === "off") {
      this.disable(ctx.ui);
      ctx.ui.notify("PVP 已关闭", "info");
      return;
    }

    ctx.ui.notify("用法：/pvp、/pvp on、/pvp one 或 /pvp off", "warning");
  }

  /** Clear state during shutdown or other terminal cleanup paths. */
  cleanup(ui: PvpUi): void {
    this.disable(ui);
  }
}

export function getPvpArgumentCompletions(prefix: string): Array<{ value: string; label: string }> | null {
  const normalizedPrefix = prefix.trim().toLowerCase();
  const values = COMMAND_MODES.filter((value) => value.startsWith(normalizedPrefix));
  return values.length > 0 ? values.map((value) => ({ value, label: value })) : null;
}
