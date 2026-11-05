// Settle-window and ssh-session tests.
//
// Two behaviours are guarded here, both of which decide whether the model keeps
// using one long-lived session or falls back to one-shot `ssh host <command>`
// calls:
//
//  1. `waitSettled` must not call a reply "complete" while output is still
//     arriving, and it must say so (`waiting`) when its cap expires. The original
//     80 ms poll against a 300 ms quiet window sampled the ring too coarsely and
//     reported "quiet" for output that landed between two polls - which is how
//     `ssh host` came back looking like it printed nothing.
//  2. The ssh action must open a session on the backend that actually has the
//     ssh aliases and keys (wsl), with a real TERM, and must mark the session
//     remote so it gets the longer settle windows and idle timeout.
//
// The ssh-path half deliberately does NOT need a server: the PTY is faked, so
// this file stays runnable in CI. A real end-to-end ssh run is a manual check
// (see COMPATIBILITY-DSH-NEWEST.md), because it needs a host and credentials.
import { createBuffer, createTerminalRegistry, terminalTool, waitSettled, buildPtyEnv, REMOTE_TERM, LOCAL_QUIET_MS, LOCAL_SETTLE_TIMEOUT_MS, REMOTE_IDLE_MS, DEFAULT_IDLE_MS } from "../lib/terminal.js";
import assert from "node:assert";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. settle windows ------------------------------------------------------

// A local command that answers promptly settles on its quiet window: the output
// appears, then the silence after it ends the wait.
{
  const buffer = createBuffer();
  const started = Date.now();
  setTimeout(() => buffer.append("done\n"), 30);
  const outcome = await waitSettled(buffer, { quietMs: 120, timeoutMs: 4000 });
  const elapsed = Date.now() - started;
  assert.strictEqual(outcome.settled, true, "output followed by silence settles the wait");
  assert.strictEqual(outcome.waiting, false, "a completed command is not reported as still running");
  assert.ok(elapsed >= 140, "the quiet window is actually waited out: " + elapsed + "ms");
  assert.ok(elapsed < 2000, "a prompt answer returns promptly instead of burning the whole cap: " + elapsed + "ms");
}

// The regression this file exists for: output that arrives SLOWER than the quiet
// window but is still arriving must not be mistaken for a finished command. A
// 300 ms quiet window with a coarse poll reported "settled" while a banner was
// still in flight; the loop now restarts its silence window on every new byte.
{
  const buffer = createBuffer();
  const pollMs = 60;
  let appends = 0;
  const ticker = setInterval(() => { appends += 1; buffer.append("banner line " + appends + "\n"); }, pollMs);
  const outcome = await waitSettled(buffer, { quietMs: 200, timeoutMs: 2000 });
  clearInterval(ticker);
  assert.ok(appends >= 3, "the slow producer did emit during the wait: " + appends);
  assert.strictEqual(outcome.settled, false, "output slower than the quiet window is not treated as settled");
  assert.strictEqual(outcome.waiting, true, "still-arriving output is reported as waiting, not as a finished reply");
}

// A cap that expires while output keeps flowing must report `waiting`, so the
// model reads again instead of typing the next command into a busy shell.
{
  const buffer = createBuffer();
  const ticker = setInterval(() => buffer.append("."), 40);
  const outcome = await waitSettled(buffer, { quietMs: 200, timeoutMs: 400 });
  clearInterval(ticker);
  assert.strictEqual(outcome.waiting, true, "a cap that expires mid-stream reports waiting: " + JSON.stringify(outcome));
}

