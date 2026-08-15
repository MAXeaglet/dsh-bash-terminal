
import { buildArgv, buildEnv, candidateGitBashPaths, candidatePwshPaths, internals } from "../lib/index.js";
const { renderResult, resolveAllPaths, validateArgs, toolDescription, SHELL_DESCRIPTIONS } = internals;
import assert from "node:assert";

const paths = { pwsh: "C:\\pwsh.exe", gitbash: "C:\\Git\\bin\\bash.exe", wsl: "C:\\Windows\\System32\\wsl.exe" };
assert.deepStrictEqual(buildArgv("powershell", "echo hi", paths), ["C:\\pwsh.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "echo hi"]);
assert.deepStrictEqual(buildArgv("gitbash", "ls", paths), ["C:\\Git\\bin\\bash.exe", "-lc", "ls"]);
assert.deepStrictEqual(buildArgv("wsl", "pwd", paths, undefined), ["C:\\Windows\\System32\\wsl.exe", "-e", "bash", "-lc", "pwd"]);
assert.deepStrictEqual(buildArgv("wsl", "pwd", paths, "Ubuntu"), ["C:\\Windows\\System32\\wsl.exe", "-d", "Ubuntu", "-e", "bash", "-lc", "pwd"]);
assert.throws(() => buildArgv("fish", "x", paths));

const env = buildEnv("gitbash", { DSH_WEB_URL: "http://127.0.0.1:3080" });
assert.strictEqual(env.DSH_WEB_URL, "http://127.0.0.1:3080");
assert.strictEqual(env.NO_COLOR, "1");
const wslEnv = buildEnv("wsl", { DSH_WEB_URL: "http://x", DSH_TEST: "1" });
assert.ok(wslEnv.WSLENV.includes("DSH_WEB_URL"));
assert.ok(wslEnv.WSLENV.includes("DSH_TEST"));
assert.strictEqual(buildEnv("wsl", undefined).WSLENV, undefined);

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
assert.ok(gitDesc.includes("bash -lc"), "gitbash lead mentions bash -lc: " + gitDesc);
assert.ok(gitDesc.includes("POSIX syntax"), "gitbash lead mentions POSIX");
assert.ok(gitDesc.includes("The user's chosen default terminal (Settings -> General -> Default terminal) is gitbash"), "gitbash names the active backend");

// powershell -> PowerShell-flavored description.
const psDesc = toolDescription(true, "powershell");
assert.ok(psDesc.includes("pwsh -NoLogo -NoProfile -NonInteractive -Command"), "powershell lead mentions pwsh argv");
assert.ok(psDesc.includes("PowerShell syntax"), "powershell lead mentions PowerShell");
assert.ok(psDesc.includes("is powershell"), "powershell names the active backend");

// wsl -> Linux-bash-flavored description.
const wslDesc = toolDescription(true, "wsl");
assert.ok(wslDesc.includes("wsl [-d <distro>] -e bash -lc"), "wsl lead mentions wsl argv");
assert.ok(wslDesc.includes("/mnt/"), "wsl lead mentions /mnt/ paths");
assert.ok(wslDesc.includes("is wsl"), "wsl names the active backend");

// Shared tail: fresh shell, exit codes, background controls.
for (const desc of [gitDesc, psDesc, wslDesc]) {
  assert.ok(desc.includes("spawns a fresh shell"), "shared fresh-shell tail");
  assert.ok(desc.includes("[exit code: N]"), "shared exit-code tail");
  assert.ok(desc.includes("run_in_background: true"), "background advertised when enabled");
}
assert.ok(!toolDescription(false, "gitbash").includes("run_in_background"), "background hidden when disabled");

// Unknown backend falls back to the default lead without throwing.
assert.ok(toolDescription(true, "fish").includes("is powershell"), "unknown backend falls back to default");

console.log("ALL UNIT TESTS PASSED");
