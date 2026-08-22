import { apply, internals, SHELLS, DEFAULT_SHELL } from "../lib/index.js";
import assert from "node:assert";

// ---- mock ctx for apply() ----
let registered = null;
let userDefaultShell = "powershell"; // what the user picked in the Web UI
let sandboxMode = "danger-full-access"; // per-call sandbox policy mode
let assembleHandler = null; // captured system-prompt/assemble waterfall listener
const ctx = {
  logger: { info: () => {} },
  systemPrompt: { section: (s) => { assert.ok(s.name === "tool:bash-terminal"); } },
  tools: { register: (tool) => { registered = tool; } },
  on: (event, handler) => { if (event === "system-prompt/assemble") assembleHandler = handler; },
  shellEnv: { collect: () => ({ DSH_WEB_URL: "http://127.0.0.1:3080" }) },
  settings: {
    register: (ns, schema, options) => {
      assert.strictEqual(String(ns), "bash-terminal", "settings namespace");
      assert.ok(schema, "settings schema provided");
      assert.deepStrictEqual(options.base, { defaultShell: "powershell" }, "settings base");
      return { get: () => ({ defaultShell: userDefaultShell }) };
    }
  },
  sandboxPolicy: {
    resolve: () => ({ mode: sandboxMode, workspaceRoot: "D:/WorkSpace", sessionId: "s1" })
  },
  sandbox: {
    confine: (argv, policy) => ({ argv: ["sandbox-runner", "--", ...argv], enforcement: "full" })
  },
  get: (key) => key === "approval" ? { request: async () => "allowed-once" } : key === "jobs" ? { start: (spec) => { jobsStarted.push(spec); return "job-bg-1"; } } : undefined,
  effect: () => () => {},
  subprocess: null
};
apply(ctx, {});
assert.ok(registered, "tool registered");
assert.strictEqual(registered.name, "shell");
assert.strictEqual(registered.parameters.properties.shell, undefined, "model-facing shell param removed");

// ---- mock subprocess + execute() ----
const spawnCalls = [];
const jobsStarted = [];
const fakeHandle = {
  collected: {
    stdout: { readFrom: () => ({ text: "mock-out", lossy: false, nextOffset: 1 }) },
    stderr: { readFrom: () => ({ text: "", lossy: false, nextOffset: 0 }) }
  },
  done: Promise.resolve({ exitCode: 0, signal: null }),
  terminate: () => {}
};
ctx.subprocess = {
  spawn: (spec) => { spawnCalls.push(spec); return fakeHandle; }
};

const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: "D:/WorkSpace" } } }, callId: "c1" };

