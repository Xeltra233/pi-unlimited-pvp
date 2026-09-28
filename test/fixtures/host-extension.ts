import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pvpExtension from "../../src/index.js";

// Real host loads the production extension; only provider and command input are fixtures.
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
    await command.handler(process.env.PVP_TEST_MODE ?? "one", { ...ctx, ui });
  });
  pi.on("turn_end", async (event, ctx) => {
    if (event.message.role !== "assistant" || event.message.stopReason !== "error") return;
    if (process.env.PVP_TEST_STOP === "abort") {
      process.stderr.write("PVP_TEST abort\n");
      ctx.abort();
    } else if (process.env.PVP_TEST_STOP === "off") {
      process.stderr.write("PVP_TEST off\n");
      await command.handler("off", ctx);
    }
  });
}
