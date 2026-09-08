import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getPvpArgumentCompletions,
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

  pi.registerCommand("pvp", {
    description: "Enable resident or one-success unlimited retry mode (/pvp, /pvp on, /pvp one, /pvp off)",
    getArgumentCompletions: getPvpArgumentCompletions,
    handler: async (args, ctx) => {
      controller.handleCommand(args, ctx);
    },
  });

  // Track the most recent user prompt and any attached images
  pi.on("before_agent_start", (event, ctx) => {
    controller.recordPrompt(event.prompt, event.images, ctx.ui);
  });

  // Bypass pi core's built-in exponential backoff retry when PVP is active
  pi.on("message_end", (event) => {
    const replacement = controller.handleMessageEnd(event.message);
    if (replacement) {
      return { message: replacement };
    }
  });

  // Observe turn results: error triggers pending retry; success resets or closes
  pi.on("turn_end", (event, ctx) => {
    controller.handleTurnEnd(event.message, ctx.ui);
  });

  // Once the agent run has settled, dispatch immediate retry if pending
  pi.on("agent_settled", (_event, ctx) => {
    controller.scheduleRetry((prompt, images) => {
      try {
        if (images && images.length > 0) {
          pi.sendUserMessage(
            [{ type: "text", text: prompt }, ...images],
            { deliverAs: "followUp" }
          );
        } else {
          pi.sendUserMessage(prompt, { deliverAs: "followUp" });
        }
      } catch {
        // Guard against unexpected send failures
      }
    }, ctx.ui);
  });

  // Ensure clean teardown when session shuts down
  pi.on("session_shutdown", (_event, ctx) => {
    controller.cleanup(ctx.ui);
  });
}

export {
  formatPvpStatus,
  getPvpArgumentCompletions,
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
