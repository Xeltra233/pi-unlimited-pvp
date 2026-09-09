import {
  AgentSession,
  type BeforeAgentStartEvent,
  type ExtensionCommandContext,
  type ExtensionUIContext,
  type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

export const PVP_STATUS_KEY = "pi-unlimited-pvp";
export const PVP_WIDGET_KEY = "pi-unlimited-pvp";
export type PvpMode = "off" | "persistent" | "one";

export type PvpAgentMessage = TurnEndEvent["message"];
export type PvpImageContent = NonNullable<BeforeAgentStartEvent["images"]>[number];

export type PvpUi = Pick<ExtensionUIContext, "notify" | "setStatus"> & {
  setWidget?: ExtensionUIContext["setWidget"];
  theme?: ExtensionUIContext["theme"];
};
export type PvpCommandContext = Pick<ExtensionCommandContext, "ui">;

const COMMAND_MODES = ["on", "one", "off"] as const;

export interface TurnEndResult {
  shouldRetry: boolean;
  success: boolean;
}

/**
 * Format status indicator text conforming to Pi native TUI styling.
 * Uses native theme muted/dim colors, clean lowercase text ('pvp on' / 'pvp one'),
 * matching the exact font size, baseline, and gray tone of native status bar items.
 */
export function formatPvpStatus(
  mode: Exclude<PvpMode, "off">,
  attemptCount: number = 0,
  theme?: ExtensionUIContext["theme"]
): string {
  const isOne = mode === "one";
  const label = isOne ? "pvp one" : "pvp on";

  const fg = (color: "accent" | "warning" | "muted" | "dim", text: string): string => {
    return theme ? theme.fg(color, text) : text;
  };

  let status = fg("muted", label);
  if (attemptCount > 0) {
    status += ` ${fg("dim", `(第 ${attemptCount} 次重试)`)}`;
  }
  return status;
}

/**
 * Owns the PVP state machine and retry orchestration.
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
  private retryInFlight: boolean = false;
  private lastError: string | undefined = undefined;
  private activeUi: PvpUi | undefined = undefined;

  get currentMode(): PvpMode {
    return this.mode;
  }

  get enabled(): boolean {
    return this.mode !== "off";
  }

  get isPendingRetry(): boolean {
    return this.pendingRetry;
  }

  get isRetryInFlight(): boolean {
    return this.retryInFlight;
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

  get lastUi(): PvpUi | undefined {
    return this.activeUi;
  }

  /** Update footer status and persistent widget docked below the editor with native styling and zero indentation. */
  updateUi(ui?: PvpUi): void {
    const targetUi = ui ?? this.activeUi;
    if (!targetUi) {
      return;
    }
    this.activeUi = targetUi;

    if (this.mode === "off") {
      targetUi.setStatus(PVP_STATUS_KEY, undefined);
      if (typeof targetUi.setWidget === "function") {
        targetUi.setWidget(PVP_WIDGET_KEY, undefined);
      }
      return;
    }

    const styledText = formatPvpStatus(this.mode, this.attemptCount, targetUi.theme);
    targetUi.setStatus(PVP_STATUS_KEY, styledText);

    if (typeof targetUi.setWidget === "function") {
      const mode = this.mode;
      const attemptCount = this.attemptCount;
      targetUi.setWidget(
        PVP_WIDGET_KEY,
        (_tui, theme) => ({
          render(_width: number): string[] {
            return [formatPvpStatus(mode, attemptCount, theme)];
          },
          invalidate(): void {},
        }),
        { placement: "belowEditor" }
      );
    }
  }

  /** Enable resident mode or one-success mode. */
  enable(mode: Exclude<PvpMode, "off">, ui?: PvpUi): void {
    this.cancelRetry();
    this.mode = mode;
    this.attemptCount = 0;
    this.retryInFlight = false;
    this.lastError = undefined;
    if (ui) {
      this.activeUi = ui;
    }
    this.updateUi(ui);
  }

  /** Disable PVP, cancel pending retries, and clear the footer status marker and widget. */
  disable(ui?: PvpUi): void {
    this.cancelRetry();
    this.mode = "off";
    this.lastPrompt = undefined;
    this.lastImages = undefined;
    this.attemptCount = 0;
    this.retryInFlight = false;
    this.lastError = undefined;
    if (ui) {
      this.activeUi = ui;
    }
    this.updateUi(ui);
  }

  /** Record prompt and images submitted by the user or agent run. */
  recordPrompt(prompt: string, images?: PvpImageContent[], ui?: PvpUi): void {
    this.lastPrompt = prompt;
    this.lastImages = images && images.length > 0 ? [...images] : undefined;

    if (this.retryInFlight) {
      this.retryInFlight = false;
    } else {
      this.cancelRetry();
      const hadAttempts = this.attemptCount > 0 || this.lastError !== undefined;
      this.attemptCount = 0;
      this.lastError = undefined;
      if (hadAttempts && ui && this.enabled) {
        this.updateUi(ui);
      }
    }
  }

  /**
   * Optional helper to mark an error message as quota exceeded if external callers request it.
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
   * Record a retry attempt during native in-place retry.
   * Increments attempt counter, updates UI, and emits notification.
   */
  recordRetryAttempt(ui?: PvpUi, error?: string): number {
    if (!this.enabled) {
      return 0;
    }
    this.attemptCount++;
    if (error) {
      this.lastError = error;
    }
    if (ui) {
      this.activeUi = ui;
    }
    this.updateUi(ui);
    const targetUi = ui ?? this.activeUi;
    if (targetUi) {
      targetUi.notify(`PVP: 请求失败，正在无延迟重试 (第 ${this.attemptCount} 次)...`, "info");
    }
    return this.attemptCount;
  }

  /**
   * Handle turn completion with success.
   * Resets attempt count to zero.
   * If in "one" mode, automatically disables PVP and notifies "PVP OFF".
   */
  handleSuccess(ui?: PvpUi): void {
    if (!this.enabled) {
      return;
    }
    this.pendingRetry = false;
    this.attemptCount = 0;
    this.retryInFlight = false;
    this.lastError = undefined;

    if (this.mode === "one") {
      this.disable(ui);
      const targetUi = ui ?? this.activeUi;
      targetUi?.notify("PVP OFF", "info");
    } else {
      this.updateUi(ui);
    }
  }

  /**
   * Handle user abort (Ctrl+C).
   * Resets retry attempt count and restores clean UI.
   */
  handleAbort(ui?: PvpUi): void {
    this.cancelRetry();
    this.attemptCount = 0;
    this.lastError = undefined;
    this.retryInFlight = false;
    if (this.enabled) {
      this.updateUi(ui);
    }
  }

  /**
   * Handle submission of a new prompt by the user.
   * Resets retry count to zero.
   */
  handleNewPrompt(ui?: PvpUi): void {
    if (ui) {
      this.activeUi = ui;
    }
    const hadAttempts = this.attemptCount > 0 || this.lastError !== undefined;
    this.attemptCount = 0;
    this.lastError = undefined;
    if (hadAttempts && this.enabled) {
      this.updateUi(ui);
    }
  }

  /**
   * Handle turn_end event. Detects failures, successes, and aborts.
   */
  handleTurnEnd(message: PvpAgentMessage, ui?: PvpUi): TurnEndResult {
    if (!this.enabled) {
      return { shouldRetry: false, success: false };
    }

    if (!message || message.role !== "assistant") {
      return { shouldRetry: false, success: false };
    }

    const stopReason = "stopReason" in message ? message.stopReason : undefined;

    // User or system abort: cancel any retry and clean up
    if (stopReason === "aborted") {
      this.handleAbort(ui);
      return { shouldRetry: false, success: false };
    }

    // Model turn failed: flag for retry
    if (stopReason === "error") {
      this.pendingRetry = true;
      this.retryInFlight = false;
      this.lastError =
        "errorMessage" in message && typeof message.errorMessage === "string"
          ? message.errorMessage
          : "Unknown error";
      return { shouldRetry: true, success: false };
    }

    // Model turn succeeded with final answer (stop) or max length limit
    if (stopReason === "stop" || stopReason === "length") {
      this.handleSuccess(ui);
      return { shouldRetry: false, success: true };
    }

    // Intermediate steps like "toolUse" keep PVP active without triggering retry or closing
    return { shouldRetry: false, success: false };
  }

  /**
   * Schedule retry helper for unit tests or manual dispatchers.
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

      this.retryInFlight = true;
      try {
        sendFn(promptToRetry, imagesToRetry);
      } catch (error) {
        this.retryInFlight = false;
        throw error;
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
    this.retryInFlight = false;
  }

  /** Apply the public `/pvp [on|one|off]` command grammar. */
  handleCommand(args: string, ctx: PvpCommandContext): void {
    this.activeUi = ctx.ui;
    const command = args.trim().toLowerCase();

    if (command === "" || command === "on") {
      this.enable("persistent", ctx.ui);
      ctx.ui.notify("PVP ON", "info");
      return;
    }

    if (command === "one") {
      this.enable("one", ctx.ui);
      ctx.ui.notify("PVP ONE", "info");
      return;
    }

    if (command === "off") {
      this.disable(ctx.ui);
      ctx.ui.notify("PVP OFF", "info");
      return;
    }

    ctx.ui.notify("用法：/pvp、/pvp on、/pvp one 或 /pvp off", "warning");
  }

  /** Clear state during shutdown or other terminal cleanup paths. */
  cleanup(ui?: PvpUi): void {
    this.disable(ui);
  }
}

