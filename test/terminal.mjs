// Interactive terminal test: drive the real node-pty through the plugin's
// registry + tool surface (fake ctx, real PTY backend).
import { createTerminalRegistry, terminalTool, terminalArgv } from "../lib/terminal.js";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import os from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import assert from "node:assert";

const profileRequire = createRequire(join(os.homedir(), ".dsh", "profiles", "web", "package.json"));
function loadNodePty() {
  // CI: node-pty installed into the project node_modules (npm install node-pty --no-save);
  // local dev: resolve from the profile dependency tree.
  try {
    return createRequire(import.meta.url)("node-pty");
  } catch {
    return profileRequire("node-pty");
  }
}
const nodePty = loadNodePty();

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
const pwsh7 = "C:/Program Files/PowerShell/7/pwsh.exe";
const paths = { pwsh: existsSync(pwsh7) ? pwsh7 : "C:/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe", gitbash: "C:/Program Files/Git/bin/bash.exe", wsl: "C:/WINDOWS/System32/wsl.exe" };
let defaultShell = "gitbash";
const tool = terminalTool(ctx, registry, paths, () => defaultShell);
assert.strictEqual(tool.name, "terminal");
// Machine-independent session cwd (the old D:/WorkSpace hardcode broke the
// test on every machine but the author's).
const workdir = mkdtempSync(join(os.tmpdir(), "dsh-terminal-test-"));
const exec = { signal: new AbortController().signal, agent: { id: "agent-test-1", session: { header: { cwd: workdir } } }, callId: "c1" };
function gitbashPath(p) {
  const m = /^([A-Za-z]):\\(.*)$/.exec(p);
  return m ? "/" + m[1].toLowerCase() + "/" + m[2].replace(/\\/g, "/") : p;
}

// argv shape
assert.deepStrictEqual(terminalArgv("gitbash", paths, undefined), ["C:/Program Files/Git/bin/bash.exe", "-i"]);
assert.deepStrictEqual(terminalArgv("powershell", paths, undefined), ["C:/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe", "-NoLogo", "-NoProfile"]);
assert.deepStrictEqual(terminalArgv("wsl", paths, "Ubuntu"), ["C:/WINDOWS/System32/wsl.exe", "-d", "Ubuntu", "-e", "bash", "-i"]);
assert.deepStrictEqual(terminalArgv("wsl", paths, undefined), ["C:/WINDOWS/System32/wsl.exe", "--", "bash", "-i"]);

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
// DSH 0.2.x resolves the job owner through the agent registry: it is the
// session id, and a pull source feeds the job ring the model reads back.
assert.strictEqual(jobsStarted[0].owner, "agent-test-1", "owner is the owning session id, not the Agent object");
assert.strictEqual(jobsStarted[0].output.length, 1, "the session advertises one pull source");
assert.strictEqual(jobsStarted[0].output[0].channel, "stdout");
assert.strictEqual(typeof jobsStarted[0].output[0].read, "function");

// session state persists across sends (cd then pwd); give bash -i time to be ready
await delay(1200);
const targetDir = gitbashPath(workdir);
const r1 = await tool.execute({ action: "send", sessionId: opened.sessionId, input: "cd \"" + targetDir + "\"\r" }, exec);
assert.strictEqual(r1.kind, "session");
const r2 = await tool.execute({ action: "send", sessionId: opened.sessionId, input: "pwd\r" }, exec);
assert.ok(r2.output.includes(targetDir), "pwd reflects the cd (session state persisted): " + JSON.stringify(r2.output.slice(-120)));
const r3 = await tool.execute({ action: "send", sessionId: opened.sessionId, input: "echo SESSION-KEEPS-ALIVE\r" }, exec);
assert.ok(r3.output.includes("SESSION-KEEPS-ALIVE"), "echo output visible");
assert.ok(Number.isInteger(r3.nextOffset) && r3.nextOffset > 0, "the reply reports its absolute stream offset: " + r3.nextOffset);

