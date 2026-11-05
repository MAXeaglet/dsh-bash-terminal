// End-to-end: the registered `shell` tool, the real spawn plumbing, and REAL
// processes. This is the regression test for the heredoc hang:
//
//   cat >> file <<'css'
//   @media (max-width:1100px){ ... }
//   css
//
// The old argv route (`bash -lc <command>`) pushed the whole heredoc through the
// Windows command line and the wsl.exe boundary. Newlines and quotes were
// re-parsed, and large commands were truncated at the ~32K Windows command-line
// limit, which left bash with a half-read script and `cat` waiting on an open
// stdin forever (the reported 5+ minute background job). Bash now reads the
// script from stdin, closed right after the write (byte-exact at any size), and
// PowerShell gets it base64-encoded (byte-exact within its argv budget).
//
// The test deliberately drives more than a helper: it applies the plugin to a
// real Cordis context, uses the host's real LocalSubprocessRuntime from the DSH
// install when available, and asserts files on disk.
import assert from "node:assert";
import { createHash } from "node:crypto";
import { apply } from "../lib/index.js";

const repoRoot = process.cwd();
const stamp = `${process.pid}-${Date.now()}`;
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

if (process.platform !== "win32") {
  console.log(`E2E SKIPPED: dsh-bash-terminal registers only on win32 (running on ${process.platform})`);
  process.exit(0);
}

let Context;
let LocalSubprocessRuntime;
try {
  ({ Context } = await import("@deepseek-ai/cordis"));
  ({ default: LocalSubprocessRuntime } = await import("@deepseek-ai/dsh-subprocess-local"));
} catch (error) {
  // A bare checkout without the DSH dependency tree cannot spawn the way the
  // host does. The unit/apply suites still cover argv and stdin construction;
  // say so loudly instead of silently pretending the e2e ran.
  console.log(`E2E SKIPPED: the real DSH subprocess provider is not installed here (${String(error)})`);
  process.exit(0);
}

const host = new Context();
host.plugin(LocalSubprocessRuntime);
await new Promise((resolve) => setTimeout(resolve, 50));
assert.strictEqual(typeof host.subprocess?.spawn, "function", "the real subprocess service is mounted");

// ---- plugin ctx (same contract as test/apply.mjs, real spawner) -------------
let registeredTool = null;
let currentShell = "powershell";
const jobsStarted = [];
const ctx = {
  logger: { info: () => {} },
  systemPrompt: { section: () => {} },
  tools: { register: (tool) => { registeredTool = tool; } },
  on: () => {},
  shellEnv: { collect: () => ({ DSH_WEB_URL: "http://127.0.0.1:3080" }) },
  sandboxPolicy: { resolve: () => ({ mode: "danger-full-access" }) },
  sandbox: { confine: (argv) => ({ argv, enforcement: "full" }) },
  subprocess: host.subprocess,
  get: (key) => {
    if (key === "approval") return { request: async () => "allowed-once" };
    if (key === "jobs") {
      return {
        start: (spec) => {
          jobsStarted.push(spec);
          return `job-e2e-${jobsStarted.length}`;
        }
      };
    }
    return undefined;
  },
  effect: () => () => {}
};
apply(ctx, { defaultShell: { get: () => currentShell } });
assert.ok(registeredTool, "the shell tool is registered");
assert.strictEqual(registeredTool.name, "shell");

const exec = {
  signal: new AbortController().signal,
  agent: { id: "session-e2e", session: { header: { cwd: repoRoot } } },
  callId: "e2e"
};