// THE regression this file exists for. A session that was already idle when the
// input was written is "quiet" by definition, so a silence test that ignores the
// entry position returns IMMEDIATELY with the previous command's output and
// nothing from the command just sent. On a remote session that read to the model
// as "the command did nothing", and it went back to one-shot `ssh host <cmd>`.
{
  const buffer = createBuffer();
  buffer.append("output of an earlier command\n"); // the session is now idle
  const started = Date.now();
  const outcome = await waitSettled(buffer, { quietMs: 120, timeoutMs: 3000, awaitOutputMs: 500 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 450, "a write into an already-quiet session must not return instantly (returned after " + elapsed + "ms)");
  assert.strictEqual(outcome.settled, false, "no output arrived, so the reply is not complete");
  assert.strictEqual(outcome.waiting, true, "the model is told to read again instead of seeing an empty result");
}

// The same anchor, but the command does answer: the reply must be called
// complete only after the new output appeared AND went quiet.
{
  const buffer = createBuffer();
  buffer.append("earlier output\n");
  const started = Date.now();
  const timer = setTimeout(() => buffer.append("MARK-TWO\n"), 200);
  const outcome = await waitSettled(buffer, { quietMs: 200, timeoutMs: 3000, awaitOutputMs: 500 });
  clearTimeout(timer);
  const elapsed = Date.now() - started;
  assert.strictEqual(outcome.settled, true, "the new output settles the wait");
  assert.strictEqual(outcome.waiting, false, "a completed command is not reported as still running");
  assert.ok(elapsed >= 380, "the wait covered the response and its quiet window: " + elapsed + "ms");
  assert.ok(buffer.snapshot().includes("MARK-TWO"), "the new output is in the ring");
}

// Local defaults stay snappy: an idle session settles on the local window.
assert.ok(LOCAL_SETTLE_TIMEOUT_MS >= LOCAL_QUIET_MS * 4, "the local cap leaves room for several quiet windows");

// ---- 2. the ssh action ------------------------------------------------------

/** Records what the ssh path actually spawned, without needing a server. */
function fakeRegistry() {
  const opened = [];
  const writes = [];
  const handles = [];
  const ctx = {
    shellEnv: { collect: () => ({ DSH_WEB_URL: "http://x" }) },
    effect: () => () => {},
    get: () => undefined
  };
  // Injected spawner: the registry's win32 path bypasses ctx.subprocess on
  // purpose, so a fake ctx alone would allocate real ConPTYs.
  const registry = createTerminalRegistry(ctx, async (spec) => {
    opened.push(spec);
    const output = new PassThrough();
    const handle = {
      pid: 4242,
      output,
      done: new Promise(() => {}),
      write: async (data) => { writes.push(data); },
      signalForeground: async () => {},
      terminate: async () => {},
      emit: (text) => output.write(Buffer.from(text, "utf8"))
    };
    handles.push(handle);
    return handle;
  });
  return { registry, opened, writes, handles, ctx };
}

const { registry, opened, writes, handles, ctx } = fakeRegistry();
const paths = { pwsh: "C:/pwsh.exe", gitbash: "C:/Git/bin/bash.exe", wsl: "C:/Windows/System32/wsl.exe" };
/** The registry's own record for a session, to read the fields no reply carries. */
const sessionOf = (id) => registry.peek(id);
// defaultShell is gitbash while sshShell is wsl: the ssh action must NOT follow
// the everyday terminal.
const tool = terminalTool({ shellEnv: { collect: () => ({}) }, get: () => undefined }, registry, paths, () => "gitbash", () => "wsl");
const workdir = mkdtempSync(join(os.tmpdir(), "dsh-settle-test-"));
const exec = { signal: new AbortController().signal, agent: { id: "agent-settle", session: { header: { cwd: workdir } } }, callId: "c1" };

const sshOpened = await tool.execute({ action: "ssh", sshHost: "second_brain" }, exec);
assert.strictEqual(sshOpened.kind, "open");
assert.strictEqual(sshOpened.sshHost, "second_brain", "the reply names the destination");
assert.strictEqual(sshOpened.shell, "wsl", "ssh uses the wsl backend even though the default terminal is gitbash");
assert.strictEqual(opened.length, 1, "one PTY was allocated");
assert.deepStrictEqual(opened[0].argv, ["C:/Windows/System32/wsl.exe", "--", "bash", "-i"], "ssh runs behind an interactive LOCAL shell, not as the top-level process: " + JSON.stringify(opened[0].argv));
assert.strictEqual(writes[0], "ssh second_brain\r", "the login is typed into that shell");
assert.strictEqual(opened[0].env.TERM, REMOTE_TERM, "a remote session gets a real TERM: " + opened[0].env.TERM);
assert.strictEqual(opened[0].env.NO_COLOR, undefined, "NO_COLOR is dropped for remote sessions so the far side can colorize");

// Remote sessions are marked as such in the session list.
const listed = await tool.execute({ action: "list" }, exec);
const entry = listed.sessions.find((s) => s.sessionId === sshOpened.sessionId);
assert.strictEqual(entry.sshHost, "second_brain", "a remote session is identifiable in the list");

// A command that answers nothing is reported as still running rather than as an
// empty result: the fake PTY never replies, so the first-output wait expires and
// the model is told to read again instead of concluding the command did nothing.
const sent = await tool.execute({ action: "send", sessionId: sshOpened.sessionId, input: "echo hi\r" }, exec);
assert.strictEqual(sent.waiting, true, "an unresponsive remote command is reported as still running: " + JSON.stringify({ waiting: sent.waiting }));

// The model-facing trailer must explain `waiting` when it IS set - that trailer
// is the only place the model learns to read again instead of typing the next
// command into a busy shell.
const busyText = tool.output.render({ action: "send" }, { output: "partial\n", nextOffset: 10, waiting: true })[0].text;
assert.ok(busyText.includes("still producing output"), "the trailer tells the model to read again: " + JSON.stringify(busyText));
assert.ok(busyText.includes("read again before sending the next command"), "the trailer explains the consequence: " + JSON.stringify(busyText));

// A remote session outlives the local idle window: re-establishing an ssh login
// is the expensive part, so the default idle timeout is the longer one.
assert.ok(REMOTE_IDLE_MS > DEFAULT_IDLE_MS, "remote sessions idle longer than local ones");
assert.strictEqual(sessionOf(sshOpened.sessionId).idleMs, REMOTE_IDLE_MS, "an ssh session uses the remote idle window: " + sessionOf(sshOpened.sessionId).idleMs);

// A local session keeps the uncolored default terminal type, no ssh host, and
// the shorter idle window.
const localOpened = await tool.execute({ action: "open" }, exec);
assert.strictEqual(localOpened.shell, "gitbash");
assert.strictEqual(localOpened.sshHost, undefined, "a local session carries no ssh host");
assert.strictEqual(opened[1].env.TERM, "dumb", "local sessions keep the dumb default (see buildPtyEnv)");
assert.strictEqual(buildPtyEnv({}).NO_COLOR, "1", "local PTYs still suppress color");
assert.strictEqual(sessionOf(localOpened.sessionId).idleMs, DEFAULT_IDLE_MS, "a local session keeps the local idle window: " + sessionOf(localOpened.sessionId).idleMs);

// Validation: a destination is typed into a shell, so it is checked first.
await assert.rejects(() => tool.execute({ action: "ssh" }, exec), /invalid sshHost/);
await assert.rejects(() => tool.execute({ action: "ssh", sshHost: "host; rm -rf /" }, exec), /invalid sshHost/);
await assert.rejects(() => tool.execute({ action: "open", sshHost: "second_brain" }, exec), /only the ssh action takes a host/);
// ssh needs a backend whose ssh config has the aliases.
const noWsl = terminalTool({ shellEnv: { collect: () => ({}) }, get: () => undefined }, registry, { ...paths, wsl: undefined }, () => "powershell", () => "wsl");
await assert.rejects(() => noWsl.execute({ action: "ssh", sshHost: "second_brain" }, exec), /need the wsl backend/);

await tool.execute({ action: "close", sessionId: sshOpened.sessionId }, exec).catch(() => {});
await tool.execute({ action: "close", sessionId: localOpened.sessionId }, exec).catch(() => {});
try { rmSync(workdir, { recursive: true, force: true }); } catch {}

console.log("SETTLE + SSH SESSION TESTS PASSED");
process.exit(0);
