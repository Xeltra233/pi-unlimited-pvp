import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

// Accept a package directory (uses that release's actual bin) or a CLI file.
const target = resolve(process.argv[2] ?? "node_modules/@earendil-works/pi-coding-agent");
let cli = target;
if ((await stat(target)).isDirectory()) {
  const pkg = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
  cli = join(target, typeof pkg.bin === "string" ? pkg.bin : pkg.bin.pi);
  console.log(`Testing pi ${pkg.version}`);
}
const extension = resolve(process.argv[3] ?? fileURLToPath(new URL("./fixtures/host-extension.ts", import.meta.url)));

async function runScenario(mode, stop = "") {
  const root = await mkdtemp(join(tmpdir(), "pvp-compat-"));
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      requests.push(JSON.parse(raw));
      if (requests.length <= 3) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "fixture deliberate failure", type: "invalid_request_error" } }));
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
      env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), PVP_TEST_URL: `http://127.0.0.1:${server.address().port}/v1`, PVP_TEST_MODE: mode, PVP_TEST_STOP: stop, PI_OFFLINE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", b => stdout += b);
    child.stderr.on("data", b => stderr += b);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30000);
    let code;
    try {
      code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    } finally { clearTimeout(timer); }
    console.log(JSON.stringify({ cli, mode, stop, pid: child.pid, code, requests: requests.length, stdout, stderr }));
    assert.equal(timedOut, false, "CLI did not settle within 30s");
    assert.match(stderr, new RegExp(`PVP_TEST PVP ${mode.toUpperCase()}`), "real /pvp handler must run");
    if (stop || mode === "off") {
      assert.ok(code === 0 || code === 1, "unexpected process exit");
      assert.equal(requests.length, 1, "off/abort must not issue a retry");
      if (stop) assert.match(stderr, new RegExp(`PVP_TEST ${stop}`));
    } else {
      assert.equal(code, 0);
      assert.equal(requests.length, 4, "PVP must retry 3 non-native-retryable failures with retry.enabled=false");
      assert.match(stdout, /FIXTURE_OK/);
    }
    for (const request of requests) {
      assert.equal(request.messages.filter(m => m.role === "user").length, 1, "no duplicated user prompts");
      assert.equal(request.messages.filter(m => m.role === "assistant").length, 0, "failed attempts must stay out of projected context");
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
for (const [mode, stop] of [["one", ""], ["on", ""], ["off", ""], ["on", "abort"], ["on", "off"]]) {
  await runScenario(mode, stop);
}
console.log("PASS real CLI: one/on retries, off, abort, off after failure; clean request context; resources closed");