// 1) user setting = powershell (default) -> powershell argv
userDefaultShell = "powershell";
const result = await registered.execute({ command: "Get-Date", description: "t" }, exec);
assert.strictEqual(result.kind, "foreground");
assert.strictEqual(result.exitCode, 0);
assert.strictEqual(spawnCalls.length, 1);
const spec = spawnCalls[0];
assert.ok(spec.argv[0].endsWith("pwsh.exe") || spec.argv[0].endsWith("powershell.exe"), "pwsh/powershell resolved: " + spec.argv[0]);
assert.deepStrictEqual(spec.argv.slice(1, 5), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
assert.strictEqual(spec.cwd, "D:/WorkSpace");
assert.strictEqual(spec.env.DSH_WEB_URL, "http://127.0.0.1:3080");
assert.strictEqual(spec.graceMs, 3000);
assert.ok(spec.signal instanceof AbortSignal);

// 2) user setting = gitbash -> gitbash argv (model cannot override)
userDefaultShell = "gitbash";
spawnCalls.length = 0;
await registered.execute({ command: "echo hi", description: "test" }, exec);
assert.deepStrictEqual(spawnCalls[0].argv.slice(0, 2), ["C:\\Program Files\\Git\\bin\\bash.exe", "-lc"]);

// 3) user setting = wsl + distro + workdir
userDefaultShell = "wsl";
spawnCalls.length = 0;
await registered.execute({ command: "pwd", description: "t", distro: "Ubuntu", workdir: "projects" }, exec);
const wslPath = (process.env.SystemRoot ?? "C:\\Windows").replace(/\\$/, "") + "\\System32\\wsl.exe";
assert.deepStrictEqual(spawnCalls[0].argv, [wslPath, "-d", "Ubuntu", "-e", "bash", "-lc", "pwd"]);
assert.strictEqual(spawnCalls[0].cwd, "D:\\WorkSpace\\projects");
assert.ok(spawnCalls[0].env.WSLENV.includes("DSH_WEB_URL"), "WSLENV should carry DSH vars");

// 4) timeout clamp: timeoutMs beyond max is capped
userDefaultShell = "powershell";
spawnCalls.length = 0;
await registered.execute({ command: "x", description: "t", timeoutMs: 99999999 }, exec);
assert.ok(spawnCalls[0].signal, "has fused signal");

// render output shape
const rendered = registered.output.render({}, { kind: "foreground", stdout: { text: "hi", truncated: false }, stderr: { text: "", truncated: false }, exitCode: 0, signal: null, timedOut: false, timeoutMs: 1, aborted: false });
assert.strictEqual(rendered[0].text, "hi");

// 5) sandbox: danger-full-access -> no confine, no sandbox facts
userDefaultShell = "powershell";
sandboxMode = "danger-full-access";
spawnCalls.length = 0;
await registered.execute({ command: "x", description: "t" }, exec);
assert.ok(!spawnCalls[0].argv.includes("sandbox-runner"), "no confine under danger-full-access");

// 6) sandbox: read-only + powershell -> confine argv through ctx.sandbox
sandboxMode = "read-only";
spawnCalls.length = 0;
const confined = await registered.execute({ command: "x", description: "t" }, exec);
assert.strictEqual(spawnCalls[0].argv[0], "sandbox-runner", "confined argv first element is the runner");
assert.deepStrictEqual(confined.sandbox, { mode: "read-only", enforcement: "full", denied: false });

// 7) sandbox: read-only + wsl -> not confined (WSL isolation is the sandbox)
sandboxMode = "read-only";
userDefaultShell = "wsl";
spawnCalls.length = 0;
const wslConfined = await registered.execute({ command: "echo hi", description: "t" }, exec);
assert.ok(!spawnCalls[0].argv.includes("sandbox-runner"), "wsl not confined");
assert.strictEqual(wslConfined.sandbox.enforcement, "wsl-isolation");

// 8) sandbox: read-only + gitbash -> not confined (Windows ACL cannot host Cygwin)
userDefaultShell = "gitbash";
spawnCalls.length = 0;
const gitConfined = await registered.execute({ command: "echo hi", description: "t" }, exec);
assert.ok(!spawnCalls[0].argv.includes("sandbox-runner"), "gitbash not confined under read-only");
assert.strictEqual(gitConfined.sandbox.enforcement, "gitbash-unconfined");

// 9) sandbox escalation: sandbox_permissions + justification widens policy
userDefaultShell = "powershell";
sandboxMode = "read-only";
spawnCalls.length = 0;
const escalated = await registered.execute({ command: "x", description: "t", sandbox_permissions: "danger-full-access", justification: "need full access for the test" }, exec);
assert.strictEqual(escalated.sandbox, undefined, "danger-full-access approved -> no confine");

// 10) escalation pairing validation
await assert.rejects(() => registered.execute({ command: "x", description: "t", sandbox_permissions: "workspace-write" }, exec), /justification/);
await assert.rejects(() => registered.execute({ command: "x", description: "t", justification: "why" }, exec), /sandbox_permissions/);

// 11) params advertise escalation modes
assert.ok(registered.parameters.properties.sandbox_permissions, "sandbox_permissions advertised");
assert.deepStrictEqual(registered.parameters.properties.sandbox_permissions.enum, ["workspace-write", "danger-full-access"]);

// 12) fail-closed: sandbox backend unavailable -> SandboxUnavailableError-like rejection
sandboxMode = "read-only";
userDefaultShell = "powershell";
const realConfine = ctx.sandbox.confine;
ctx.sandbox.confine = () => { throw new Error("sandbox mode \"read-only\" is requested but no sandbox backend is usable on this host"); };
await assert.rejects(() => registered.execute({ command: "x", description: "t" }, exec), /no sandbox backend/);
ctx.sandbox.confine = realConfine;

// 13) background execution registers a job with working hooks
userDefaultShell = "powershell";
sandboxMode = "danger-full-access";
spawnCalls.length = 0;
const bg = await registered.execute({ command: "sleep 1", description: "t", run_in_background: true }, exec);
assert.strictEqual(bg.kind, "background");
assert.strictEqual(bg.jobId, "job-bg-1");
assert.strictEqual(jobsStarted.length, 1);
assert.strictEqual(jobsStarted[0].kind, "shell/powershell");
const bgHooks = jobsStarted[0].run();
assert.strictEqual(typeof bgHooks.cancel, "function");
assert.ok(bgHooks.done instanceof Promise);
assert.strictEqual(typeof bgHooks.readOutput, "function");
assert.ok(spawnCalls.length >= 1, "background spawned");

// invalid args throw
await assert.rejects(() => registered.execute({ command: "", description: "t" }, exec));

// settings schema rejects an out-of-enum user value
userDefaultShell = "fish";
await assert.rejects(() => registered.execute({ command: "x", description: "t" }, exec));

// ---- system-prompt/assemble: description re-renders with the user's shell ----

assert.ok(assembleHandler, "assemble waterfall listener registered");
const makeAssembly = () => ({
  tools: [
    { name: "shell", description: "stale-description" },
    { name: "read", description: "read a file" }
  ],
  sections: [],
  contexts: []
});

// gitbash user setting -> bash-flavored description for the shell tool only.
userDefaultShell = "gitbash";
const gitAssembly = await assembleHandler(makeAssembly(), {}, async () => makeAssembly());
assert.ok(gitAssembly.tools[0].description.includes("bash -lc"), "gitbash description applied");
assert.ok(gitAssembly.tools[0].description.includes("is gitbash"), "gitbash backend named");
assert.strictEqual(gitAssembly.tools[1].description, "read a file", "other tools untouched");

// Hot-reload: switching the setting re-renders on the next assembly.
userDefaultShell = "powershell";
const psAssembly = await assembleHandler(makeAssembly(), {}, async () => makeAssembly());
assert.ok(psAssembly.tools[0].description.includes("pwsh -NoLogo"), "powershell description applied after setting change");
assert.ok(!psAssembly.tools[0].description.includes("bash -lc"), "stale gitbash description gone");

// Registration-time description already matches the initial setting.
assert.ok(registered.description.includes("is powershell"), "registration-time description matches initial default");

console.log("APPLY/EXECUTE MOCK TESTS PASSED");
