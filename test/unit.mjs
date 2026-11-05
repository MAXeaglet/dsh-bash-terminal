
import { buildArgv, buildEnv, buildStdin, candidateGitBashPaths, candidatePwshPaths, encodePowerShellCommand, internals } from "../lib/index.js";
import { buildPtyEnv, terminalTool, validateSshHost, resolveSshShell, settleOptions, SETTLE_POLL_MS, LOCAL_QUIET_MS, REMOTE_QUIET_MS, LOCAL_SETTLE_TIMEOUT_MS, REMOTE_SETTLE_TIMEOUT_MS, AWAIT_OUTPUT_MS, REMOTE_AWAIT_OUTPUT_MS, REMOTE_TERM } from "../lib/terminal.js";
const { renderResult, resolveAllPaths, validateArgs, toolDescription, SHELL_DESCRIPTIONS, spawnSpec, stdinDisposition } = internals;
import assert from "node:assert";

const paths = { pwsh: "C:\\pwsh.exe", gitbash: "C:\\Git\\bin\\bash.exe", wsl: "C:\\Windows\\System32\\wsl.exe" };

// ---- the script never travels through argv as raw text ----------------------
//
// The regression this guards: `bash -lc <command>` / `-Command <command>` put
// the whole heredoc on the Windows command line. Newlines and quotes crossed
// the Windows->WSL re-parse off by a byte, and commands beyond the ~32K Windows
// command-line limit were truncated, leaving `cat` reading an open stdin
// forever. Bash now reads the exact bytes from stdin; PowerShell gets them
// base64-encoded as UTF-16LE.

const heredoc = "cat > out.txt <<'EOF'\nline \"quoted\" $dollar \\backslash\n@media (max-width:1100px){ .x { width: 100%; } }\nEOF";

