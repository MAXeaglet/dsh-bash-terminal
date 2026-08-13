// dsh-bash-terminal - one shell tool, three Windows terminals.
//
// Registers a model-facing shell tool. The terminal backend (powershell /
// gitbash / wsl) is chosen by the USER in the Web UI settings (default
// terminal); the model cannot pick it — the tool always obeys the user's
// choice:
//   - powershell: pwsh -NoLogo -NoProfile -NonInteractive -Command <cmd>
//   - gitbash:    Git for Windows bash -lc <cmd>  (POSIX; /d/... paths)
//   - wsl:        wsl [-d <distro>] -e bash -lc <cmd>  (Linux; /mnt/d/... paths)
//
// The tool spawns through the shared ctx.subprocess seam (process-tree
// termination, SIGTERM->grace->SIGKILL, spill files) and registers background
// handles with the generic ctx.jobs registry, mirroring the shipped
// dsh-tool-bash / dsh-tool-pwsh story call-for-call. It deliberately
// does NOT consume the ctx.shell capability seam: the platform's own
// sandboxed PowerShell executor keeps serving the pwsh tool, and this tool
// is an additional, user-selected terminal that runs outside the sandbox.

import { defineTool, TOOL_ABORTED } from "@deepseek-ai/dsh-tools";
import { ESCALATION_TARGETS, approveEscalation, escalationHintMarker, sandboxDenialMarker, validateEscalationArgs } from "@deepseek-ai/dsh-sandbox";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { parseExitStatus } from "@deepseek-ai/dsh-shell";
import { MAX_TIMER_DELAY_MS, clampTimeout, deadline, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { lstatSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";

/** Stable Cordis plugin name. */
export const name = "bash-terminal";
/** Services required before the tool can register. */
export const inject = ["tools", "systemPrompt", "shellEnv", "subprocess", "settings", "sandbox", "sandboxPolicy"];

/** The terminal backends this tool exposes, in catalog order. */
export const SHELLS = ["powershell", "gitbash", "wsl"];
/** The backend used when the caller does not name one. */
export const DEFAULT_SHELL = "powershell";
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
  defaultShell: z.string().default(DEFAULT_SHELL),
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

export function buildArgv(shell, command, paths, distro) {
  switch (shell) {
    case "powershell":
      return [paths.pwsh, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command];
    case "gitbash":
      return [paths.gitbash, "-lc", command];
    case "wsl": {
      const distroArg = distro !== undefined && distro.trim().length > 0 ? ["-d", distro.trim()] : [];
      return [paths.wsl, ...distroArg, "-e", "bash", "-lc", command];
    }
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

function spawnSpec(resolved, argv, env, signal) {
  const collect = (maxBytes) => ({ maxBytes, spill: { maxBytes: DEFAULT_MAX_SPILL_BYTES } });
  return {
    argv,
    cwd: resolved.workdir,
    stdio: {
      stdin: resolved.stdin !== undefined ? { data: resolved.stdin } : "ignore",
      stdout: collect(resolved.stdoutMaxBytes),
      stderr: collect(DEFAULT_MAX_OUTPUT_BYTES)
    },
    graceMs: DEFAULT_GRACE_MS,
    signal,
    env
  };
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

function toolDescription(backgroundEnabled) {
  const base = [
    "Execute a command in a Windows terminal. The terminal backend (powershell / gitbash / wsl) is chosen by the user in the Web UI settings (default terminal) — never guess or override it; use whatever the user configured. Prefer this tool over pwsh for terminal commands. Backends:",
    "- powershell: runs pwsh -NoLogo -NoProfile -NonInteractive -Command <command>. PowerShell syntax; native Windows paths (C:\\...); environment variables via $env:NAME.",
    "- gitbash: runs Git for Windows' bash -lc <command>. POSIX syntax; paths like /d/WorkSpace; PATH includes /usr/bin and /mingw64/bin so git, npm, ssh etc. work; environment variables via $NAME.",
    "- wsl: runs inside the default WSL Linux distribution via wsl -e bash -lc <command>; pass distro (e.g. Ubuntu) to pick another. Linux syntax; Windows files under /mnt/d/...; environment variables via $NAME.",
    "Each call spawns a fresh shell: no state (cwd, variables, aliases) persists between calls - pass workdir instead of using cd. Non-zero exits are reported as [exit code: N] markers; investigate failures before moving on. Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. Commands run outside the DSH sandbox with the same privileges as the dsh process itself."
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
 * A requested confined mode with no usable backend throws the fail-closed
 * SandboxUnavailableError, exactly like the shipped executors.
 */
function confineSpawn(ctx, argv, policy, shell) {
  if (policy.mode === "danger-full-access" || shell === "wsl") {
    return { argv, sandbox: shell === "wsl" ? { mode: policy.mode, enforcement: "wsl-isolation" } : undefined };
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
  const defaultShell = config.defaultShell ?? DEFAULT_SHELL;
  if (!SHELLS.includes(defaultShell)) throw new Error(`dsh-bash-terminal: invalid defaultShell ${JSON.stringify(defaultShell)}`);
  const settingsScope = ctx.settings.register(
    settingsNamespace(SETTINGS_NAMESPACE),
    z.object({ defaultShell: z.union(SHELLS.map((s) => z.const(s))).default(defaultShell) }),
    { base: { defaultShell } }
  );
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
    text: "Use the shell tool for terminal commands: it runs in the terminal the user chose in Settings -> General -> Default terminal (PowerShell, Git Bash, or WSL) and honors the DSH sandbox. Prefer it over the pwsh tool for everyday commands; keep the pwsh tool for cases that specifically need the sandboxed PowerShell surface."
  });

  const toolName = "shell";
  ctx.tools.register(defineTool({
    name: toolName,
    description: toolDescription(backgroundEnabled),
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
      const shell = settingsScope.get().defaultShell;
      const argv0 = buildArgv(shell, args.command, paths, args.distro);
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
        ...(args.stdin !== undefined ? { stdin: args.stdin } : {})
      };
      if (args.run_in_background === true) {
        const jobs = ctx.get("jobs");
        if (jobs === undefined) throw new Error("background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs");
        if (exec.signal.aborted) {
          const error = new HarnessError("tool call aborted", TOOL_ABORTED);
          error.name = "AbortError";
          throw error;
        }
        return {
          kind: "background",
          jobId: jobs.start({
            kind: `shell/${shell}`,
            label: args.command,
            ...(exec.agent ? { owner: exec.agent } : {}),
            run: () => {
              const proc = startBackground(ctx, argv, resolved, env, exec.signal);
              return {
                cancel: () => void proc.kill(),
                done: proc.done.then(() => processOutcome(proc)),
                readOutput: () => renderProcessRead(proc.readOutput())
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
  validateArgs,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES
};
//#endregion