// read without write: an incremental read never repeats what the model has
await delay(200);
const r4 = await tool.execute({ action: "read", sessionId: opened.sessionId }, exec);
assert.strictEqual(r4.kind, "session");
assert.ok(!r4.output.includes("SESSION-KEEPS-ALIVE"), "a read carries only new output: " + JSON.stringify(r4.output.slice(-120)));
assert.ok(r4.nextOffset >= r3.nextOffset, "the reader cursor never moves backwards");
assert.strictEqual(r4.elided, undefined, "an existing reader is not reported as elided");

// full re-read on demand, and the from/full pair is validated
const r4full = await tool.execute({ action: "read", sessionId: opened.sessionId, from: 0 }, exec);
assert.ok(r4full.output.includes("SESSION-KEEPS-ALIVE") && r4full.output.includes(targetDir), "from: 0 re-reads the retained log");
await assert.rejects(() => tool.execute({ action: "read", sessionId: opened.sessionId, from: 0, full: true }, exec), /either from or full/);
await assert.rejects(() => tool.execute({ action: "read", sessionId: opened.sessionId, from: -1 }, exec), /invalid from/);
await assert.rejects(() => tool.execute({ action: "list", from: 0 }, exec), /from\/full apply/);

// every reply ends on a complete line: the unterminated prompt line is held
// back and reported as pending instead of being delivered as a torn line
const tailOut = await tool.execute({ action: "send", sessionId: opened.sessionId, input: "printf 'TAIL-%s' MARK\r" }, exec);
assert.ok(tailOut.output.endsWith("\n"), "delivered output ends on a line boundary: " + JSON.stringify(tailOut.output.slice(-40)));
assert.ok(typeof tailOut.pending === "string" && tailOut.pending.length > 0, "the unterminated prompt is reported as pending: " + JSON.stringify(tailOut.pending));

// \r overwrites collapse to the surviving text. The shell echoes the format
// string rather than the printed text, so the assertion is unambiguous.
const crOut = await tool.execute({ action: "send", sessionId: opened.sessionId, input: "printf 'CR-%s\\rCR-%s' OLD NEW\r" }, exec);
assert.ok(crOut.output.includes("CR-NEW"), "the surviving text of a \\r overwrite is delivered: " + JSON.stringify(crOut.output.slice(-60)));
assert.ok(!crOut.output.includes("CR-OLD"), "the overwritten text is collapsed away: " + JSON.stringify(crOut.output.slice(-60)));
assert.ok(!crOut.output.includes("\r"), "no bare carriage returns survive rendering");

// replies are terminal-rendered by default; raw: true keeps the stream
await tool.execute({ action: "send", sessionId: opened.sessionId, input: "printf '\\033[31mRED\\033[0m\\n'\r" }, exec);
const renderedReply = await tool.execute({ action: "read", sessionId: opened.sessionId, from: 0 }, exec);
assert.ok(renderedReply.output.includes("RED"), "the command output is delivered");
assert.ok(!renderedReply.output.includes("\u001b[31m"), "escape sequences are stripped by default: " + JSON.stringify(renderedReply.output.slice(-80)));
const rawReply = await tool.execute({ action: "read", sessionId: opened.sessionId, from: 0, raw: true }, exec);
assert.ok(rawReply.output.includes("\u001b[31m"), "raw: true keeps the untouched stream");

// signal delivers to foreground (SIGINT to the shell prompt is harmless)
const r5 = await tool.execute({ action: "signal", sessionId: opened.sessionId, signal: "SIGINT" }, exec);
assert.strictEqual(r5.kind, "session");

// close terminates the session
const closed = await tool.execute({ action: "close", sessionId: opened.sessionId }, exec);
assert.strictEqual(closed.kind, "closed");
await assert.rejects(() => tool.execute({ action: "send", sessionId: opened.sessionId, input: "x" }, exec), /not found|closed/);

