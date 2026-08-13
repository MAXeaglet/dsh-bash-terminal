// Interactive terminal test: drive the real node-pty through the plugin's
// registry + tool surface (fake ctx, real PTY backend).
import { createTerminalRegistry, terminalTool, terminalArgv } from "../lib/terminal.js";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import assert from "node:assert";

const profileRequire = createRequire("C:/Users/10045/.dsh/profiles/web/package.json");
const nodePty = profileRequire("node-pty");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function realPtyHandle(spec) {
  const term = nodePty.spawn(spec.argv[0], spec.argv.slice(1), {
    name: "dumb", rows: spec.rows, cols: spec.cols, cwd: spec.cwd, env: { ...spec.env, TERM: "dumb", NO_COLOR: "1" }
  });
  const output = new PassThrough();
  term.onData((d) => output.write(Buffer.from(d, "utf8")));
  const writes = [];
  const signals = [];
  const done = new Promise((resolve) => term.onExit(({ exitCode, signal }) => resolve({ exitCode, signal })));
  return {
    pid: term.pid,
    output,
    done,
    write: async (data) => { writes.push(data); term.write(data); },
    signalForeground: async (sig) => { signals.push(sig); try { term.kill(sig); } catch {} return 1; },
    terminate: async () => { try { term.kill(); } catch {} },
    inspectForeground: async () => undefined,
    writes,
    signals
  };
}

const shellEnv = { collect: () => ({ DSH_WEB_URL: "http://x" }) };
const jobsStarted = [];
const ctx = {
  shellEnv,
  subprocess: { spawnTerminal: async (spec) => realPtyHandle(spec) },
  effect: () => () => {},
  get: (key) => key === "jobs" ? { start: (spec) => { jobsStarted.push(spec); return "job-session-1"; } } : undefined
};
const registry = createTerminalRegistry(ctx);
const paths = { pwsh: "C:/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe", gitbash: "C:/Program Files/Git/bin/bash.exe", wsl: "C:/WINDOWS/System32/wsl.exe" };
let defaultShell = "gitbash";
const tool = terminalTool(ctx, registry, paths, () => defaultShell);
assert.strictEqual(tool.name, "terminal");
const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: "D:/WorkSpace" } } }, callId: "c1" };

// argv shape
assert.deepStrictEqual(terminalArgv("gitbash", paths, undefined), ["C:/Program Files/Git/bin/bash.exe", "-i"]);
assert.deepStrictEqual(terminalArgv("powershell", paths, undefined), ["C:/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe", "-NoLogo", "-NoProfile"]);
assert.deepStrictEqual(terminalArgv("wsl", paths, "Ubuntu"), ["C:/WINDOWS/System32/wsl.exe", "-d", "Ubuntu", "-e", "bash", "-i"]);

// open a persistent git-bash session
const opened = await tool.execute({ action: "open" }, exec);
assert.strictEqual(opened.kind, "open");
assert.ok(opened.sessionId, "session id returned");
assert.strictEqual(opened.shell, "gitbash");
assert.ok(opened.pid > 0);
assert.strictEqual(opened.jobId, "job-session-1", "session registered as a background job");
assert.strictEqual(jobsStarted.length, 1);
assert.strictEqual(jobsStarted[0].kind, "terminal/session");
assert.strictEqual(typeof jobsStarted[0].run, "function");

// session state persists across sends (cd then pwd)
await delay(600);
const r1 = await tool.execute({ action: "send", sessionId: opened.sessionId, input: "cd /d/WorkSpace/projects\r" }, exec);
assert.strictEqual(r1.kind, "session");
const r2 = await tool.execute({ action: "send", sessionId: opened.sessionId, input: "pwd\r" }, exec);
assert.ok(r2.output.includes("/d/WorkSpace/projects"), "pwd reflects the cd (session state persisted): " + JSON.stringify(r2.output.slice(-120)));
const r3 = await tool.execute({ action: "send", sessionId: opened.sessionId, input: "echo SESSION-KEEPS-ALIVE\r" }, exec);
assert.ok(r3.output.includes("SESSION-KEEPS-ALIVE"), "echo output visible");

