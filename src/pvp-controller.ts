import {
  AgentSession,
  type BeforeAgentStartUserEvent,
  type ExtensionCommandContext,
  type ExtensionUIContext,
  type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

export const PVP_STATUS_KEY = "pi-unlimited-pvp";
export const PVP_WIDGET_KEY = "pi-unlimited-pvp";
export type PvpMode = "off" | "persistent" | "limited";

export type PvpAgentMessage = TurnEndEvent["message"];
export type PvpImageContent = NonNullable<BeforeAgentStartUserEvent["images"]>[number];

export type PvpUi = Pick<ExtensionUIContext, "notify" | "setStatus"> & {
  setWidget?: ExtensionUIContext["setWidget"];
  theme?: ExtensionUIContext["theme"];
};
export type PvpCommandContext = Pick<ExtensionCommandContext, "ui">;

const COMMAND_MODES = ["on", "off"] as const;

/**
 * Provider/transport failures that must always be retried while PVP is enabled —
 * even when another extension (e.g. goal) reacts to the very same failure by
 * aborting the run. Matched case-insensitively against the assistant
 * `errorMessage`. "Upstream stream disconnected" from a dropped upstream stream
 * is the canonical case. Retrying such a failure is unconditional while PVP is on.
 */
export const PVP_FORCE_RETRY_PATTERN = /stream\s+disconnected/i;

/**
 * Context-overflow / context-window exhaustion signals.
 *
 * These are the provider-side error texts Pi itself treats as "the prompt no
 * longer fits". They are NOT retryable transport failures: retrying the exact
 * same prompt can never succeed, and it would starve Pi's own overflow
 * recovery (compact the session, then retry once). Pi's `_isRetryableError`
 * already excludes them via `isContextOverflow()`, so PVP must exclude them
 * too instead of falling back to "any stopReason === error is retryable".
 *
 * Kept as a local pattern list (mirroring the providers Pi detects) so the
 * retry hook never depends on a transitive `@earendil-works/pi-ai` import that
 * may resolve to a different instance than the host's.
 */
export const PVP_CONTEXT_OVERFLOW_PATTERNS: RegExp[] = [
  /prompt (?:is )?too long/i,
  /prompt exceeds max length/i,
  /request_too_large/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  /input \(\d+ tokens\) is longer than the model'?s context length/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /too large for model with \d+ maximum context length/i,
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
  /model_context_window_exceeded/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /range of input length should be/i,
  /context[_ ]length[_ ]exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
];

/**
 * Rate-limit / quota wording that also contains overflow-ish phrases
 * ("too many tokens" from Bedrock throttling) and must stay retryable.
 */
const PVP_NON_OVERFLOW_PATTERNS: RegExp[] = [
  /^(Throttling error|Service unavailable):/i,
  /rate limit/i,
  /too many requests/i,
];

/**
 * True when the failed assistant message reports context-window exhaustion.
 * Such failures must fall through to Pi's compaction path, never to a retry.
 */
export function isPvpContextOverflow(message: unknown): boolean {
  const candidate = message as { stopReason?: unknown; errorMessage?: unknown } | undefined;
  if (!candidate || candidate.stopReason !== "error") return false;
  const errorMessage = typeof candidate.errorMessage === "string" ? candidate.errorMessage : "";
  if (errorMessage.length === 0) return false;
  if (PVP_NON_OVERFLOW_PATTERNS.some((pattern) => pattern.test(errorMessage))) return false;
  return PVP_CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

export interface TurnEndResult {
  shouldRetry: boolean;
  success: boolean;
}

/**
 * Format status indicator text conforming to Pi native TUI styling.
 * Uses native theme muted/dim colors, clean lowercase text ('pvp on' / 'pvp 5'),
 * matching the exact font size, baseline, and gray tone of native status bar items.
 */
export function formatPvpStatus(
  mode: Exclude<PvpMode, "off">,
  attemptCount: number = 0,
  theme?: ExtensionUIContext["theme"],
  successTarget?: number,
  successCount: number = 0
): string {
  const label = mode === "persistent" ? "pvp on" : `pvp ${successTarget ?? 0}`;

  const fg = (color: "accent" | "warning" | "muted" | "dim", text: string): string => {
    return theme ? theme.fg(color, text) : text;
  };

  let status = fg("muted", label);
  if (mode === "limited" && successCount > 0) {
    status += ` ${fg("dim", `(${successCount}/${successTarget ?? 0})`)}`;
  }
  if (attemptCount > 0) {
    status += ` ${fg("dim", `(第 ${attemptCount} 次重试)`)}`;
  }
  return status;
}

/**
 * Owns the PVP state machine and retry orchestration.
 *
 * Supported modes:
 * - "persistent": /pvp or /pvp on. Reconnects without cooldown upon failure with no
 *   limit, and stays enabled after success until manually turned off.
 * - "limited": /pvp <n>. Retries failures without cooldown and turns off after n
 *   successful turns (failures never consume the target).
 * - "off": disabled, no retries, status bar hidden.
 */
export class PvpController {
  private mode: PvpMode = "off";
  private successTarget: number | undefined = undefined;
  private successCount: number = 0;
  private lastPrompt: string | undefined = undefined;
  private lastImages: PvpImageContent[] | undefined = undefined;
  private pendingRetry: boolean = false;
  private retryTimer: NodeJS.Timeout | undefined = undefined;
  private attemptCount: number = 0;
  private retryInFlight: boolean = false;
  private lastError: string | undefined = undefined;
  private pendingErrorTurnMessage: PvpAgentMessage | undefined = undefined;
  private activeUi: PvpUi | undefined = undefined;

  get currentMode(): PvpMode {
    return this.mode;
  }

  get enabled(): boolean {
    return this.mode !== "off";
  }

  get currentSuccessTarget(): number | undefined {
    return this.successTarget;
  }

  /** Completed successful turns credited toward the bounded-mode target. */
  get currentSuccessCount(): number {
    return this.successCount;
  }

  /** Message of the last failed assistant turn, kept until PVP retries it or a new run starts. */
  get pendingErrorTurn(): PvpAgentMessage | undefined {
    return this.pendingErrorTurnMessage;
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

    const styledText = formatPvpStatus(this.mode, this.attemptCount, targetUi.theme, this.successTarget, this.successCount);
    targetUi.setStatus(PVP_STATUS_KEY, styledText);

    if (typeof targetUi.setWidget === "function") {
      const mode = this.mode;
      const attemptCount = this.attemptCount;
      const successTarget = this.successTarget;
      const successCount = this.successCount;
      targetUi.setWidget(
        PVP_WIDGET_KEY,
        (_tui, theme) => ({
          render(_width: number): string[] {
            return [formatPvpStatus(mode, attemptCount, theme, successTarget, successCount)];
          },
          invalidate(): void {},
        }),
        { placement: "belowEditor" }
      );
    }
  }

  /**
   * Enable resident mode (unlimited, stays on) or bounded mode (turns off after
   * `successTarget` successful turns).
   */
  enable(mode: Exclude<PvpMode, "off">, ui?: PvpUi, successTarget?: number): void {
    this.cancelRetry();
    this.mode = mode;
    this.successTarget = mode === "limited" ? successTarget : undefined;
    this.successCount = 0;
    this.attemptCount = 0;
    this.retryInFlight = false;
    this.lastError = undefined;
    this.pendingErrorTurnMessage = undefined;
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
    this.successTarget = undefined;
    this.successCount = 0;
    this.retryInFlight = false;
    this.lastError = undefined;
    this.pendingErrorTurnMessage = undefined;
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
   * Counts one success in bounded mode and automatically disables PVP once the
   * configured number of successful turns is reached (notifies "PVP OFF").
   */
  handleSuccess(ui?: PvpUi): void {
    if (!this.enabled) {
      return;
    }

    this.pendingRetry = false;
    this.attemptCount = 0;
    this.retryInFlight = false;
    this.lastError = undefined;
    this.pendingErrorTurnMessage = undefined;

    if (this.mode === "limited") {
      this.successCount++;
      if (this.successTarget !== undefined && this.successCount >= this.successTarget) {
        const completed = this.successCount;
        this.disable(ui);
        const targetUi = ui ?? this.activeUi;
        targetUi?.notify(`PVP OFF (已达 ${completed} 次成功)`, "info");
        return;
      }
    }
    this.updateUi(ui);
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
    this.pendingErrorTurnMessage = undefined;
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

    // Context-window exhaustion: hand the turn back to Pi's compaction path so it can
    // compact and retry once. Never latch a pending retry here — that would resend the
    // oversized prompt forever and skip auto-compaction entirely.
    if (isPvpContextOverflow(message)) {
      this.pendingRetry = false;
      this.pendingErrorTurnMessage = undefined;
      this.retryInFlight = false;
      this.lastError =
        "errorMessage" in message && typeof message.errorMessage === "string"
          ? message.errorMessage
          : "Context overflow";
      return { shouldRetry: false, success: false };
    }

    // Model turn failed: flag for retry
    if (stopReason === "error") {
      this.pendingRetry = true;
      this.pendingErrorTurnMessage = message;
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
   * True when the given message is the pending failure that PVP is about to retry
   * and it matches {@link PVP_FORCE_RETRY_PATTERN} ("stream disconnected").
   *
   * Host extensions such as goal treat unknown provider failures as terminal and
   * abort the run inside their `agent_end` handler. Because extension handlers run
   * before the post-run retry check, that abort latches the native run loop closed
   * and PVP never gets the chance to retry. Recognising the combination lets the
   * retry hook keep the run loop alive instead of forwarding that abort.
   */
  shouldForceRetryOverAbort(message: unknown): boolean {
    if (!this.enabled || this.pendingErrorTurnMessage === undefined) {
      return false;
    }
    const pending = this.pendingErrorTurnMessage as { errorMessage?: unknown; timestamp?: unknown };
    const candidate = message as
      | { stopReason?: unknown; errorMessage?: unknown; timestamp?: unknown }
      | undefined;
    if (!candidate) {
      return false;
    }
    const sameMessage =
      candidate === this.pendingErrorTurnMessage ||
      (pending.timestamp !== undefined && candidate.timestamp === pending.timestamp);
    return (
      sameMessage &&
      candidate.stopReason === "error" &&
      typeof candidate.errorMessage === "string" &&
      candidate.errorMessage === pending.errorMessage &&
      PVP_FORCE_RETRY_PATTERN.test(candidate.errorMessage)
    );
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

  /** Apply the public `/pvp [on|off|<n>]` command grammar. */
  handleCommand(args: string, ctx: PvpCommandContext): void {
    this.activeUi = ctx.ui;
    const command = args.trim().toLowerCase();

    if (command === "" || command === "on") {
      this.enable("persistent", ctx.ui);
      ctx.ui.notify("PVP ON", "info");
      return;
    }

    if (command === "off") {
      this.disable(ctx.ui);
      ctx.ui.notify("PVP OFF", "info");
      return;
    }

    if (/^\d+$/.test(command)) {
      const limit = Number(command);
      if (Number.isSafeInteger(limit) && limit >= 1) {
        this.enable("limited", ctx.ui, limit);
        ctx.ui.notify(`PVP ${limit}`, "info");
        return;
      }
    }

    ctx.ui.notify("用法：/pvp、/pvp on、/pvp <重试次数> 或 /pvp off", "warning");
  }

  /** Clear state during shutdown or other terminal cleanup paths. */
  cleanup(ui?: PvpUi): void {
    this.disable(ui);
  }
}

let activeHookCleanup: (() => void) | undefined = undefined;

/**
 * Native retry adapter for Pi 0.84.2–0.87.1 and 1.x.
 * Pi 1.x renamed the run entry point to `_startRun(trigger, onStarted)`; 0.84–1.1 used
 * `_runAgentPrompt(messages)`. Prefer the modern method and keep the legacy fallback.
 * 0.87+ requires durable context omission; older hosts keep retry context in memory.
 * Keep the host's prompt/continue loop, without injecting another user message.
 */
export function installPvpRetryHook(controller: PvpController): () => void {
  activeHookCleanup?.();
  const sessionProto = AgentSession.prototype as any;
  const origIsRetryable = sessionProto._isRetryableError;
  const origPrepareRetry = sessionProto._prepareRetry;
  if (typeof origIsRetryable !== "function" || typeof origPrepareRetry !== "function") {
    throw new Error("PVP: incompatible Pi retry API; expected _isRetryableError and _prepareRetry");
  }
  let installed = true;
  const waits = new Set<AbortController>();
  // Pi <=0.85 has no run-level abort latch: an abort during turn_end can be
  // lost before the post-run retry check. Track it until the next prompt run.
  const cancelledRuns = new WeakSet<object>();
  const origAbort = sessionProto.abort;
  // Pi 1.x moved the run entry point to _startRun(trigger, onStarted); pre-1.x hosts
  // only expose _runAgentPrompt(messages). Wrap exactly one of them.
  const runLifecycleMethod: "_startRun" | "_runAgentPrompt" | undefined =
    typeof sessionProto._startRun === "function"
      ? "_startRun"
      : typeof sessionProto._runAgentPrompt === "function"
        ? "_runAgentPrompt"
        : undefined;
  const origRunPrompt = runLifecycleMethod ? sessionProto[runLifecycleMethod] : undefined;
  if (runLifecycleMethod === undefined || typeof origAbort !== "function" || typeof origRunPrompt !== "function") {
    throw new Error("PVP: incompatible Pi run lifecycle API; expected _startRun or _runAgentPrompt");
  }
  const lifecycleMethod: "_startRun" | "_runAgentPrompt" = runLifecycleMethod;
  const abort = function (this: any, ...args: any[]) {
    if (installed && controller.enabled) {
      if (this._isAgentRunActive === true && controller.shouldForceRetryOverAbort(this._lastAssistantMessage)) {
        // A host extension (e.g. goal) aborted the run in reaction to the very provider
        // failure PVP is about to retry. Forwarding that abort would latch the run loop
        // closed before the post-run retry check, so keep the loop alive and let the
        // native retry path resume the request.
        return Promise.resolve();
      }
      cancelledRuns.add(this);
      controller.handleAbort(this._extensionUIContext);
    }
    return origAbort.apply(this, args);
  };
  const runPrompt = function (this: any, ...args: any[]) {
    cancelledRuns.delete(this);
    return origRunPrompt.apply(this, args);
  };

  const isRetryable = function (this: any, message: any): boolean {
    if (!installed || !controller.enabled) return origIsRetryable.call(this, message);
    if (cancelledRuns.has(this) || this._agentRunAbortRequested || message?.stopReason === "aborted") return false;
    if (origIsRetryable.call(this, message)) return true;
    // Context-window exhaustion is recovered by Pi's compaction path
    // (_checkCompaction → _runAutoCompaction), not by resending the same prompt.
    // Treating it as retryable is what silently disabled auto-compaction under PVP.
    if (isPvpContextOverflow(message)) return false;
    return message?.stopReason === "error";
  };

  const prepareRetry = async function (this: any, message: any): Promise<boolean> {
    if (!installed || !controller.enabled) return origPrepareRetry.call(this, message);
    if (cancelledRuns.has(this) || this._agentRunAbortRequested || message?.stopReason !== "error") return false;
    // Defense in depth: never retry a context overflow even if another hook forced the
    // classification, and never strip the failed reply from context in that case.
    if (isPvpContextOverflow(message)) return false;
    const ui = this._extensionUIContext;
    const error = typeof message?.errorMessage === "string" ? message.errorMessage : undefined;

    // Do not fall back to slicing if durable omission fails: that would silently
    // resurrect a failed reply on the next SessionManager projection refresh.
    if (typeof this._omitRecoveryAttempt === "function") {
      this._omitRecoveryAttempt(message);
    } else {
      const messages = this.agent?.state?.messages;
      if (Array.isArray(messages) && messages.at(-1)?.role === "assistant") {
        this.agent.state.messages = messages.slice(0, -1);
      }
    }

    const abortController = new AbortController();
    this._retryAbortController = abortController;
    waits.add(abortController);
    const { signal } = abortController;
    try {
      controller.recordRetryAttempt(ui, error);
      // A zero-delay yield lets Escape/Ctrl+C, /pvp off and reload interrupt.
      const elapsed = await new Promise<boolean>((resolve) => {
        if (signal.aborted) { resolve(false); return; }
        const onAbort = () => { clearTimeout(timer); resolve(false); };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve(true);
        }, 0);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      if (!elapsed || !installed || !controller.enabled || cancelledRuns.has(this) || this._agentRunAbortRequested) {
        this._retryAttempt = 0;
        controller.handleAbort(ui);
        return false;
      }
      return true;
    } finally {
      waits.delete(abortController);
      if (this._retryAbortController === abortController) this._retryAbortController = undefined;
    }
  };

  sessionProto._isRetryableError = isRetryable;
  sessionProto._prepareRetry = prepareRetry;
  sessionProto.abort = abort;
  sessionProto[lifecycleMethod] = runPrompt;
  const cleanup = () => {
    if (!installed) return;
    installed = false;
    for (const wait of waits) wait.abort();
    // An old session's shutdown must not tear down a new runtime or later hook.
    if (sessionProto._isRetryableError === isRetryable) sessionProto._isRetryableError = origIsRetryable;
    if (sessionProto._prepareRetry === prepareRetry) sessionProto._prepareRetry = origPrepareRetry;
    if (sessionProto.abort === abort) sessionProto.abort = origAbort;
    if (sessionProto[lifecycleMethod] === runPrompt) sessionProto[lifecycleMethod] = origRunPrompt;
    if (activeHookCleanup === cleanup) activeHookCleanup = undefined;
  };
  activeHookCleanup = cleanup;
  return cleanup;
}

export function getPvpArgumentCompletions(prefix: string): Array<{ value: string; label: string }> | null {
  const normalizedPrefix = prefix.trim().toLowerCase();
  const values = COMMAND_MODES.filter((value) => value.startsWith(normalizedPrefix));
  return values.length > 0 ? values.map((value) => ({ value, label: value })) : null;
}