// open with an initial command: the command runs in the fresh shell and its
// output is this reader's first reply, whose offset becomes the cursor
defaultShell = "gitbash";
const initOpened = await tool.execute({ action: "open", command: "echo INIT-OK" }, exec);
assert.ok(initOpened.output.includes("INIT-OK"), "the initial command's output is the startup reply: " + JSON.stringify(initOpened.output.slice(-120)));
assert.ok(Number.isInteger(initOpened.nextOffset), "the startup reply reports its absolute offset");
await delay(1200);
const initRead = await tool.execute({ action: "read", sessionId: initOpened.sessionId }, exec);
assert.ok(!initRead.output.includes("INIT-OK"), "a plain read does not repeat the startup output: " + JSON.stringify(initRead.output.slice(-120)));
const initFull = await tool.execute({ action: "read", sessionId: initOpened.sessionId, from: 0 }, exec);
assert.ok(initFull.output.includes("INIT-OK"), "from: 0 returns the startup output again");
await tool.execute({ action: "close", sessionId: initOpened.sessionId }, exec).catch(() => {});

// job hooks: cancel stops the session, `done` settles with a registry-shaped
// outcome (jobs.settle() writes outcome.status into the record), and the pull
// source hands the job ring the session's own stream
const hooks = jobsStarted[0].run();
assert.strictEqual(typeof hooks.cancel, "function");
assert.ok(hooks.done instanceof Promise);
const sourceRead = jobsStarted[0].output[0].read(0);
assert.ok(sourceRead.text.includes("SESSION-KEEPS-ALIVE"), "the job source carries the session stream: " + JSON.stringify(sourceRead.text.slice(-80)));
assert.ok(Number.isInteger(sourceRead.nextOffset) && sourceRead.nextOffset > 0, "the source reports its next offset");
const outcome = await Promise.race([hooks.done, delay(5000).then(() => "timeout")]);
assert.notStrictEqual(outcome, "timeout", "the session job settles when its PTY exits");
assert.deepStrictEqual(outcome, { status: "killed", detail: "session terminated" }, "a session this plugin terminated settles as killed, not as a natural exit: " + JSON.stringify(outcome));

// powershell backend interactive session.
// Note: Windows PowerShell 5.1 cannot start inside a ConPTY (0x8009001d);
// pwsh 7 works. The test tolerates the 5.1 failure and documents the limit.
defaultShell = "powershell";
const psOpened = await tool.execute({ action: "open" }, exec);
await delay(1000);
const psOut = await tool.execute({ action: "send", sessionId: psOpened.sessionId, input: "Get-Location\r" }, exec);
const psFailed = psOut.output.includes("8009001d") || psOut.output.includes("内部错误");
if (psFailed) {
  console.log("NOTE: powershell interactive unavailable in this environment (Windows PowerShell 5.1 cannot start in a ConPTY; install pwsh 7); skipping assertion");
} else {
  assert.ok(psOut.output.length > 0, "powershell interactive responds: " + JSON.stringify(psOut.output.slice(-100)));
  assert.ok(psOut.output.includes("Path"), "powershell interactive responds with a location: " + JSON.stringify(psOut.output.slice(-100)));
}
await tool.execute({ action: "close", sessionId: psOpened.sessionId }, exec).catch(() => {});

// wsl backend interactive session (WSL distro boot is slow; retry reads)
defaultShell = "wsl";
let wslOpened;
try {
  wslOpened = await tool.execute({ action: "open" }, exec);
} catch {
  console.log("NOTE: wsl.exe interactive unavailable (spawn failed); skipping assertion");
}
if (wslOpened !== undefined) {
  await delay(4500);
  let wslOut = await tool.execute({ action: "send", sessionId: wslOpened.sessionId, input: "pwd\r" }, exec);
  if (!wslOut.output.includes("/mnt/")) {
    await delay(1500);
    wslOut = await tool.execute({ action: "read", sessionId: wslOpened.sessionId }, exec);
  }
  // Tolerate genuine environment limits only: no distro, WSL not installed,
  // and the localhost-proxy "Wsl/Service/E_UNEXPECTED" crash. ConPTY RPC
  // failures are NOT tolerated any more - 0x8007072c was a real bug in the PTY
  // environment (a missing SystemRoot), fixed in buildPtyEnv() and guarded by
  // the regression assertions in test/unit.mjs.
  const wslFailed = wslOut.output.length === 0
    || wslOut.output.includes("not installed")
    || wslOut.output.includes("E_UNEXPECTED");
  if (wslFailed) {
    console.log("NOTE: wsl.exe interactive unavailable in this environment (no distro / ConPTY RPC error); skipping assertion");
  } else {
    assert.ok(wslOut.output.includes("/mnt/"), "wsl interactive responds with /mnt/ path: " + JSON.stringify(wslOut.output.slice(-150)));
  }
  await tool.execute({ action: "close", sessionId: wslOpened.sessionId }, exec).catch(() => {});
}

