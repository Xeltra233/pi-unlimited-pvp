import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  formatPvpStatus,
  getPvpArgumentCompletions,
  installPvpRetryHook,
  PvpController,
  PVP_STATUS_KEY,
  PVP_WAKE_GUARD_CHANNEL,
  PVP_WIDGET_KEY,
} from "./pvp-controller.js";

/** Host event bus subset used by the optional wake-guard handshake. */
interface PvpEventBus {
  emit: (channel: string, data: unknown) => void;
}

/**
 * Pi Unlimited PVP Extension.
 *
 * Provides unlimited automatic retry mode without cooldown and without
 * - `/pvp` or `/pvp on`: enables resident (persistent) PVP mode.
 * - `/pvp <n>`: bounded mode, turns off automatically after n successful turns.
 * - `/pvp off`: turns off PVP mode and cleans up footer status.
 *
 * When a wake-guard extension (pi-wakeguard) is loaded, every native retry first asks it
 * whether the provider API is reachable through {@link PVP_WAKE_GUARD_CHANNEL}. Without a
 * subscriber the retry path is byte-for-byte the previous behaviour.
 */
export default function pvpExtension(pi: ExtensionAPI): void {
  const controller = new PvpController();
  const events = (pi as ExtensionAPI & { events?: Partial<PvpEventBus> }).events;
  const uninstallHook = installPvpRetryHook(
    controller,
    typeof events?.emit === "function"
      ? { emitRetryGate: (request) => events.emit?.(PVP_WAKE_GUARD_CHANNEL, request) }
      : undefined
  );

  pi.registerCommand("pvp", {
    description: "Enable resident retry mode (/pvp, /pvp on) or auto-off after n successes (/pvp <n>); disable with /pvp off",
    getArgumentCompletions: getPvpArgumentCompletions,
    handler: async (args, ctx) => {
      controller.handleCommand(args, ctx);
    },
  });

  // Track new user prompt submission to reset retry count
  pi.on("before_agent_start", (_event, ctx) => {
    controller.handleNewPrompt(ctx.ui);
  });

  // Observe turn results: success resets/closes mode; abort cancels
  pi.on("turn_end", (event, ctx) => {
    controller.handleTurnEnd(event.message, ctx.ui);
  });

  // A provider/model switch while a gate wait is parked must not let the old model resume.
  pi.on("model_select", () => {
    controller.abortRetryWaits();
  });

  // Switching or forking a session abandons the in-flight run and its gate wait.
  pi.on("session_before_switch", () => {
    controller.abortRetryWaits();
  });
  pi.on("session_before_fork", () => {
    controller.abortRetryWaits();
  });

  // Ensure clean teardown when session shuts down
  pi.on("session_shutdown", (_event, ctx) => {
    uninstallHook();
    controller.cleanup(ctx.ui);
  });
}

export {
  formatPvpStatus,
  getPvpArgumentCompletions,
  installPvpRetryHook,
  isPvpContextOverflow,
  PvpController,
  PVP_CONTEXT_OVERFLOW_PATTERNS,
  PVP_STATUS_KEY,
  PVP_WAKE_GUARD_CHANNEL,
  PVP_WIDGET_KEY,
} from "./pvp-controller.js";
export type {
  PvpAgentMessage,
  PvpCommandContext,
  PvpImageContent,
  PvpMode,
  PvpRetryGateEmit,
  PvpRetryGateModel,
  PvpRetryGateRequest,
  PvpRetryHookOptions,
  PvpUi,
  TurnEndResult,
} from "./pvp-controller.js";