const psArgv = buildArgv("powershell", heredoc, paths);
assert.deepStrictEqual(psArgv.slice(0, 5), ["C:\\pwsh.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
assert.strictEqual(psArgv.length, 6, "the script is one encoded argument, not raw argv text");
assert.ok(!psArgv.some((arg) => arg.includes("cat > out.txt")), "the raw script never appears in PowerShell argv");
const decoded = Buffer.from(psArgv[5], "base64").toString("utf16le");
assert.ok(decoded.endsWith(heredoc), "EncodedCommand round-trips every byte of the script");
assert.ok(decoded.includes("\nline \"quoted\" $dollar \\backslash\n"), "newlines, quotes, $ and backslashes survive encoding");
assert.strictEqual(encodePowerShellCommand("x"), Buffer.from("$ProgressPreference = 'SilentlyContinue'; x", "utf16le").toString("base64"));

assert.deepStrictEqual(buildArgv("gitbash", heredoc, paths), ["C:\\Git\\bin\\bash.exe", "-ls"]);
assert.ok(!buildArgv("gitbash", heredoc, paths).includes(heredoc), "gitbash argv carries no script");
assert.deepStrictEqual(buildArgv("wsl", heredoc, paths, undefined), ["C:\\Windows\\System32\\wsl.exe", "-e", "bash", "-ls"]);
assert.deepStrictEqual(buildArgv("wsl", heredoc, paths, "Ubuntu"), ["C:\\Windows\\System32\\wsl.exe", "-d", "Ubuntu", "-e", "bash", "-ls"]);
assert.ok(!buildArgv("wsl", heredoc, paths).includes(heredoc), "wsl argv carries no script");
assert.throws(() => buildArgv("fish", "x", paths));

// The script is delivered on stdin as one batch; the seam writes it and closes
// the pipe in the same operation, so nothing is left open for cat/read.
assert.strictEqual(buildStdin("powershell", heredoc), undefined, "PowerShell's script is already in -EncodedCommand");
assert.strictEqual(buildStdin("gitbash", "ls"), "ls\n", "bash stdin gets the exact script plus a terminating newline");
assert.strictEqual(buildStdin("wsl", "ls\n"), "ls\n", "an already terminated script is not double-newlined");
assert.throws(() => buildStdin("fish", "x"));

const specPs = spawnSpec({ workdir: "D:/w", stdoutMaxBytes: 1024 }, psArgv, {}, undefined);
assert.strictEqual(specPs.stdio.stdin, "ignore", "PowerShell does not occupy stdin");
const specWsl = spawnSpec({ workdir: "D:/w", stdoutMaxBytes: 1024, stdin: buildStdin("wsl", heredoc) }, [], {}, undefined);
assert.deepStrictEqual(specWsl.stdio.stdin, { data: heredoc + "\n" }, "wsl writes the script on stdin");
const specGit = spawnSpec({ workdir: "D:/w", stdoutMaxBytes: 1024, stdin: buildStdin("gitbash", heredoc) }, [], {}, undefined);
assert.deepStrictEqual(specGit.stdio.stdin, { data: heredoc + "\n" }, "gitbash writes the script on stdin");
assert.deepStrictEqual(stdinDisposition({ stdin: "x" }), { data: "x" });
assert.strictEqual(stdinDisposition({}), "ignore");


const env = buildEnv("gitbash", { DSH_WEB_URL: "http://127.0.0.1:3080" });
assert.strictEqual(env.DSH_WEB_URL, "http://127.0.0.1:3080");
assert.strictEqual(env.NO_COLOR, "1");
const wslEnv = buildEnv("wsl", { DSH_WEB_URL: "http://x", DSH_TEST: "1" });
assert.ok(wslEnv.WSLENV.includes("DSH_WEB_URL"));
assert.ok(wslEnv.WSLENV.includes("DSH_TEST"));
assert.strictEqual(buildEnv("wsl", undefined).WSLENV, undefined);

// ---- PTY environment: regression guard for Wsl/Service/0x8007072c -----------
// node-pty REPLACES the child environment instead of layering it, so the DSH_*
// overlay has to be materialized over process.env. Before this guard the PTY
// received only the overlay plus four literals, and wsl.exe died under ConPTY
// with Wsl/Service/0x8007072c because SystemRoot never reached it.

process.env.DSH_PTY_ENV_PROBE = "from-process";
const ptyEnv = buildPtyEnv({ DSH_WEB_URL: "http://x" });
assert.strictEqual(ptyEnv.DSH_PTY_ENV_PROBE, "from-process", "the PTY environment inherits the process environment");
assert.strictEqual(ptyEnv.DSH_WEB_URL, "http://x", "the shell-env overlay still reaches the PTY");
assert.strictEqual(ptyEnv.NO_COLOR, "1");
assert.strictEqual(ptyEnv.TERM, "dumb");
assert.strictEqual(ptyEnv.PAGER, "cat");
assert.strictEqual(ptyEnv.GIT_PAGER, "cat");
assert.ok(Object.keys(ptyEnv).length > 10, "the PTY environment is a full environment, not just the overlay: " + Object.keys(ptyEnv).length + " keys");
if (process.platform === "win32") {
  assert.ok(ptyEnv.SystemRoot, "SystemRoot must reach the PTY - wsl.exe cannot start under ConPTY without it");
}
assert.strictEqual(buildPtyEnv({ DSH_PTY_ENV_PROBE: "from-overlay" }).DSH_PTY_ENV_PROBE, "from-overlay", "the overlay overrides a same-named process variable");
delete process.env.DSH_PTY_ENV_PROBE;

assert.strictEqual(renderResult({ stdout: { text: "hello", truncated: false }, stderr: { text: "", truncated: false }, exitCode: 0, signal: null, timedOut: false, timeoutMs: 1000 }), "hello");
assert.ok(renderResult({ stdout: { text: "out", truncated: false }, stderr: { text: "err", truncated: false }, exitCode: 3, signal: null, timedOut: false, timeoutMs: 1000 }).includes("[stderr]"));
assert.ok(renderResult({ stdout: { text: "out", truncated: false }, stderr: { text: "", truncated: false }, exitCode: 3, signal: null, timedOut: false, timeoutMs: 1000 }).includes("[exit code: 3]"));
assert.ok(renderResult({ stdout: { text: "", truncated: false }, stderr: { text: "", truncated: false }, exitCode: 0, signal: null, timedOut: true, timeoutMs: 5000 }).includes("[timed out after 5000ms]"));

const real = resolveAllPaths({}, process.env);
console.log("resolved paths:", JSON.stringify(real));
assert.ok(real.pwsh, "pwsh should resolve");
assert.ok(real.gitbash && real.gitbash.toLowerCase().includes("git"), "gitbash should resolve: " + real.gitbash);
assert.ok(real.wsl, "wsl should resolve");

const cgb = candidateGitBashPaths({ ...process.env, PATH: "C:\\Windows\\System32;C:\\Program Files\\Git\\bin" });
assert.ok(!cgb.some((p) => p.toLowerCase().includes("system32")), "system32 bash excluded");

validateArgs({ command: "ls", description: "list" });
assert.throws(() => validateArgs({ command: "  ", description: "x" }));
// shell is user-settings controlled: a stale shell arg must be tolerated
validateArgs({ command: "ls", description: "x", shell: "fish" });
assert.throws(() => validateArgs({ command: "ls", description: "x", timeoutMs: -5 }));

// ---- backend-aware tool description -----------------------------------------

// Every backend is covered by its own lead sentence.
assert.deepStrictEqual(Object.keys(SHELL_DESCRIPTIONS).sort(), ["gitbash", "powershell", "wsl"]);

// gitbash -> bash-flavored description; the active backend is named up front.
const gitDesc = toolDescription(true, "gitbash");
assert.ok(gitDesc.includes("bash -ls"), "gitbash lead mentions bash -ls: " + gitDesc);
assert.ok(gitDesc.includes("written to stdin"), "gitbash lead says the script arrives on stdin");
assert.ok(gitDesc.includes("POSIX syntax"), "gitbash lead mentions POSIX");
assert.ok(gitDesc.includes("The user's chosen default terminal (Settings -> General -> Default terminal) is gitbash"), "gitbash names the active backend");
assert.ok(gitDesc.includes("Git Bash"), "gitbash mentions Git Bash unconfined");
assert.ok(gitDesc.includes("run unconfined"), "gitbash description advertises unconfined execution");

// powershell -> PowerShell-flavored description.
const psDesc = toolDescription(true, "powershell");
assert.ok(psDesc.includes("pwsh -NoLogo -NoProfile -NonInteractive -EncodedCommand"), "powershell lead mentions the encoded command argv");
assert.ok(psDesc.includes("PowerShell syntax"), "powershell lead mentions PowerShell");
assert.ok(psDesc.includes("is powershell"), "powershell names the active backend");

// wsl -> Linux-bash-flavored description.
const wslDesc = toolDescription(true, "wsl");
assert.ok(wslDesc.includes("wsl [-d <distro>] -e bash -ls"), "wsl lead mentions wsl argv");
assert.ok(wslDesc.includes("written to stdin"), "wsl lead says the script arrives on stdin");
assert.ok(wslDesc.includes("/mnt/"), "wsl lead mentions /mnt/ paths");
assert.ok(wslDesc.includes("is wsl"), "wsl names the active backend");

// Shared tail: fresh shell, exit codes, background controls.
for (const desc of [gitDesc, psDesc, wslDesc]) {
  assert.ok(desc.includes("spawns a fresh shell"), "shared fresh-shell tail");
  assert.ok(desc.includes("[exit code: N]"), "shared exit-code tail");
  assert.ok(desc.includes("run_in_background: true"), "background advertised when enabled");
  assert.ok(desc.includes("under the DSH sandbox"), "sandbox honored in description");
  assert.ok(!desc.includes("outside the DSH sandbox"), "no stale outside-sandbox claim");
  // The shell tool is the one-shot path; it must point at the session tool for
  // state that has to survive and for interactive input. Without this the model
  // reads "no state persists between calls" as the intended way to do multi-step
  // work and never discovers the terminal session.
  assert.ok(desc.includes("use the terminal tool when state must survive"), "shell description routes stateful work to the terminal tool: " + desc);
}
assert.ok(!toolDescription(false, "gitbash").includes("run_in_background"), "background hidden when disabled");

// Unknown backend falls back to the default lead without throwing.
assert.ok(toolDescription(true, "fish").includes("is powershell"), "unknown backend falls back to default");

// ---- ssh session plumbing ---------------------------------------------------
//
// The ssh action is what turns "one ssh login, many commands" into the easy
// path. Its two hard parts are validated here: the destination is typed into a
// shell, so it must not be able to smuggle a second word or a flag; and the
// backend cannot simply follow the user's default terminal, because the ssh
// host aliases live in the WSL ~/.ssh/config while the Windows one is empty.

assert.strictEqual(validateSshHost("second_brain"), "second_brain");
assert.strictEqual(validateSshHost("  second_brain  "), "second_brain", "surrounding whitespace is trimmed");
assert.strictEqual(validateSshHost("root@178.217.99.183"), "root@178.217.99.183");
assert.strictEqual(validateSshHost("root@[2001:db8::1]"), "root@[2001:db8::1]", "IPv6 literals pass");
assert.strictEqual(validateSshHost("vps.example.com"), "vps.example.com");
for (const bad of ["", "   ", "host name", "host;rm -rf /", "host && whoami", "-oProxyCommand=evil", "host|cat", "$(whoami)", "host\nother", "`id`", "host>file", undefined, 42]) {
  assert.throws(() => validateSshHost(bad), /invalid sshHost/, "rejects a destination that could inject a second word or flag: " + JSON.stringify(bad));
}

// ssh needs the wsl backend: that is where the aliases and keys are.
assert.strictEqual(resolveSshShell("wsl", paths), "wsl");
assert.strictEqual(resolveSshShell(undefined, paths), "wsl", "wsl is the default ssh backend");
assert.strictEqual(resolveSshShell("", paths), "wsl");
assert.strictEqual(resolveSshShell("gitbash", paths), "gitbash", "an explicitly named backend is honored");
assert.strictEqual(resolveSshShell("powershell", paths), "powershell");
assert.strictEqual(resolveSshShell("wsl", { ...paths, wsl: undefined }), "powershell", "falls back when wsl.exe is absent");
// The ssh backend is independent of the everyday terminal: switching the default
// terminal to PowerShell must not silently break `ssh <alias>`.
assert.strictEqual(resolveSshShell("wsl", paths), "wsl", "ssh stays on wsl even when defaultShell is powershell");

// Remote sessions wait longer and poll faster than local ones; a wider poll than
// the quiet window would call still-arriving output "settled".
const local = settleOptions(false);
const remote = settleOptions(true);
assert.deepStrictEqual(local, { quietMs: LOCAL_QUIET_MS, timeoutMs: LOCAL_SETTLE_TIMEOUT_MS, awaitOutputMs: AWAIT_OUTPUT_MS });
assert.deepStrictEqual(remote, { quietMs: REMOTE_QUIET_MS, timeoutMs: REMOTE_SETTLE_TIMEOUT_MS, awaitOutputMs: REMOTE_AWAIT_OUTPUT_MS });
assert.ok(remote.quietMs > local.quietMs, "a remote command may go quiet for longer before its reply is complete");
assert.ok(remote.timeoutMs > local.timeoutMs, "an ssh handshake plus a first command needs a longer cap");
assert.ok(remote.awaitOutputMs > local.awaitOutputMs, "a remote command may take longer to say anything at all");
assert.ok(local.awaitOutputMs < LOCAL_SETTLE_TIMEOUT_MS, "the first-output wait is bounded well below the cap");
assert.ok(SETTLE_POLL_MS < local.quietMs && SETTLE_POLL_MS < remote.quietMs, "the poll interval must be narrower than every quiet window");
assert.strictEqual(REMOTE_TERM, "xterm-256color", "remote sessions ask for a real terminal type");

// The ssh action is offered to the model and carries its own parameter.
const toolSchema = terminalTool({}, {}, paths, () => "wsl", () => "wsl");
const toolParams = toolSchema.parameters.properties;
assert.ok(toolParams.action.enum.includes("ssh"), "the ssh action is advertised");
assert.ok(toolParams.sshHost !== undefined, "sshHost is a declared parameter");
assert.ok(toolSchema.description.includes("action \"ssh\""), "the description names the ssh action");
assert.ok(toolSchema.description.includes("waiting: true"), "the description explains the waiting flag");

console.log("ALL UNIT TESTS PASSED");