const withDeadline = (promise, ms, label) => {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms - stdin was probably left open`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
};

async function foreground(shell, command, options = {}) {
  currentShell = shell;
  const result = await withDeadline(
    registeredTool.execute({ command, description: `e2e ${shell}`, ...options }, exec),
    30000,
    `${shell} foreground command`
  );
  assert.strictEqual(result.kind, "foreground");
  return result;
}

async function background(shell, command) {
  currentShell = shell;
  jobsStarted.length = 0;
  const reply = await withDeadline(
    registeredTool.execute({ command, description: `e2e ${shell} background`, run_in_background: true }, exec),
    30000,
    `${shell} background start`
  );
  assert.strictEqual(reply.kind, "background");
  assert.strictEqual(reply.jobId, "job-e2e-1", "the job registry handed back its id");
  assert.strictEqual(jobsStarted.length, 1);
  const job = jobsStarted[0];
  assert.strictEqual(job.kind, `shell/${shell}`);
  assert.deepStrictEqual(job.output.map((source) => source.channel), ["stdout", "stderr"]);

  const hooks = job.run();
  const outcome = await withDeadline(hooks.done, 30000, `${shell} background job`);
  assert.strictEqual(outcome.status, "completed", `background job completed: ${JSON.stringify(outcome)}`);
  // The pull sources are exactly what job_output reads.
  const stdout = job.output[0].read(0);
  const stderr = job.output[1].read(0);
  // The legacy producer hook must stay consistent with the sources.
  const legacy = hooks.readOutput();
  return { outcome, stdout: stdout.text, stderr: stderr.text, legacy };
}

const expectForegroundOk = (result, label) => {
  assert.strictEqual(result.timedOut, false, `${label} did not time out`);
  assert.strictEqual(result.aborted, false, `${label} was not aborted`);
  assert.strictEqual(result.exitCode, 0, `${label} exited 0 (stderr: ${JSON.stringify(result.stderr.text)})`);
};

// The heredoc body is the reported shape: quotes, `$`, backslashes, braces and
// a CSS media query, with the delimiter quoted so nothing expands.
const heredocBody = [
  'double: "x"',
  "single: 'y'",
  'dollar: $HOME stays literal',
  "backslash: \\ and \\n stay literal",
  "backtick: `id` stays literal",
  "@media (max-width:1100px){ .panel { width: 100%; } }",
  ""
].join("\n");
assert.ok(heredocBody.length > 80, "the heredoc body is not trivial");

// ---- 1. WSL: foreground heredoc, byte-exact --------------------------------
{
  const file = `/tmp/dsh-e2e-wsl-${stamp}.txt`;
  const command = `cat > ${file} <<'EOF'\n${heredocBody}EOF\nwc -c < ${file}\ncat ${file}`;
  const result = await foreground("wsl", command);
  expectForegroundOk(result, "wsl heredoc");
  assert.strictEqual(result.stderr.text, "", "no bash warning about a lost heredoc terminator");
  assert.strictEqual(result.stdout.text, `${Buffer.byteLength(heredocBody)}\n${heredocBody}`, "wsl wrote and read the file byte-for-byte");

  // A second, independent command proves the file persisted with those bytes.
  const reread = await foreground("wsl", `cat ${file} && rm -f ${file}`);
  expectForegroundOk(reread, "wsl reread");
  assert.strictEqual(reread.stdout.text, heredocBody, "the file on disk matches the heredoc exactly");
}

// ---- 2. WSL: background heredoc completes and reports through job output ---
{
  const file = `/tmp/dsh-e2e-wsl-bg-${stamp}.txt`;
  const command = `cat > ${file} <<'EOF'\n${heredocBody}EOF\necho "WROTE $(wc -c < ${file} | tr -d ' ')"\ncat ${file}`;
  const job = await background("wsl", command);
  assert.strictEqual(job.outcome.detail, "exit code: 0");
  assert.strictEqual(job.stderr, "", "the background job produced no stderr");
  assert.ok(job.stdout.includes(`WROTE ${Buffer.byteLength(heredocBody)}`), "the background command completed its heredoc: " + JSON.stringify(job.stdout.slice(0, 200)));
  assert.ok(job.stdout.endsWith(heredocBody), "the job's output source carries the exact file body");
  assert.ok(job.legacy.includes(`WROTE ${Buffer.byteLength(heredocBody)}`), "the legacy readOutput hook carries the same result");

  const check = await foreground("wsl", `cat ${file} && rm -f ${file}`);
  expectForegroundOk(check, "wsl background file readback");
  assert.strictEqual(check.stdout.text, heredocBody, "the background job left exactly the heredoc bytes on disk");
}

// ---- 3. A command that reads stdin must see EOF, not a hang ----------------
//
// This is the guard for the reported failure mode: with the script on stdin the
// seam writes it and closes the pipe, so a bare `cat` (the exact shape that used
// to wait forever when its heredoc redirect had been mangled away) exits at
// once. The 30s deadline in foreground() turns a regression into a failure.
for (const shell of ["wsl", "gitbash"]) {
  const result = await foreground(shell, "cat");
  expectForegroundOk(result, `${shell} bare cat`);
  assert.strictEqual(result.stdout.text, "", `${shell} bare cat read EOF instead of waiting for input`);
}
// A background job is the shape that hung for 5+ minutes: it must close stdin
// too, not keep a pipe open for the lifetime of the job. `background()` has a
// 30s deadline, so a leak fails rather than hangs the suite.
{
  const job = await background("wsl", "cat");
  assert.strictEqual(job.outcome.detail, "exit code: 0", "a background cat exits on EOF");
  assert.strictEqual(job.stdout, "", "the background stdin reader saw EOF, not an open pipe");
}

// ---- 4. Git Bash: foreground heredoc, byte-exact ---------------------------
{
  const file = `/tmp/dsh-e2e-git-${stamp}.txt`;
  const command = `cat > ${file} <<'EOF'\n${heredocBody}EOF\nwc -c < ${file}\ncat ${file} && rm -f ${file}`;
  const result = await foreground("gitbash", command);
  expectForegroundOk(result, "gitbash heredoc");
  assert.strictEqual(result.stderr.text, "", "no MSYS/bash warning about the heredoc");
  assert.strictEqual(result.stdout.text, `${Buffer.byteLength(heredocBody)}\n${heredocBody}`, "gitbash wrote and read the file byte-for-byte");
}

// ---- 5. PowerShell: multiline script with quotes/$/\ ----------------------
{
  const script = [
    "$lines = @(",
    "  'double: \"x\"'",
    "  \"single: 'y'\"",
    "  'dollar: $HOME stays literal'",
    "  'backslash: \\ and \\n stay literal'",
    "  'braces: @media (max-width:1100px){ .panel { width: 100%; } }'",
    ")",
    "$lines | ForEach-Object { Write-Output $_ }"
  ].join("\n");
  const expected = [
    'double: "x"',
    "single: 'y'",
    "dollar: $HOME stays literal",
    "backslash: \\ and \\n stay literal",
    "braces: @media (max-width:1100px){ .panel { width: 100%; } }",
    ""
  ].join("\n");
  const result = await foreground("powershell", script);
  expectForegroundOk(result, "powershell heredoc-shaped script");
  assert.strictEqual(result.stderr.text, "", "no CLIXML/progress noise on stderr: " + JSON.stringify(result.stderr.text.slice(0, 200)));
  assert.strictEqual(result.stdout.text.replace(/\r\n/g, "\n"), expected, "PowerShell preserved every line, quote and $ exactly");
}

// ---- 6. PowerShell: a multi-line block and function survive --------------
//
// `-Command -` would read this line-by-line and silently drop the block; the
// encoded route hands the parser the whole script at once.
{
  const script = [
    "function Get-Value { param($x) \"fn:$x\" }",
    "$v = 'quoted \"inner\" $literal \\back'",
    "if ($true) {",
    "  Write-Output \"value=$v\"",
    "  Write-Output (Get-Value 'arg')",
    "}"
  ].join("\r\n");
  const result = await foreground("powershell", script);
  expectForegroundOk(result, "powershell block + function");
  assert.strictEqual(result.stdout.text.replace(/\r\n/g, "\n"), 'value=quoted "inner" $literal \\back\nfn:arg\n', "the block and function executed as one script");
}

// ---- 6b. PowerShell exit codes survive the encoded route ------------------
//
// The encoded invocation must keep -Command's exit-code semantics: an explicit
// `exit N` wins, a failing last statement exits 1 (same as before the fix), and
// the error text still reaches stderr (PowerShell 5.1 wraps cmdlet errors in
// CLIXML there, but the message is intact).
{
  const explicit = await foreground("powershell", "Write-Output 'before'; exit 7");
  assert.strictEqual(explicit.exitCode, 7, "an explicit exit code is preserved");
  const failing = await foreground("powershell", "Write-Error 'boom'");
  assert.strictEqual(failing.exitCode, 1, "a failing last statement exits 1, as with -Command");
  assert.ok(failing.stderr.text.includes("boom"), "the PowerShell error text reached stderr");
}

// ---- 7. Large heredoc: the old argv route hit the 32K Windows limit -------
//
// A ~40 KB command could never fit on the Windows command line; the old route
// died with ENAMETOOLONG or truncated the script. On stdin the size is bounded
// by the pipe, not by CreateProcess, so this must simply work and hash-match.
{
  const bigBody = Array.from({ length: 800 }, (_, index) => `.rule-${index} { content: "${"x".repeat(60)}-${index}"; }`).join("\n") + "\n";
  assert.ok(bigBody.length > 40 * 1024, "the payload really is beyond the Windows command-line limit: " + bigBody.length);
  const file = `/tmp/dsh-e2e-big-${stamp}.txt`;
  const command = `cat > ${file} <<'EOF'\n${bigBody}EOF\nsha256sum ${file} | cut -d' ' -f1\nwc -c < ${file}\nrm -f ${file}`;
  const result = await foreground("wsl", command, { timeoutMs: 60000 });
  expectForegroundOk(result, "wsl large heredoc");
  const [hash, bytes] = result.stdout.text.trimEnd().split("\n");
  assert.strictEqual(bytes, String(Buffer.byteLength(bigBody)), "the large payload landed completely");
  assert.strictEqual(hash, sha256(bigBody), "the large payload's bytes are exact (sha256)");
}

console.log("E2E TESTS PASSED (real spawns: wsl + gitbash heredocs, background, PowerShell, 80KB stdin script)");
process.exit(0);
