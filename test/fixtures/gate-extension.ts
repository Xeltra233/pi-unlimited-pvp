import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import pvpExtension, { PVP_WAKE_GUARD_CHANNEL, type PvpRetryGateRequest } from "../../src/index.js";

/**
 * Real-host fixture for the optional wake-guard gate.
 *
 * Loads the production extension (so `pi.events.emit` wiring is the real one), then stands in
 * for the wake-guard extension only in the listener role. `PVP_TEST_GATE` selects:
 *   off     — register nothing (pre-gate behaviour)
 *   allow   — resolve true immediately
 *   deny    — resolve false immediately
 *   pending — park the retry, then abort the run like an interactive Esc
 */
export default function (pi: ExtensionAPI) {
  let command: any;
  pvpExtension(new Proxy(pi, {
    get(target, key) {
      if (key === "registerCommand") return (name: string, definition: any) => {
        if (name === "pvp") command = definition;
        return target.registerCommand(name, definition);
      };
      return Reflect.get(target, key);
    },
  }));

  pi.registerProvider("pvp-fixture", {
    baseUrl: process.env.PVP_TEST_URL!,
    apiKey: "fixture-not-a-secret",
    api: "openai-completions",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32000, maxTokens: 100 }],
  });

  const gate = process.env.PVP_TEST_GATE ?? "off";

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    const ui = new Proxy(ctx.ui, {
      get(target, key) {
        if (key === "notify") return (text: string) => process.stderr.write(`PVP_TEST ${text}\n`);
        return Reflect.get(target, key);
      },
    });

    if (gate !== "off") {
      pi.events.on(PVP_WAKE_GUARD_CHANNEL, (request: PvpRetryGateRequest) => {
        process.stderr.write(`PVP_TEST gate=${gate} model=${request.model?.provider ?? "none"}/${request.model?.id ?? "none"} error=${JSON.stringify(request.errorMessage)}\n`);
        if (gate === "allow") { request.wait = Promise.resolve(true); return; }
        if (gate === "deny") { request.wait = Promise.resolve(false); return; }
        const { promise, resolve } = Promise.withResolvers<boolean>();
        request.wait = promise;
        request.signal.addEventListener("abort", () => {
          process.stderr.write("PVP_TEST gate=cancelled\n");
          // A late resume must not revive the cancelled run.
          resolve(true);
        }, { once: true });
        // Interactive Esc equivalent: the user cancels the parked run.
        setTimeout(() => { process.stderr.write("PVP_TEST gate=escaping\n"); ctx.abort(); }, 150);
      });
    }

    await command.handler(process.env.PVP_TEST_MODE ?? "on", { ...ctx, ui });
  });
}
