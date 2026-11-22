import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

// Real-CLI proof for the optional wake-guard retry gate.
const target = resolve(process.argv[2] ?? "node_modules/@earendil-works/pi-coding-agent");
let cli = target;
if ((await stat(target)).isDirectory()) {
  const pkg = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
  cli = join(target, typeof pkg.bin === "string" ? pkg.bin : pkg.bin.pi);
  console.log(`Testing pi ${pkg.version}`);
}
const extension = resolve(process.argv[3] ?? fileURLToPath(new URL("./fixtures/gate-extension.ts", import.meta.url)));

/**
 * gate=off     no wake-guard listener is registered -> pre-gate behaviour (3 retries).
 * gate=allow   listener resolves true immediately -> same retries, gate consulted each time.
 * gate=deny    listener resolves false -> a single request, run settles without retry.
 * gate=pending listener parks the run, then a manual cancel (Ctrl+C equivalent) settles it.
 */
async function runScenario(gate) {
  const root = await mkdtemp(join(tmpdir(), "pvp-gate-"));
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      requests.push(JSON.parse(raw));
      if (requests.length <= 3) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "upstream stream disconnected", type: "invalid_request_error" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "FIXTURE_OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  try {
    await mkdir(join(root, "agent"));
    await writeFile(join(root, "agent", "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
    const child = spawn(process.execPath, [cli, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools", "--no-session", "--offline", "-e", extension, "--provider", "pvp-fixture", "--model", "fixture", "--thinking", "off", "-p", "Reply FIXTURE_OK"], {
      cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), PVP_TEST_URL: `http://127.0.0.1:${server.address().port}/v1`, PVP_TEST_GATE: gate, PI_OFFLINE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (b) => { stdout += b; });
    child.stderr.on("data", (b) => { stderr += b; });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30000);
    let code;
    try {
      code = await new Promise((done, fail) => { child.once("error", fail); child.once("close", done); });
    } finally { clearTimeout(timer); }
    console.log(JSON.stringify({ gate, pid: child.pid, code, requests: requests.length, stdout, stderr }));
    assert.equal(timedOut, false, "CLI did not settle within 30s");
    assert.match(stderr, /PVP_TEST PVP ON/, "real /pvp handler must run");

    if (gate === "off" || gate === "allow") {
      assert.equal(code, 0);
      assert.equal(requests.length, 4, "gate must not change the native retry count");
      assert.match(stdout, /FIXTURE_OK/);
    } else if (gate === "deny") {
      assert.equal(requests.length, 1, "gate false must cancel the run, not retry");
      assert.match(stderr, /PVP_TEST gate=deny/);
    } else {
      assert.equal(requests.length, 1, "a parked gate must not retry");
      assert.match(stderr, /PVP_TEST gate=pending/);
      assert.match(stderr, /PVP_TEST gate=cancelled/);
    }
    for (const request of requests) {
      assert.equal(request.messages.filter((m) => m.role === "user").length, 1, "no duplicated user prompts");
      assert.equal(request.messages.filter((m) => m.role === "assistant").length, 0, "failed attempts stay out of context");
    }
    return { gate, requests: requests.length, code };
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
}

const results = [];
for (const gate of ["off", "allow", "deny", "pending"]) results.push(await runScenario(gate));
console.log(JSON.stringify({ results }));
console.log("PASS real CLI: wake-guard gate no-listener parity, allow, deny and parked-then-cancel; resources closed");