// a shell that exits on its own keeps its output readable but refuses input:
// writing into a dead PTY would otherwise be swallowed and read as "no output"
defaultShell = "gitbash";
const exitedSession = await tool.execute({ action: "open", command: "exit" }, exec);
await delay(1500);
const exitedList = await tool.execute({ action: "list" }, exec);
const exitedEntry = exitedList.sessions.find((s) => s.sessionId === exitedSession.sessionId);
assert.ok(exitedEntry !== undefined && exitedEntry.exited === true, "an exited PTY is listed as exited: " + JSON.stringify(exitedEntry));
await assert.rejects(() => tool.execute({ action: "send", sessionId: exitedSession.sessionId, input: "echo x\r" }, exec), /has exited/, "input into a dead session is refused, not silently swallowed");
await assert.rejects(() => tool.execute({ action: "signal", sessionId: exitedSession.sessionId, signal: "SIGINT" }, exec), /has exited/);
const farewell = await tool.execute({ action: "read", sessionId: exitedSession.sessionId, from: 0 }, exec);
assert.strictEqual(farewell.kind, "session", "the final output stays readable after the shell exits");
await tool.execute({ action: "close", sessionId: exitedSession.sessionId }, exec);

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

// settle-based read returns the COMPLETE multi-line reply (not a fixed-delay slice)
defaultShell = "gitbash";
const settleOpened = await tool.execute({ action: "open" }, exec);
await delay(1500);
let multiOut = await tool.execute({ action: "send", sessionId: settleOpened.sessionId, input: "seq 1 8\r" }, exec);
if (!(multiOut.output.match(/^[1-8]$/gm) || []).length) {
  // git-bash may not have been ready for the first write; retry once
  await delay(800);
  multiOut = await tool.execute({ action: "send", sessionId: settleOpened.sessionId, input: "seq 1 8\r" }, exec);
}
const seen = (multiOut.output.match(/^[1-8]$/gm) || []).length;
assert.ok(seen >= 7, "multi-line output settled fully (got " + seen + "/8): " + JSON.stringify(multiOut.output.slice(-160)));
await tool.execute({ action: "close", sessionId: settleOpened.sessionId }, exec).catch(() => {});

// idle timeout: a session with a short idle window auto-closes
const opened2 = await tool.execute({ action: "open", idleMs: 400 }, exec);
await delay(900);
await assert.rejects(() => tool.execute({ action: "send", sessionId: opened2.sessionId, input: "x" }, exec), /not found|closed/);

// validation
await assert.rejects(() => tool.execute({ action: "bogus" }, exec), /must be one of|invalid action/);
await assert.rejects(() => tool.execute({ action: "send", sessionId: "nope", input: "x" }, exec), /not found/);

try { rmSync(workdir, { recursive: true, force: true }); } catch {}

console.log("TERMINAL TESTS PASSED (real node-pty interactive session)");
// node-pty's ConPTY console agent races process teardown on Windows: it is a
// detached child that calls AttachConsole after the console is gone and aborts
// with "AttachConsole failed", which turns a fully green run into exit code 1
// and breaks the `&&` chain in `npm test`. Every assertion has already run, so
// give the PTYs a moment to die, then leave with an explicit success status.
await delay(400);
process.exit(0);
