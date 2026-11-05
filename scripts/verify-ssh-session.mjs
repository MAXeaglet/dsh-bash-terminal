// Live end-to-end check of the ssh action against a real server.
//
// Not part of `npm test`: it needs a reachable host and credentials. Run it
// manually (see COMPATIBILITY-DSH-NEWEST.md):
//
//   node scripts/verify-ssh-session.mjs [sshHost]
//
// It exercises exactly what the model does through the terminal tool - open an
// ssh session, keep working inside it, interrupt, exit - and then asserts that
// the remote state really was one login, not one per command. It only creates
// and removes its own scratch directory under /tmp and never touches services.
import { createTerminalRegistry, terminalTool } from "../lib/terminal.js";
import { internals } from "../lib/index.js";
import assert from "node:assert";

const sshHost = process.argv[2] ?? "second_brain";
const paths = internals.resolveAllPaths({});
if (paths.wsl === undefined) throw new Error("wsl.exe not found; this check needs the wsl backend");

const ctx = {
  shellEnv: { collect: () => ({}) },
  subprocess: {},
  effect: () => () => {},
  get: () => undefined
};
const registry = createTerminalRegistry(ctx);
const tool = terminalTool(ctx, registry, paths, () => "wsl", () => "wsl");
const exec = { signal: new AbortController().signal, agent: { id: "verify-agent", session: { header: { cwd: process.cwd() } } }, callId: "c1" };

const scratch = "/tmp/dsh-ssh-session-check";
const show = (label, reply) => {
  const text = (reply.output ?? "").trim();
  console.log(`--- ${label} (offset ${reply.nextOffset}${reply.waiting === true ? ", waiting" : ""}) ---`);
  console.log(text.split("\n").slice(-12).join("\n"));
};

console.log(`opening an ssh session to ${sshHost} ...`);
const opened = await tool.execute({ action: "ssh", sshHost }, exec);
assert.strictEqual(opened.kind, "open");
assert.strictEqual(opened.sshHost, sshHost);
console.log(`session ${opened.sessionId} (pid ${opened.pid}, backend ${opened.shell})`);
show("login", opened);

// The login banner arrives in bursts and the remote prompt lands last, so wait
// for the prompt itself before typing: an ssh login has no fixed duration.
let ready;
for (let i = 0; i < 15; i++) {
  ready = await tool.execute({ action: "read", sessionId: opened.sessionId }, exec);
  const seen = (ready.output ?? "") + (ready.pending ?? "");
  if (/root@\S*[^#]*#\s*$/.test(seen.trimEnd()) || /[#$]\s*$/.test(seen.trimEnd())) break;
  await new Promise((r) => setTimeout(r, 1200));
}
show("ready", ready);
assert.ok(/(^|\s)[^\s]*[#$]\s*$/.test(((ready.output ?? "") + (ready.pending ?? "")).trimEnd()), "the remote shell prompt arrived: " + JSON.stringify((ready.pending ?? ready.output ?? "").slice(-80)));

// One login, several commands: the shell PID and the exported variable must
// survive between sends. That is the whole point of the session.
const first = await tool.execute({
  action: "send",
  sessionId: opened.sessionId,
  input: `mkdir -p ${scratch} && cd ${scratch} && export DSH_MARK=session-alive && echo "pid=$$" && echo "mark=$DSH_MARK"\r`
}, exec);
show("command 1", first);
assert.ok(first.output.includes("mark=session-alive"), "the exported variable is visible to the command");

const second = await tool.execute({
  action: "send",
  sessionId: opened.sessionId,
  input: `echo "still-pid=$$" && echo "still-mark=$DSH_MARK" && pwd && touch probe.txt && ls -la\r`
}, exec);
show("command 2", second);
assert.ok(second.output.includes("still-mark=session-alive"), "the variable survived into the next command - this is one ssh login, not one per command");
assert.ok(second.output.includes(scratch), "the working directory survived into the next command");

const pid1 = /pid=(\d+)/.exec(first.output)?.[1];
const pid2 = /still-pid=(\d+)/.exec(second.output)?.[1];
assert.ok(pid1 !== undefined && pid1 === pid2, `both commands ran in the same remote shell (${pid1} vs ${pid2})`);
console.log(`\nSAME REMOTE SHELL PID ACROSS COMMANDS: ${pid1}`);

// Ctrl+C must reach the REMOTE foreground process, not the ssh client.
await tool.execute({ action: "send", sessionId: opened.sessionId, input: "while true; do date +%T; sleep 0.4; done\n" }, exec);
await new Promise((r) => setTimeout(r, 1200));
const interrupted = await tool.execute({ action: "signal", sessionId: opened.sessionId, signal: "SIGINT" }, exec);
show("after SIGINT", interrupted);
assert.ok(interrupted.output.includes("^C"), "the interrupt is echoed by the remote terminal");
const alive = await tool.execute({ action: "send", sessionId: opened.sessionId, input: "echo INTERRUPT-WORKED\n" }, exec);
show("alive after SIGINT", alive);
assert.ok(alive.output.includes("INTERRUPT-WORKED"), "the session is still usable after Ctrl+C");

// Clean up our own scratch directory and leave the server as we found it.
const cleaned = await tool.execute({ action: "send", sessionId: opened.sessionId, input: `cd /tmp && rm -rf ${scratch} && ls -d ${scratch} 2>&1; echo CLEANED\r` }, exec);
show("cleanup", cleaned);
assert.ok(cleaned.output.includes("CLEANED"), "cleanup ran");

const loggedOut = await tool.execute({ action: "send", sessionId: opened.sessionId, input: "exit\n" }, exec);
show("logout", loggedOut);
const listed = await tool.execute({ action: "list" }, exec);
console.log("sessions after logout:", JSON.stringify(listed.sessions));

await tool.execute({ action: "close", sessionId: opened.sessionId }, exec).catch(() => {});
console.log("\nLIVE SSH SESSION CHECK PASSED");
process.exit(0);
