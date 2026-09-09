import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  formatPvpStatus,
  getPvpArgumentCompletions,
  installPvpRetryHook,
  PvpController,
  PVP_STATUS_KEY,
  PVP_WIDGET_KEY,
} from "./pvp-controller.js";

/**
 * Pi Unlimited PVP Extension.
 *
 * Provides unlimited automatic retry mode without cooldown and without
 * default retry count limits:
 * - `/pvp` or `/pvp on`: enables resident (persistent) PVP mode.
 * - `/pvp one`: enables one-success PVP mode (turns off upon success).
 * - `/pvp off`: turns off PVP mode and cleans up footer status.
 */
export default function pvpExtension(pi: ExtensionAPI): void {
  const controller = new PvpController();
  const uninstallHook = installPvpRetryHook(controller);

  pi.registerCommand("pvp", {
    description: "Enable resident or one-success unlimited retry mode (/pvp, /pvp on, /pvp one, /pvp off)",
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
  PvpController,
  PVP_STATUS_KEY,
  PVP_WIDGET_KEY,
} from "./pvp-controller.js";
export type {
  PvpAgentMessage,
  PvpCommandContext,
  PvpImageContent,
  PvpMode,
  PvpUi,
  TurnEndResult,
} from "./pvp-controller.js";
