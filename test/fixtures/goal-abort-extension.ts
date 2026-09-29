import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pvpExtension from "../../src/index.js";

// Real host loads the production extension; provider and command input are fixtures.
// The agent_end handler below reproduces @narumitw/pi-goal behaviour for provider errors
// it does not classify as retryable: stop the active goal via ctx.abort() at agent_end.
// Goal's own retryable patterns (src/errors.ts RETRYABLE_GOAL_ERROR_PATTERNS) are
// approximated for the fixture so the abort only fires on unclassified errors.
const GOAL_RETRYABLE = /overloaded|rate.?limit|too many requests|\b(?:429|500|502|503|504)\b|service.?unavailable|server.?error|internal.?error|provider.?returned.?error|network.?error|connection.?(?:error|refused|lost)|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|timed? out|timeout|terminated|websocket.?(?:closed|error)|ended without|premature (?:close|end)|incomplete (?:stream|response)|http2 request did not get a response|retry delay|context[_\s-]*length[_\s-]*exceeded/i;

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
  pi.on("session_start", async (_event, ctx) => {
    const ui = new Proxy(ctx.ui, {
      get(target, key) {
        if (key === "notify") return (text: string) => process.stderr.write(`PVP_TEST ${text}\n`);
        return Reflect.get(target, key);
      },
    });
    await command.handler(process.env.PVP_TEST_MODE ?? "on", { ...ctx, ui });
  });
  pi.on("agent_end", (event, ctx) => {
    const messages = (event as { messages?: Array<Record<string, unknown>> }).messages ?? [];
    let final: Record<string, unknown> | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "assistant") { final = messages[i]; break; }
    }
    if (final?.stopReason !== "error") return;
    const errorMessage = typeof final.errorMessage === "string" ? final.errorMessage : "";
    if (GOAL_RETRYABLE.test(errorMessage)) return;
    process.stderr.write("PVP_TEST goal-sim abort\n");
    ctx.abort();
  });
}
