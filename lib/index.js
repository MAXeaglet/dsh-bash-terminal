// dsh-bash-terminal - one shell tool, three Windows terminals.
//
// Registers a model-facing shell tool. The terminal backend (powershell /
// gitbash / wsl) is chosen by the USER in the Web UI settings (default
// terminal); the model cannot pick it — the tool always obeys the user's
// choice:
//   - powershell: pwsh -NoLogo -NoProfile -NonInteractive -EncodedCommand <b64>
//   - gitbash:    Git for Windows bash -ls  (POSIX; /d/... paths)
//   - wsl:        wsl [-d <distro>] -e bash -ls  (Linux; /mnt/d/... paths)
//
// The command text NEVER travels through argv as raw text. Bash reads the
// script from stdin (`-s`, the batch `{ data }` stdin mode writes it and closes
// the pipe), and PowerShell receives it base64-encoded as UTF-16LE. Both routes
// are byte-exact for newlines, quotes, `$`, backslashes and heredocs; the old
// `-lc <cmd>` / `-Command <cmd>` argv route re-parsed the script across the
// Windows command line and every wsl.exe boundary (and hit the 32K Windows
// command-line limit for large commands, manifesting as a truncated script and
// a `cat` left reading an open stdin).
//
// The tool spawns through the shared ctx.subprocess seam (process-tree
// termination, SIGTERM->grace->SIGKILL, spill files) and registers background
// handles with the generic ctx.jobs registry, mirroring the shipped
// dsh-tool-bash / dsh-tool-pwsh story call-for-call. It deliberately
// does NOT consume the ctx.shell capability seam: the platform's own
// sandboxed PowerShell executor keeps serving the pwsh tool. This tool is
// an additional, user-selected terminal that still honors the DSH sandbox:
// confined modes wrap PowerShell's spawn argv through ctx.sandbox
// (fail-closed), while danger-full-access, Git Bash, and WSL run unconfined.
// Git Bash is unconfined because the DSH Windows ACL restricted-token runner
// cannot host Cygwin/MSYS2: bash aborts with "CreateFileMapping ... Win32
// error 5" during startup.

