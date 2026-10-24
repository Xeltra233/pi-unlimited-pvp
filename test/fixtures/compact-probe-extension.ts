// Repro fixture: real PVP extension + fixture provider + compaction event probe.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pvpExtension from "../../src/index.js";

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
      contextWindow: 200000, maxTokens: 4096 }],
  });
  pi.on("session_before_compact", (event) => {
    process.stderr.write(`PROBE before_compact reason=${(event as any).reason}\n`);
    return undefined;
  });
  pi.on("session_compact", (event) => {
    process.stderr.write(`PROBE compacted reason=${(event as any).reason} fromExtension=${(event as any).fromExtension}\n`);
    return undefined;
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
}