// read without write
await delay(200);
const r4 = await tool.execute({ action: "read", sessionId: opened.sessionId }, exec);
assert.strictEqual(r4.kind, "session");

// signal delivers to foreground (SIGINT to the shell prompt is harmless)
const r5 = await tool.execute({ action: "signal", sessionId: opened.sessionId, signal: "SIGINT" }, exec);
assert.strictEqual(r5.kind, "session");

// close terminates the session
const closed = await tool.execute({ action: "close", sessionId: opened.sessionId }, exec);
assert.strictEqual(closed.kind, "closed");
await assert.rejects(() => tool.execute({ action: "send", sessionId: opened.sessionId, input: "x" }, exec), /not found|closed/);

// powershell backend interactive session.
// Note: Windows PowerShell 5.1 cannot start inside a ConPTY (0x8009001d);
// pwsh 7 works. The test tolerates the 5.1 failure and documents the limit.
defaultShell = "powershell";
const psOpened = await tool.execute({ action: "open" }, exec);
await delay(1000);
const psOut = await tool.execute({ action: "send", sessionId: psOpened.sessionId, input: "Get-Location\r" }, exec);
const psFailed = psOut.output.includes("8009001d") || psOut.output.includes("内部错误");
if (psFailed) {
  console.log("NOTE: Windows PowerShell 5.1 cannot start in a ConPTY (install pwsh 7 for interactive powershell); skipping assertion");
} else {
  assert.ok(psOut.output.length > 0, "powershell interactive responds: " + JSON.stringify(psOut.output.slice(-100)));
  assert.ok(psOut.output.toLowerCase().includes("workspace") || psOut.output.includes("WorkSpace"), "powershell location visible");
}
await tool.execute({ action: "close", sessionId: psOpened.sessionId }, exec).catch(() => {});

// wsl backend interactive session (WSL distro boot is slow; retry reads)
defaultShell = "wsl";
const wslOpened = await tool.execute({ action: "open" }, exec);
await delay(4500);
let wslOut = await tool.execute({ action: "send", sessionId: wslOpened.sessionId, input: "pwd\r" }, exec);
if (!wslOut.output.includes("/mnt/")) {
  await delay(1500);
  wslOut = await tool.execute({ action: "read", sessionId: wslOpened.sessionId }, exec);
}
const wslFailed = wslOut.output.includes("0x8007072c") || wslOut.output.includes("RPC");
if (wslFailed) {
  console.log("NOTE: wsl.exe interactive under ConPTY hit a WSL service RPC error; one-shot -lc commands work, interactive may need a terminal emulator");
} else {
  assert.ok(wslOut.output.includes("/mnt/"), "wsl interactive responds with /mnt/ path: " + JSON.stringify(wslOut.output.slice(-150)));
}
await tool.execute({ action: "close", sessionId: wslOpened.sessionId }, exec).catch(() => {});

// session cap: opening beyond MAX_SESSIONS refuses; list shows them
defaultShell = "gitbash";
const capped = [];
for (let i = 0; i < 8; i++) capped.push(await tool.execute({ action: "open" }, exec));
await assert.rejects(() => tool.execute({ action: "open" }, exec), /too many open sessions/);
const listed = await tool.execute({ action: "list" }, exec);
assert.ok(Array.isArray(listed.sessions));
assert.ok(listed.sessions.length >= 8, "list shows open sessions: " + listed.sessions.length);
assert.ok(listed.sessions.every((s) => s.shell === "gitbash"));
for (const s of capped) await tool.execute({ action: "close", sessionId: s.sessionId }, exec);

// idle timeout: a session with a short idle window auto-closes
const opened2 = await tool.execute({ action: "open", idleMs: 400 }, exec);
await delay(900);
await assert.rejects(() => tool.execute({ action: "send", sessionId: opened2.sessionId, input: "x" }, exec), /not found|closed/);

// validation
await assert.rejects(() => tool.execute({ action: "bogus" }, exec), /must be one of|invalid action/);
await assert.rejects(() => tool.execute({ action: "send", sessionId: "nope", input: "x" }, exec), /not found/);

console.log("TERMINAL TESTS PASSED (real node-pty interactive session)");