import { defineTool, TOOL_ABORTED } from "@deepseek-ai/dsh-tools";
import { createTerminalRegistry, terminalTool } from "./terminal.js";
import { ESCALATION_TARGETS, approveEscalation, escalationHintMarker, sandboxDenialMarker, validateEscalationArgs } from "@deepseek-ai/dsh-sandbox";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { parseExitStatus } from "@deepseek-ai/dsh-shell";
import { MAX_TIMER_DELAY_MS, clampTimeout, deadline, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { lstatSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";

/** Stable Cordis plugin name. */
export const name = "bash-terminal";
/** Services required before the tool can register. */
export const inject = ["tools", "systemPrompt", "shellEnv", "subprocess", "sandbox", "sandboxPolicy"];

/** The terminal backends this tool exposes, in catalog order. */
export const SHELLS = ["powershell", "gitbash", "wsl"];
/** The backend used when the caller does not name one. */
export const DEFAULT_SHELL = "powershell";
/** The backend that hosts ssh sessions: the aliases and keys live in WSL. */
export const DEFAULT_SSH_SHELL = "wsl";
/** Settings namespace backing the user-chosen default terminal. */
export const SETTINGS_NAMESPACE = "bash-terminal";
/** Default per-command timeout (ms). */
const DEFAULT_TIMEOUT_MS = 120000;
/** Upper bound a caller's timeoutMs is capped to. */
const MAX_TIMEOUT_MS = 600000;
/** SIGTERM->SIGKILL grace (ms), matching dsh-bash-local's default. */
const DEFAULT_GRACE_MS = 3000;
/** Per-stream in-memory cap before spilling (bytes). */
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
/** Per-stream spill file cap (bytes). */
const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024;
/** Timeout code stamped on the deadline's TimeoutReason. */
const TIMEOUT_CODE = "SHELL_TIMEOUT";

/** Model-friendly environment overrides (same set dsh-bash-local hardcodes). */
const ENV_OVERRIDES = {
  NO_COLOR: "1",
  TERM: "dumb",
  PAGER: "cat",
  GIT_PAGER: "cat"
};

/** Runtime configuration schema. */
export const Config = z.object({
  // `.volatile()` is what makes this field the plugin's settings section in dsh
  // 0.2.x: the harness exposes every volatile Config field for editing and
  // applies changes without remounting the plugin, which is what the
  // description refresh in `system-prompt/assemble` below relies on.
  defaultShell: z.union(SHELLS.map((s) => z.const(s))).default(DEFAULT_SHELL).volatile(),
  // The backend that hosts `terminal` sessions opened with action "ssh". It is
  // separate from defaultShell on purpose: ssh host aliases and keys live in the
  // WSL ~/.ssh/config, while %USERPROFILE%\.ssh\config is commonly empty, so
  // `ssh <alias>` works in WSL and fails in PowerShell. "wsl" keeps remote work
  // working when the user switches their everyday terminal to PowerShell.
  sshShell: z.union(SHELLS.map((s) => z.const(s))).default(DEFAULT_SSH_SHELL).volatile(),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  maxTimeoutMs: z.number().default(MAX_TIMEOUT_MS),
  pwshPath: z.string().default(""),
  gitBashPath: z.string().default(""),
  wslPath: z.string().default("")
});

// ---- executable resolution ------------------------------------------------

function candidateExists(candidate) {
  try {
    const stat = lstatSync(candidate);
    return stat.isFile() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function resolveFromCandidates(candidates) {
  for (const candidate of candidates) {
    if (candidateExists(candidate)) return candidate;
  }
  return undefined;
}

/** Well-known PowerShell install locations plus PATH entries, newest first. */
export function candidatePwshPaths(env = process.env) {
  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  const systemRoot = env.SystemRoot ?? "C:\\Windows";
  const candidates = [join(programFiles, "PowerShell", "7", "pwsh.exe")];
  for (const entry of (env.PATH ?? "").split(";")) {
    const trimmed = entry.trim().replace(/^"|"$/g, "");
    if (trimmed.length === 0) continue;
    candidates.push(join(trimmed, "pwsh.exe"));
  }
  candidates.push(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  return candidates;
}

/**
 * Git for Windows locations, then PATH bash.exe entries EXCLUDING the
 * System32 launcher (c:\\windows\\system32\\bash.exe is the WSL
 * forwarder, not a Git Bash shell).
 */
export function candidateGitBashPaths(env = process.env) {
  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  const systemRoot = (env.SystemRoot ?? "C:\\Windows").toLowerCase();
  const localAppData = env.LOCALAPPDATA ?? "";
  const candidates = [
    join(programFiles, "Git", "bin", "bash.exe"),
    join(programFiles, "Git", "usr", "bin", "bash.exe")
  ];
  if (localAppData.length > 0) candidates.push(join(localAppData, "Programs", "Git", "bin", "bash.exe"));
  for (const entry of (env.PATH ?? "").split(";")) {
    const trimmed = entry.trim().replace(/^"|"$/g, "");
    if (trimmed.length === 0) continue;
    if (trimmed.toLowerCase().includes(systemRoot)) continue;
    candidates.push(join(trimmed, "bash.exe"));
  }
  return candidates;
}

export function defaultWslPath(env = process.env) {
  const systemRoot = env.SystemRoot ?? "C:\\Windows";
  return join(systemRoot, "System32", "wsl.exe");
}

function resolveAllPaths(config = {}, env = process.env) {
  const pwsh = config.pwshPath && config.pwshPath.trim().length > 0
    ? config.pwshPath
    : resolveFromCandidates(candidatePwshPaths(env));
  const gitbash = config.gitBashPath && config.gitBashPath.trim().length > 0
    ? config.gitBashPath
    : resolveFromCandidates(candidateGitBashPaths(env));
  const wsl = config.wslPath && config.wslPath.trim().length > 0
    ? config.wslPath
    : defaultWslPath(env);
  return { pwsh, gitbash, wsl };
}

// ---- argv / env construction ------------------------------------------------

/**
 * Encode a PowerShell script for `-EncodedCommand` (base64 UTF-16LE). This is
 * the only way to hand PowerShell arbitrary multiline text without any Windows
 * command-line or wsl.exe quoting layer touching it.
 *
 * The progress preference prefix is not cosmetic: Windows PowerShell 5.1 writes
 * its "Preparing modules for first use" progress record to stderr as a CLIXML
 * blob when the script arrives through `-EncodedCommand` (and only then). The
 * prefix keeps that bookkeeping out of the model-facing stderr, matching the
 * old `-Command` output, and is a no-op for scripts that never show progress.
 */
export function encodePowerShellCommand(command) {
  return Buffer.from(`$ProgressPreference = 'SilentlyContinue'; ${command}`, "utf16le").toString("base64");
}

/**
 * Build the argv for one backend. The script text is deliberately absent from
 * argv for every shell: bash reads it from stdin (see {@link buildStdin}) and
 * PowerShell receives it base64-encoded. Passing the raw script as one argv
 * element is what lost heredoc terminators and quotes across Windows→WSL and
 * blew the Windows command-line limit on large commands.
 * @param shell - powershell | gitbash | wsl.
 * @param command - the script/command text; encoded for PowerShell, unused by argv for bash (delivered on stdin).
 * @param paths - resolved executable paths.
 * @param distro - WSL distribution, when the caller named one.
 */
export function buildArgv(shell, command, paths, distro) {
  switch (shell) {
    case "powershell":
      return [paths.pwsh, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellCommand(command)];
    case "gitbash":
      return [paths.gitbash, "-ls"];
    case "wsl": {
      const distroArg = distro !== undefined && distro.trim().length > 0 ? ["-d", distro.trim()] : [];
      return [paths.wsl, ...distroArg, "-e", "bash", "-ls"];
    }
    default:
      throw new Error(`invalid shell: ${JSON.stringify(shell)} (expected one of ${SHELLS.join(", ")})`);
  }
}

/**
 * The script handed to the child on stdin, or undefined when the backend takes
 * it through argv (PowerShell). A trailing newline is guaranteed so a script
 * that ends with a heredoc terminator is still terminated by the shell rather
 * than by end-of-file.
 * @param shell - powershell | gitbash | wsl.
 * @param command - the script/command text to deliver byte-for-byte.
 */
export function buildStdin(shell, command) {
  switch (shell) {
    case "powershell":
      return undefined;
    case "gitbash":
    case "wsl":
      return command.endsWith("\n") ? command : `${command}\n`;
    default:
      throw new Error(`invalid shell: ${JSON.stringify(shell)} (expected one of ${SHELLS.join(", ")})`);
  }
}

/**
 * Merge the DSH_* environment over the process environment. For WSL, only
 * variables explicitly listed in WSLENV cross the boundary, so every DSH_*
 * key is appended there (WSLENV is a : separated VAR[/flag] list).
 */
export function buildEnv(shell, dshEnv) {
  const env = { ...ENV_OVERRIDES, ...dshEnv };
  if (shell === "wsl") {
    const keys = Object.keys(dshEnv ?? {});
    if (keys.length > 0) {
      const existing = typeof env.WSLENV === "string" && env.WSLENV.length > 0 ? env.WSLENV : undefined;
      env.WSLENV = [existing, keys.join(":")].filter(Boolean).join(":");
    }
  }
  return env;
}

// ---- spawn plumbing over ctx.subprocess ---------------------------------------

/**
 * stdin disposition for one spawn. Batch `{ data }` is not a suggestion: the
 * subprocess seam writes the bytes and closes the pipe in the same operation
 * (`stdin.end(data)`), so a child that ends up reading stdin — `cat` after a
 * heredoc terminator was lost, `read`, a pager — gets EOF instead of an open
 * handle inherited from a background job. Only backends whose script travels
 * in argv (PowerShell) use `ignore`, which leaves fd 0 on the null device.
 * @returns the seam's stdin mode for this spawn.
 */
export function stdinDisposition(resolved) {
  return resolved.stdin !== undefined ? { data: resolved.stdin } : "ignore";
}

function spawnSpec(resolved, argv, env, signal) {
  const collect = (maxBytes) => ({ maxBytes, spill: { maxBytes: DEFAULT_MAX_SPILL_BYTES } });
  return {
    argv,
    cwd: resolved.workdir,
    stdio: {
      stdin: stdinDisposition(resolved),
      stdout: collect(resolved.stdoutMaxBytes),
      stderr: collect(DEFAULT_MAX_OUTPUT_BYTES)
    },
    graceMs: DEFAULT_GRACE_MS,
    signal,
    env
  };
}

/**
 * The spawned process's collected streams as `ctx.jobs` pull sources (the DSH
 * 0.2.x contract: one `read(fromByte)` per pump poll). They bind lazily because
 * the process is spawned inside the job's starter, after admission - a read
 * before the spawn yields nothing and leaves the pump cursor untouched.
 * @param getProc - the started process, once the starter has spawned it.
 * @returns one source per stream, stdout first.
 */
function processSources(getProc) {
  const source = (channel) => ({
    channel,
    read: (fromByte) => {
      const proc = getProc();
      return proc === undefined
        ? { text: "", nextOffset: fromByte, lossy: false }
        : proc.collected[channel].readFrom(fromByte);
    }
  });
  return [source("stdout"), source("stderr")];
}

function collectedOutput(handle) {
  const { stdout, stderr } = handle.collected;
  if (stdout === undefined || stderr === undefined) {
    throw new Error("dsh-bash-terminal: subprocess implementation dropped a requested collect stream");
  }
  return { stdout, stderr };
}

function finalOutput(reader) {
  const read = reader.readFrom(0);
  return {
    text: read.text,
    truncated: read.lossy,
    ...(read.spillPath !== undefined ? { spillPath: read.spillPath } : {})
  };
}

async function runForeground(ctx, argv, resolved, env, signal, timeoutMs) {
  const d = deadline(signal, timeoutMs, TIMEOUT_CODE);
  try {
    const handle = ctx.subprocess.spawn(spawnSpec(resolved, argv, env, d.signal));
    const outcome = await handle.done;
    const collected = collectedOutput(handle);
    const timedOut = timeoutOf(d.signal, TIMEOUT_CODE) !== undefined;
    const aborted = d.signal.aborted && !timedOut;
    return {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut,
      aborted,
      timeoutMs,
      stdout: finalOutput(collected.stdout),
      stderr: finalOutput(collected.stderr)
    };
  } finally {
    d[Symbol.dispose]();
  }
}

function startBackground(ctx, argv, resolved, env, signal) {
  const running = ctx.subprocess.spawn(spawnSpec(resolved, argv, env, signal));
  const collected = collectedOutput(running);
  let stdoutOffset = 0;
  let stderrOffset = 0;
  let spawnFailureNote;
  const consumeSpawnFailure = () => {
    const note = spawnFailureNote ?? "";
    spawnFailureNote = undefined;
    return note;
  };
  const proc = {
    status: "running",
    exitCode: null,
    signal: null,
    // The collector readers, exposed so the job registry can pull this
    // process's output itself (spec.output) instead of only through the
    // producer's legacy readOutput hook.
    collected,
    done: running.done.then((outcome) => {
      if (proc.status === "running") {
        proc.status = signal?.aborted === true || outcome.signal !== null ? "killed" : "completed";
      }
      proc.exitCode = outcome.exitCode;
      proc.signal = outcome.signal;
    }, (error) => {
      proc.status = "killed";
      spawnFailureNote = `spawn failed: ${String(error)}`;
    }),
    readOutput: () => {
      const out = collected.stdout.readFrom(stdoutOffset);
      const err = collected.stderr.readFrom(stderrOffset);
      stdoutOffset = out.nextOffset;
      stderrOffset = err.nextOffset;
      const errText = err.text.length > 0 ? err.text : consumeSpawnFailure();
      const separator = out.text.length > 0 && !out.text.endsWith("\n") ? "\n" : "";
      return {
        delta: out.text + (errText.length > 0 ? `${separator}[stderr]\n${errText}` : ""),
        lossy: out.lossy || err.lossy,
        ...(out.spillPath !== undefined ? { stdoutSpillPath: out.spillPath } : {}),
        ...(err.spillPath !== undefined ? { stderrSpillPath: err.spillPath } : {})
      };
    },
    kill: () => {
      if (proc.status !== "running") return false;
      proc.status = "killed";
      running.terminate();
      return true;
    }
  };
  return proc;
}

function processOutcome(proc) {
  if (proc.status === "killed") {
    return { status: "killed", detail: proc.signal !== null ? `signal: ${proc.signal}` : "killed before exit" };
  }
  return { status: "completed", detail: `exit code: ${proc.exitCode ?? 0}` };
}

// ---- model-facing rendering ---------------------------------------------------

function streamText(output) {
  if (!output.truncated) return output.text;
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? "(unavailable)"}]`;
}

function renderResult(result) {
  const out = streamText(result.stdout);
  const err = streamText(result.stderr);
  let body = out;
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith("\n")) body += "\n";
    body += `[stderr]\n${err}`;
  }
  if (body.length === 0) body = "(no output)";
  const markers = [];
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`);
  if (result.signal !== null) markers.push(`[killed by signal: ${result.signal}]`);
  else if (result.exitCode !== 0) markers.push(`[exit code: ${result.exitCode}]`);
  if (markers.length === 0) return body;
  if (!body.endsWith("\n")) body += "\n";
  return body + markers.join("\n");
}

function renderProcessRead(read) {
  const notices = [];
  if (read.lossy) {
    const paths = [read.stdoutSpillPath, read.stderrSpillPath].filter((p) => p !== undefined);
    notices.push(`[some output was dropped from memory; full output: ${paths.length > 0 ? paths.join(", ") : "(unavailable)"}]`);
  }
  if (notices.length === 0) return read.delta;
  return `${read.delta}${read.delta.length > 0 && !read.delta.endsWith("\n") ? "\n" : ""}${notices.join("\n")}`;
}

// ---- tool description / validation --------------------------------------------

/** Model-facing lead sentence for each backend. The user's default terminal is
 * stated up front so the model never has to guess which syntax applies. */
const SHELL_DESCRIPTIONS = {
  powershell: "Execute a PowerShell command (pwsh -NoLogo -NoProfile -NonInteractive -EncodedCommand <base64 UTF-16LE>, so multiline text and quotes reach it byte-for-byte) and return its stdout/stderr. PowerShell syntax; native Windows paths (C:\\...); environment variables via $env:NAME.",
  gitbash: "Execute a bash command (Git for Windows bash -ls, with the script written to stdin so heredocs and quotes are exact) and return its stdout/stderr. POSIX syntax; paths like /d/WorkSpace; PATH includes /usr/bin and /mingw64/bin so git, npm, ssh etc. work; environment variables via $NAME.",
  wsl: "Execute a Linux bash command (wsl [-d <distro>] -e bash -ls, with the script written to stdin so heredocs and quotes are exact) and return its stdout/stderr. Linux syntax; Windows files under /mnt/d/...; environment variables via $NAME."
};

/**
 * Render the model-facing tool description for one backend. The backend is
 * whatever the user chose in Settings -> General -> Default terminal; the
 * description names it explicitly so the model writes the right syntax.
 * @param backgroundEnabled - advertise `run_in_background` controls.
 * @param shell - active backend; unknown values fall back to the default.
 */
function toolDescription(backgroundEnabled, shell = DEFAULT_SHELL) {
  const active = SHELL_DESCRIPTIONS[shell] !== undefined ? shell : DEFAULT_SHELL;
  const lead = SHELL_DESCRIPTIONS[active];
  const base = [
    `The user's chosen default terminal (Settings -> General -> Default terminal) is ${active}; commands run there.`,
    lead,
    "Each call spawns a fresh shell: no state (cwd, variables, aliases) persists between calls - pass workdir instead of using cd, and use the terminal tool when state must survive or the command needs interactive input. Non-zero exits are reported as [exit code: N] markers; investigate failures before moving on. Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. Commands run under the DSH sandbox: confined modes (read-only / workspace-write) are enforced through ctx.sandbox and deny fail-closed for PowerShell; danger-full-access, Git Bash, and WSL run unconfined."
  ].join(" ");
  if (!backgroundEnabled) return base;
  return base + " Set run_in_background: true for long-running commands: the call returns a job id immediately; read its output with job_output and stop it with job_kill. No timeout applies to background runs.";
}

function validateArgs(args) {
  if (typeof args.command !== "string" || args.command.trim().length === 0) {
    throw new Error("invalid command: expected a non-empty string");
  }
  if (typeof args.description !== "string" || args.description.trim().length === 0) {
    throw new Error("invalid description: expected a non-empty string");
  }
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`);
  }
  validateEscalationArgs(args.sandbox_permissions, args.justification);
}

/**
 * Official sandbox seam (mirrors dsh-tool-bash / dsh-pwsh-sandbox): resolve the
 * per-call policy from ctx.sandboxPolicy, and — unless the call runs
 * danger-full-access — confine the spawn argv through ctx.sandbox. WSL is a
 * self-contained Linux VM and is not confined (its isolation IS the sandbox).
 * Git Bash is also not confined: DSH's Windows ACL restricted-token runner
 * cannot start Cygwin/MSYS2 (CreateFileMapping Win32 error 5), so attempting
 * to wrap it would abort every Git Bash command. A requested confined mode
 * with no usable backend throws the fail-closed SandboxUnavailableError,
 * exactly like the shipped executors.
 */
function confineSpawn(ctx, argv, policy, shell) {
  if (policy.mode === "danger-full-access" || shell === "wsl" || shell === "gitbash") {
    const sandbox = shell === "wsl"
      ? { mode: policy.mode, enforcement: "wsl-isolation" }
      : shell === "gitbash"
        ? { mode: policy.mode, enforcement: "gitbash-unconfined" }
        : undefined;
    return { argv, sandbox };
  }
  const confined = ctx.sandbox.confine(argv, policy);
  return {
    argv: confined.argv,
    sandbox: { mode: policy.mode, enforcement: confined.enforcement, denialSignatures: confined.denialSignatures }
  };
}

function resolveWorkdir(modelWorkdir, exec) {
  const headerCwd = exec.agent?.session.header.cwd;
  if (modelWorkdir === undefined) return headerCwd;
  if (headerCwd !== undefined && !isAbsolute(modelWorkdir)) return resolve(headerCwd, modelWorkdir);
  return modelWorkdir;
}

function canonicalResult(result) {
  const output = (stream) => ({
    text: stream.text,
    truncated: stream.truncated,
    ...(stream.spillPath !== undefined ? { spillPath: stream.spillPath } : {})
  });
  return {
    kind: "foreground",
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    timeoutMs: result.timeoutMs,
    stdout: output(result.stdout),
    stderr: output(result.stderr),
    ...(result.sandbox !== undefined ? { sandbox: result.sandbox } : {})
  };
}

const BACKGROUND_OUTPUT_PROPERTIES = {
  kind: { type: "string", required: true, const: "background" },
  jobId: { type: "string", required: true }
};

// ---- plugin -------------------------------------------------------------------

export function apply(ctx, config = {}) {
  if (process.platform !== "win32") {
    ctx.logger?.info?.("dsh-bash-terminal: only meaningful on win32; skipping tool registration");
    return;
  }
  const backgroundEnabled = true;
  const paths = resolveAllPaths(config);
  // dsh 0.2.x removed `SettingsProvider.register()`. The plugin's own config is
  // now its settings section: the row id is the namespace and the exported
  // `Config` is the schema. A volatile field arrives as a live ref with `.get()`,
  // so unwrap it on every read instead of caching a scope.
  const readDefaultShell = () => {
    const raw = config.defaultShell;
    return raw !== null && typeof raw === "object" && typeof raw.get === "function" ? raw.get() : raw;
  };
  // The `Config` enum rejects bad input at the settings boundary; here a stale
  // hand-edited value falls back, because prompt assembly must never fail on it.
  const defaultShell = SHELLS.includes(readDefaultShell()) ? readDefaultShell() : DEFAULT_SHELL;
  const currentDefaultShell = () => {
    const value = readDefaultShell();
    return SHELLS.includes(value) ? value : defaultShell;
  };
  /** Live ssh backend for `terminal`'s ssh action (see the sshShell config note). */
  const readSshShell = () => {
    const raw = config.sshShell;
    const value = raw !== null && typeof raw === "object" && typeof raw.get === "function" ? raw.get() : raw;
    return SHELLS.includes(value) ? value : DEFAULT_SSH_SHELL;
  };
  /** Official sandbox-escalation surface (mirrors tool-bash): advertise the
   * escalation modes whenever the deployment confines. */
  const escalationModes = ESCALATION_TARGETS;
  const approveShellEscalation = (mode, justification, exec, standingPolicy) => {
    return approveEscalation({
      requestedMode: mode,
      justification,
      effectiveMode: standingPolicy.mode,
      subject: "command"
    }, {
      approver: ctx.get("approval"),
      agent: exec.agent,
      callId: exec.callId,
      toolName: "shell",
      signal: exec.signal
    });
  };

  ctx.systemPrompt.section({
    name: "tool:bash-terminal",
    order: 105,
    text: [
      "Use the shell tool for one-shot terminal commands: it runs in the terminal the user chose in Settings -> General -> Default terminal (PowerShell, Git Bash, or WSL) and honors the DSH sandbox. Prefer it over the pwsh tool for everyday commands; keep the pwsh tool for cases that specifically need the sandboxed PowerShell surface.",
      "Reach for the terminal tool instead - action \"open\" for a local session, action \"ssh\" with sshHost for a server - as soon as the work needs more than one command: shell state that must persist (cwd, exported variables, an activated venv), interactive input (passwords, 2FA, confirmations, pagers, REPLs), or several steps on a remote host. A single ssh login reused across commands keeps its cwd and variables, while `ssh <host> <command>` per call pays for a new connection every time and loses everything between calls.",
      "Once a session is open, keep working inside it until the work is done, then close it. Never drive an interactive or multi-step job by repeating one-shot shell calls."
    ].join(" ")
  });

  const toolName = "shell";
  const terminalRegistry = createTerminalRegistry(ctx);
  ctx.tools.register(terminalTool(ctx, terminalRegistry, paths, currentDefaultShell, readSshShell));

  // The model-facing description must track the user's chosen default
  // terminal: a static description listing every backend leaves the model
  // guessing which syntax applies. Re-render it on every prompt assembly —
  // settings are hot-reloaded, so a change shows up on the next request
  // without a restart.
  ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
    const assembled = await next();
    const description = toolDescription(backgroundEnabled, currentDefaultShell());
    const tools = Array.isArray(assembled.tools)
      ? assembled.tools.map((tool) => (tool.name === toolName ? { ...tool, description } : tool))
      : assembled.tools;
    return { ...assembled, tools };
  });

  ctx.tools.register(defineTool({
    name: toolName,
    description: toolDescription(backgroundEnabled, currentDefaultShell()),
    parameters: {
      command: {
        type: "string",
        required: true,
        description: "The command to execute in the selected terminal."
      },
      description: {
        type: "string",
        required: true,
        description: "Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: \"ls\" -> \"List files in current directory\"; \"git status\" -> \"Show working tree status\"; \"npm install\" -> \"Install package dependencies\"."
      },
      distro: {
        type: "string",
        description: "WSL distribution to use (only when the configured default terminal is wsl). Defaults to the system default distribution."
      },
      sandbox_permissions: {
        type: "string",
        enum: escalationModes,
        description: "The wider sandbox mode this command needs. Only valid as a one-shot retry of a command the sandbox just denied; requires justification and user approval."
      },
      justification: {
        type: "string",
        description: "Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access."
      },
      workdir: {
        type: "string",
        description: "Working directory for this command. Defaults to the session workspace; a relative path is resolved against it."
      },
      timeoutMs: {
        type: "number",
        description: "Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry."
      },
      run_in_background: {
        type: "boolean",
        description: "Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies."
      }
    },
    output: {
      schema: {
        oneOf: [
          { type: "object", additionalProperties: false, properties: BACKGROUND_OUTPUT_PROPERTIES },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { type: "string", required: true, const: "foreground" },
              exitCode: { required: true, oneOf: [{ type: "integer" }, { type: "null" }] },
              signal: { required: true, oneOf: [{ type: "string" }, { type: "null" }] },
              timedOut: { type: "boolean", required: true },
              aborted: { type: "boolean", required: true },
              timeoutMs: { type: "number", required: true },
              sandbox: {
                type: "object",
                additionalProperties: false,
                properties: {
                  mode: { type: "string", required: true },
                  enforcement: { type: "string", required: true },
                  denied: { type: "boolean" }
                }
              },
              stdout: {
                type: "object",
                additionalProperties: false,
                required: true,
                properties: {
                  text: { type: "string", required: true },
                  truncated: { type: "boolean", required: true },
                  spillPath: { type: "string" }
                }
              },
              stderr: {
                type: "object",
                additionalProperties: false,
                required: true,
                properties: {
                  text: { type: "string", required: true },
                  truncated: { type: "boolean", required: true },
                  spillPath: { type: "string" }
                }
              }
            }
          }
        ]
      },
      render: (_args, value) => {
        if (value.kind === "background") return [{ type: "text", text: `started background job ${value.jobId}` }];
        let text = renderResult(value);
        if (value.sandbox?.denied === true) {
          if (!text.endsWith("\n")) text += "\n";
          text += sandboxDenialMarker(value.sandbox.mode) + "\n" + escalationHintMarker("command");
        }
        return [{ type: "text", text }];
      }
    },
    async execute(args, exec) {
      validateArgs(args);
      const shell = currentDefaultShell();
      const argv0 = buildArgv(shell, args.command, paths, args.distro);
      // Bash backends receive the script on stdin; PowerShell's copy is already
      // inside -EncodedCommand, so it must not also occupy the stdin stream.
      const scriptStdin = buildStdin(shell, args.command);
      if (argv0[0] === undefined) {
        throw new Error(`dsh-bash-terminal: ${shell} backend unavailable - executable not found. Install it or set the corresponding *Path config.`);
      }
      const workdir = resolveWorkdir(args.workdir, exec);
      const timeoutMs = clampTimeout(args.timeoutMs, config.timeoutMs ?? DEFAULT_TIMEOUT_MS, config.maxTimeoutMs ?? MAX_TIMEOUT_MS, "shell timeoutMs");
      const dshEnv = ctx.shellEnv.collect(exec);
      const env = buildEnv(shell, dshEnv);
      let policy = ctx.sandboxPolicy.resolve(exec.agent ? { session: exec.agent.session } : {});
      if (args.sandbox_permissions !== undefined && args.justification !== undefined) {
        const approvedMode = await approveShellEscalation(args.sandbox_permissions, args.justification, exec, policy);
        policy = { ...policy, mode: approvedMode };
      }
      const { argv, sandbox } = confineSpawn(ctx, argv0, policy, shell);
      const resolved = {
        command: args.command,
        workdir: workdir ?? process.cwd(),
        timeoutMs,
        stdoutMaxBytes: DEFAULT_MAX_OUTPUT_BYTES,
        ...(scriptStdin !== undefined ? { stdin: scriptStdin } : {})
      };
      if (args.run_in_background === true) {
        const jobs = ctx.get("jobs");
        if (jobs === undefined) throw new Error("background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs");
        if (exec.signal.aborted) {
          const error = new HarnessError("tool call aborted", TOOL_ABORTED);
          error.name = "AbortError";
          throw error;
        }
        let bgProc;
        return {
          kind: "background",
          jobId: jobs.start({
            kind: `shell/${shell}`,
            label: args.command,
            // DSH 0.2.x resolves the owner through the agent registry, so it is
            // the SESSION ID; handing over the Agent object fails the
            // registration with `session "[object Object]" has no live agent`.
            ...(exec.agent?.id !== undefined ? { owner: exec.agent.id } : {}),
            output: processSources(() => bgProc),
            run: () => {
              bgProc = startBackground(ctx, argv, resolved, env, exec.signal);
              return {
                cancel: () => void bgProc.kill(),
                done: bgProc.done.then(() => processOutcome(bgProc)),
                // Legacy producer hook: 0.2.x renders the job ring fed by
                // spec.output, but an older host may still read this one.
                readOutput: () => renderProcessRead(bgProc.readOutput())
              };
            }
          })
        };
      }
      const result = await runForeground(ctx, argv, resolved, env, exec.signal, timeoutMs);
      if (result.aborted) {
        const error = new HarnessError("tool call aborted", TOOL_ABORTED);
        error.name = "AbortError";
        throw error;
      }
      const denied = sandbox?.denialSignatures !== undefined
        ? sandbox.denialSignatures.some((sig) => result.stderr.text.toLowerCase().includes(sig.toLowerCase()))
        : false;
      return canonicalResult({
        ...result,
        ...(sandbox !== undefined ? { sandbox: { mode: sandbox.mode, enforcement: sandbox.enforcement, denied } } : {})
      });
    },
    presentCall: (args) => {
      if (args.run_in_background === true) {
        return {
          card: "generic",
          title: args.command,
          kind: "execute",
          rawInput: args.command,
          content: [{ type: "text", text: args.description }]
        };
      }
      return {
        card: "terminal",
        title: args.command,
        description: args.description,
        ...(args.workdir !== undefined ? { cwd: args.workdir } : {})
      };
    },
    presentResult: (args, result) => {
      const block = result.content.length === 1 ? result.content[0] : undefined;
      if (block === undefined || block.type !== "text") return undefined;
      const raw = block.text;
      if ((typeof args === "object" && args !== null && args.run_in_background === true) || result.isError) {
        return { card: "generic", content: [{ type: "text", text: "```console\n" + raw.replace(/\n+$/, "") + "\n```" }] };
      }
      const { body, ...exit } = parseExitStatus(raw);
      return { card: "terminal", output: body, ...exit };
    }
  }));
}

//#region internals for tests
export const internals = {
  candidateExists,
  resolveAllPaths,
  resolveWorkdir,
  renderResult,
  processOutcome,
  startBackground,
  runForeground,
  spawnSpec,
  buildEnv,
  buildArgv,
  buildStdin,
  encodePowerShellCommand,
  stdinDisposition,
  validateArgs,
  toolDescription,
  SHELL_DESCRIPTIONS,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES
};
//#endregion
