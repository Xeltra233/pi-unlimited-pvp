import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

// Regression: a goal-style extension aborting the run at agent_end after an
// unclassified provider failure must not cancel PVP's retry. pi >= 0.86 latches
// `_agentRunAbortRequested` on that abort, which used to skip pi's post-run retry
// loop before PVP could reconnect "Upstream stream disconnected".
const target = resolve(process.argv[2] ?? "node_modules/@earendil-works/pi-coding-agent");
let cli = target;
if ((await stat(target)).isDirectory()) {
  const pkg = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
  cli = join(target, typeof pkg.bin === "string" ? pkg.bin : pkg.bin.pi);
  console.log(`Testing pi ${pkg.version}`);
}
const extension = fileURLToPath(new URL("./fixtures/goal-abort-extension.ts", import.meta.url));

async function runScenario(mode, expectedRequests, expectSuccess) {
  const root = await mkdtemp(join(tmpdir(), "pvp-goal-abort-"));
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      requests.push(JSON.parse(raw));
      if (requests.length === 1) {
        // Mid-stream provider failure; pi surfaces it as "Upstream stream disconnected".
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ error: { message: "Upstream stream disconnected" } })}\n\n`);
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "FIXTURE_OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    await mkdir(join(root, "agent"));
    await writeFile(join(root, "agent", "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
    const child = spawn(process.execPath, [cli, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools", "--no-session", "--offline", "-e", extension, "--provider", "pvp-fixture", "--model", "fixture", "--thinking", "off", "-p", "Reply FIXTURE_OK"], {
      cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), PVP_TEST_URL: `http://127.0.0.1:${server.address().port}/v1`, PVP_TEST_MODE: mode, PI_OFFLINE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (b) => stdout += b);
    child.stderr.on("data", (b) => stderr += b);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30000);
    let code;
    try {
      code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    } finally { clearTimeout(timer); }
    console.log(JSON.stringify({ mode, code, requests: requests.length, stdout, stderr }));
    assert.equal(timedOut, false, "CLI did not settle within 30s");
    assert.match(stderr, new RegExp(`PVP_TEST PVP ${mode.toUpperCase()}`), "real /pvp handler must run");
    assert.match(stderr, /PVP_TEST goal-sim abort/, "goal-style agent_end abort must fire");
    assert.equal(requests.length, expectedRequests, `PVP retry count mismatch for mode ${mode}`);
    if (expectSuccess) {
      assert.equal(code, 0);
      assert.match(stdout, /FIXTURE_OK/);
    } else {
      assert.equal(code, 1, "PVP off must not retry the failure");
    }
    for (const request of requests) {
      assert.equal(request.messages.filter((m) => m.role === "user").length, 1, "no duplicated user prompts");
      assert.equal(request.messages.filter((m) => m.role === "assistant").length, 0, "failed attempts must stay out of projected context");
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

for (const [mode, expectedRequests, expectSuccess] of [["on", 2, true], ["1", 2, true], ["3", 2, true], ["off", 1, false]]) {
  await runScenario(mode, expectedRequests, expectSuccess);
}
console.log("PASS real CLI: stream-disconnect retry survives goal-style abort; /pvp <n> and /pvp off behave");