let activeHookCleanup: (() => void) | undefined = undefined;

/**
 * Install the native AgentSession prototype retry hooks.
 *
 * Intercepts Pi core's `_isRetryableError` and `_prepareRetry`:
 * - When PVP is active, any assistant error (except context overflow and user abort)
 *   is treated as retryable.
 * - `_prepareRetry` pops the failed assistant message from `agent.state.messages`
 *   and yields immediately (0ms delay), returning true.
 * - Pi core's `while (await this._handlePostAgentRun())` then executes
 *   `await this.agent.continue()`, performing a true in-place native retry
 *   WITHOUT sending any user messages.
 */
export function installPvpRetryHook(controller: PvpController): () => void {
  activeHookCleanup?.();

  try {
    const sessionProto = AgentSession.prototype as any;
    const origIsRetryable = sessionProto._isRetryableError;
    const origPrepareRetry = sessionProto._prepareRetry;

    sessionProto._isRetryableError = function (message: any): boolean {
      if (controller.enabled) {
        if (message?.stopReason === "aborted") return false;
        if (origIsRetryable && origIsRetryable.call(this, message)) return true;
        const errorText = (message?.errorMessage || "").toLowerCase();
        const isOverflow =
          errorText.includes("context") &&
          (errorText.includes("overflow") ||
            errorText.includes("too long") ||
            errorText.includes("exceed"));
        if (isOverflow) return false;
        if (message?.stopReason === "error") return true;
      }
      return origIsRetryable ? origIsRetryable.call(this, message) : false;
    };

    sessionProto._prepareRetry = async function (message: any): Promise<boolean> {
      if (controller.enabled) {
        const self = this as any;
        const ui = self._extensionUIContext;
        const error = typeof message?.errorMessage === "string" ? message.errorMessage : undefined;
        controller.recordRetryAttempt(ui, error);

        // Remove error assistant message from agent state so agent continues in place
        const messages = self.agent?.state?.messages;
        if (
          Array.isArray(messages) &&
          messages.length > 0 &&
          messages[messages.length - 1]?.role === "assistant"
        ) {
          self.agent.state.messages = messages.slice(0, -1);
        }

        // Yield immediately to event loop with abort signal check
        self._retryAbortController = new AbortController();
        try {
          await new Promise<void>((resolve, reject) => {
            const signal = self._retryAbortController?.signal;
            if (signal?.aborted) return reject(new Error("Aborted"));
            const timer = setTimeout(resolve, 0);
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(new Error("Aborted"));
              },
              { once: true }
            );
          });
        } catch {
          self._retryAttempt = 0;
          controller.handleAbort(ui);
          return false;
        } finally {
          self._retryAbortController = undefined;
        }

        return true;
      }
      return origPrepareRetry ? origPrepareRetry.call(this, message) : false;
    };

    const cleanup = () => {
      sessionProto._isRetryableError = origIsRetryable;
      sessionProto._prepareRetry = origPrepareRetry;
    };
    activeHookCleanup = cleanup;
    return cleanup;
  } catch {
    return () => {};
  }
}

export function getPvpArgumentCompletions(prefix: string): Array<{ value: string; label: string }> | null {
  const normalizedPrefix = prefix.trim().toLowerCase();
  const values = COMMAND_MODES.filter((value) => value.startsWith(normalizedPrefix));
  return values.length > 0 ? values.map((value) => ({ value, label: value })) : null;
}
