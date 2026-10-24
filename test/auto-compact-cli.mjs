import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

// Regression: with PVP enabled, pi's automatic compaction must still run.
// PVP used to classify *every* stopReason "error" as retryable, which swallowed
// context-overflow failures before `_checkCompaction` could compact the session.
// The turn then "succeeded" only because the fixture server eventually answered,
// while the real session never compacted and would grow forever.
const target = resolve(process.argv[2] ?? "node_modules/@earendil-works/pi-coding-agent");
let cli = target;
if ((await stat(target)).isDirectory()) {
  const pkg = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
  cli = join(target, typeof pkg.bin === "string" ? pkg.bin : pkg.bin.pi);
  console.log(`Testing pi ${pkg.version}`);
}
const extension = fileURLToPath(new URL("./fixtures/compact-probe-extension.ts", import.meta.url));
const OVERFLOW = "prompt is too long: 213462 tokens > 200000 maximum";

// A large seeded history gives compaction something to summarize.
async function seedSession(dir) {
  const turns = 8;
  const chunk = 60000;
  const entries = [{ type: "session", version: 3, id: "fixture-session", timestamp: new Date().toISOString(), cwd: dir }];
  let parentId = null;
  let n = 0;
  const push = (entry) => {
    entry.id = `e${String(++n).padStart(4, "0")}`;
    entry.parentId = parentId;
    entry.timestamp = new Date(Date.now() + n).toISOString();
    entries.push(entry);
    parentId = entry.id;
  };
  push({ type: "model_change", provider: "pvp-fixture", modelId: "fixture" });
  for (let t = 0; t < turns; t++) {
    push({ type: "message", message: { role: "user", content: [{ type: "text", text: `TURN ${t} ` + "u".repeat(chunk) }], timestamp: Date.now() } });
    push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `ANSWER ${t} ` + "a".repeat(chunk) }], stopReason: "stop", timestamp: Date.now(), usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1500 } } });
  }
  await mkdir(dir, { recursive: true });
  const file = join(dir, "seeded.jsonl");
  await writeFile(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

async function runScenario(mode, scenario, expectCompaction) {
  const root = await mkdtemp(join(tmpdir(), "pvp-compact-"));
  await mkdir(join(root, "agent"), { recursive: true });
  await writeFile(join(root, "agent", "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  const sessionFile = await seedSession(join(root, "sessions"));

  let requests = 0;
  const server = createServer(async (req, res) => {
    requests++;
    for await (const _c of req) { /* drain */ }
    if (scenario === "overflow" && requests === 1) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: OVERFLOW, type: "invalid_request_error" } }));
      return;
    }
    // "threshold" reports usage above contextWindow - reserveTokens (200000 - 16384).
    const usage = scenario === "threshold"
      ? { prompt_tokens: 195000, completion_tokens: 10, total_tokens: 195010 }
      : { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "FIXTURE_OK" }, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((r, j) => { server.once("error", j); server.listen(0, "127.0.0.1", r); });

  try {
    const child = spawn(process.execPath, [cli, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools", "--offline",
      "-e", extension, "--provider", "pvp-fixture", "--model", "fixture", "--thinking", "off", "--session", sessionFile, "-p", "Reply FIXTURE_OK"], {
      cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), PVP_TEST_URL: `http://127.0.0.1:${server.address().port}/v1`, PVP_TEST_MODE: mode, PI_OFFLINE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (b) => stdout += b);
    child.stderr.on("data", (b) => stderr += b);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60000);
    let code;
    try {
      code = await new Promise((r, j) => { child.once("error", j); child.once("close", r); });
    } finally { clearTimeout(timer); }

    const compactions = stderr.split("\n").filter((l) => l.startsWith("PROBE compacted"));
    console.log(JSON.stringify({ mode, scenario, code, requests, compactions: compactions.length, compactions }));
    assert.equal(timedOut, false, "CLI did not settle within 60s");
    assert.match(stderr, new RegExp(`PVP_TEST PVP ${mode.toUpperCase()}`), "real /pvp handler must run");
    assert.equal(code, 0, "turn must succeed");
    assert.match(stdout, /FIXTURE_OK/);
    assert.equal(compactions.length, expectCompaction ? 1 : 0,
      `auto-compaction count mismatch for ${scenario}/${mode}`);
    if (expectCompaction) {
      assert.match(compactions[0], new RegExp(`reason=${scenario}`), "compaction must use the matching reason");
    }
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  }
}

// Overflow: PVP must not swallow the error, so pi compacts and retries once.
await runScenario("on", "overflow", true);
await runScenario("off", "overflow", true);
// Threshold: works in both modes; guards against a fix that only special-cases overflow.
await runScenario("on", "threshold", true);
console.log("PASS real CLI: auto-compaction (overflow + threshold) works with PVP on");
