// dsh-bash-terminal: interactive terminal tool over the official PTY seam.
// ctx.subprocess.spawnTerminal (node-pty under the hood) allocates a real
// terminal; this module owns model-facing sessions: open / send / read /
// signal (Ctrl+C etc.) / close. The backend follows the user's default
// terminal setting, exactly like the shell tool.

import { defineTool, TOOL_ABORTED } from "@deepseek-ai/dsh-tools";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

const MAX_BUFFER_BYTES = 1024 * 1024;
const READ_SETTLE_MS = 800;
const DEFAULT_ROWS = 30;
const DEFAULT_COLS = 110;
const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 8;
const TERMINAL_SIGNALS = ["SIGINT", "SIGTERM", "SIGKILL", "SIGTSTP", "SIGHUP"];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Interactive-shell argv (no -c: the terminal itself is the session). */
export function terminalArgv(shell, paths, distro) {
  switch (shell) {
    case "powershell": return [paths.pwsh, "-NoLogo", "-NoProfile"];
    case "gitbash": return [paths.gitbash, "-i"];
    case "wsl": {
      const distroArg = distro !== undefined && distro.trim().length > 0 ? ["-d", distro.trim()] : [];
      return [paths.wsl, ...distroArg, "-e", "bash", "-i"];
    }
    default: throw new Error("invalid shell: " + JSON.stringify(shell));
  }
}

/** In-memory output ring for one session (drop-oldest at the cap). */
function createBuffer() {
  let text = "";
  return {
    append(chunk) {
      text += chunk;
      if (text.length > MAX_BUFFER_BYTES) text = text.slice(text.length - MAX_BUFFER_BYTES);
    },
    readFrom(offset) {
      const delta = offset >= text.length ? "" : text.slice(offset);
      return { delta, nextOffset: text.length };
    },
    snapshot: () => text
  };
}

/**
 * Terminal-session registry owned by the plugin fiber: opens PTYs through
 * the official seam, forwards output into a capped buffer, and tears every
 * session down on plugin disposal.
 */
export function createTerminalRegistry(ctx) {
  const sessions = new Map();
  ctx.effect(() => () => {
    for (const session of sessions.values()) {
      void session.handle.terminate().catch(() => {});
    }
    sessions.clear();
  }, "bash-terminal: terminal sessions teardown");

  async function open({ argv, shell, cwd, env, rows, cols, distro, initial, idleMs }) {
    if (sessions.size >= MAX_SESSIONS) {
      throw new Error("terminal: too many open sessions (" + MAX_SESSIONS + "); close one before opening another");
    }
    const handle = await ctx.subprocess.spawnTerminal({
      argv,
      cwd,
      env,
      rows,
      cols,
      graceMs: 3000
    });
    const buffer = createBuffer();
    handle.output.on("data", (chunk) => buffer.append(typeof chunk === "string" ? chunk : chunk.toString("utf8")));
    const session = {
      id: randomUUID(),
      handle,
      buffer,
      shell,
      distro,
      closed: false,
      idleMs: idleMs ?? DEFAULT_IDLE_MS
    };
    // Idle guard: any read/send/signal touches the timer; expiry terminates the
    // session so an abandoned PTY never leaks a process tree.
    const touch = () => {
      if (session.closed) return;
      clearTimeout(session.idleTimer);
      session.idleTimer = setTimeout(() => {
        if (session.closed) return;
        session.closed = true;
        sessions.delete(session.id);
        void session.handle.terminate().catch(() => {});
      }, session.idleMs);
    };
    session.touch = touch;
    touch();
    sessions.set(session.id, session);
    if (initial !== undefined && initial.length > 0) {
      await handle.write(initial);
      await delay(READ_SETTLE_MS);
    }
    return session;
  }

  function get(id) {
    const session = sessions.get(id);
    if (session === undefined) throw new Error("terminal session not found: " + JSON.stringify(id));
    if (session.closed) throw new Error("terminal session is closed: " + JSON.stringify(id));
    session.touch();
    return session;
  }

  async function send(id, input) {
    const session = get(id);
    await session.handle.write(input);
    await delay(READ_SETTLE_MS);
    return read(id);
  }

  function read(id) {
    const session = get(id);
    const { delta, nextOffset } = session.buffer.readFrom(0);
    return { delta, nextOffset };
  }

  async function signal(id, sig) {
    const session = get(id);
    if (!TERMINAL_SIGNALS.includes(sig)) throw new Error("invalid terminal signal: " + JSON.stringify(sig));
    await session.handle.signalForeground(sig);
    await delay(READ_SETTLE_MS);
    return read(id);
  }

  async function close(id) {
    const session = get(id);
    session.closed = true;
    clearTimeout(session.idleTimer);
    sessions.delete(id);
    await session.handle.terminate();
    return true;
  }

  function list() {
    return [...sessions.values()].map((session) => ({
      sessionId: session.id,
      shell: session.shell,
      pid: session.handle.pid,
      closed: session.closed
    }));
  }

  return { open, get, send, read, signal, close, list };
}

function validateArgs(args) {
  if (typeof args.action !== "string" || ["open", "send", "read", "signal", "close", "list"].indexOf(args.action) === -1) {
    throw new Error("invalid action: expected open, send, read, signal, close, or list");
  }
  if ((args.action === "send" || args.action === "read" || args.action === "signal" || args.action === "close") && (typeof args.sessionId !== "string" || args.sessionId.length === 0)) {
    throw new Error("invalid sessionId: required for " + args.action);
  }
  if (args.action === "send" && (typeof args.input !== "string" || args.input.length === 0)) {
    throw new Error("invalid input: expected a non-empty string for send");
  }
  if (args.action === "signal" && (typeof args.signal !== "string" || TERMINAL_SIGNALS.indexOf(args.signal) === -1)) {
    throw new Error("invalid signal: expected one of " + TERMINAL_SIGNALS.join(", "));
  }
}

export function terminalTool(ctx, registry, paths, defaultShell) {
  return defineTool({
    name: "terminal",
    description: "Interactive terminal session over the user's default terminal (Settings -> General -> Default terminal: powershell / gitbash / wsl). A real PTY hosts a persistent shell: open a session, send input and read output across turns, deliver signals (Ctrl+C = SIGINT) to the foreground process, and close when done. Backend and env follow the shell tool exactly; the session survives between calls until closed and is managed as a background job (job_kill / job_output work on it); idle sessions close automatically. Use this for interactive programs (REPLs, ssh, databases, TUI tools) or when you need shell state (cwd, variables, aliases) to persist across calls.",
    parameters: {
      action: {
        type: "string",
        enum: ["open", "send", "read", "signal", "close", "list"],
        required: true,
        description: "open: create a session and return its id. send: write input and read new output. read: read new output without writing. signal: send a signal to the foreground process (SIGINT for Ctrl+C). close: terminate the session. list: list live sessions."
      },
      sessionId: {
        type: "string",
        description: "Session id returned by open; required for send/read/signal/close."
      },
      command: {
        type: "string",
        description: "With action open: optional command to run immediately in the fresh shell (Enter appended). Default starts an interactive shell."
      },
      distro: {
        type: "string",
        description: "WSL distribution (only when the configured default terminal is wsl)."
      },
      input: {
        type: "string",
        description: "With action send: the input to write (no implicit newline; append \\n or \\r for Enter)."
      },
      signal: {
        type: "string",
        enum: TERMINAL_SIGNALS,
        description: "With action signal: signal to the foreground process group (SIGINT = Ctrl+C, SIGKILL, SIGTERM, SIGTSTP, SIGHUP)."
      },
      workdir: {
        type: "string",
        description: "Working directory for the session (open only). Defaults to the session workspace."
      },
      idleMs: {
        type: "number",
        description: "Idle timeout in ms (open only): the session closes automatically after this long without send/read/signal. Default 600000 (10 min)."
      }
    },
    output: {
      schema: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { type: "string", required: true, const: "open" },
              sessionId: { type: "string", required: true },
              jobId: { type: "string" },
              pid: { type: "integer", required: true },
              shell: { type: "string", required: true },
              output: { type: "string" }
            }
          },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { type: "string", required: true, const: "session" },
              output: { type: "string", required: true }
            }
          },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { type: "string", required: true, const: "closed" },
              sessionId: { type: "string", required: true }
            }
          },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { type: "string", required: true, const: "list" },
              sessions: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    sessionId: { type: "string", required: true },
                    shell: { type: "string", required: true },
                    pid: { type: "integer", required: true },
                    closed: { type: "boolean" }
                  }
                }
              }
            }
          }
        ]
      },
      render: (_args, value) => [{
        type: "text",
        text: value.kind === "open"
          ? "terminal session " + value.sessionId + " (pid " + value.pid + ", " + value.shell + ")" + (value.output ? "\n" + value.output : "")
          : value.kind === "closed"
            ? "terminal session " + value.sessionId + " closed"
            : value.kind === "list"
              ? (value.sessions.length === 0 ? "no open terminal sessions" : value.sessions.map((s) => s.sessionId + " (" + s.shell + ", pid " + s.pid + ")").join("\n"))
              : value.output
      }]
    },
    async execute(args, exec) {
      validateArgs(args);
      if (exec.signal.aborted) {
        const error = new HarnessError("tool call aborted", TOOL_ABORTED);
        error.name = "AbortError";
        throw error;
      }
      const headerCwd = exec.agent?.session.header.cwd;
      switch (args.action) {
        case "open": {
          const shell = defaultShell();
          const argv = terminalArgv(shell, paths, args.distro);
          if (argv[0] === undefined) throw new Error("terminal: " + shell + " backend unavailable - executable not found");
          const cwd = args.workdir !== undefined ? (headerCwd !== undefined && !isAbsolute(args.workdir) ? resolve(headerCwd, args.workdir) : args.workdir) : (headerCwd ?? process.cwd());
          const dshEnv = ctx.shellEnv.collect(exec);
          const env = { NO_COLOR: "1", TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat", ...dshEnv };
          if (shell === "wsl" && dshEnv !== undefined) {
            const keys = Object.keys(dshEnv);
            if (keys.length > 0) env.WSLENV = [env.WSLENV, keys.join(":")].filter(Boolean).join(":");
          }
          const session = await registry.open({ argv, shell, cwd, env, rows: DEFAULT_ROWS, cols: DEFAULT_COLS, distro: args.distro, initial: args.command !== undefined ? args.command + "\r" : undefined, idleMs: args.idleMs });
          const jobs = ctx.get("jobs");
          const jobId = jobs === undefined ? undefined : jobs.start({
            kind: "terminal/session",
            label: "terminal " + session.id.slice(0, 8) + " (" + shell + ")",
            ...(exec.agent ? { owner: exec.agent } : {}),
            run: () => ({
              cancel: () => void session.handle.terminate().catch(() => {}),
              done: session.handle.done,
              readOutput: () => registry.read(session.id).delta
            })
          });
          return { kind: "open", sessionId: session.id, ...(jobId !== undefined ? { jobId } : {}), pid: session.handle.pid, shell, output: session.buffer.snapshot() };
        }
        case "send": {
          const { delta } = await registry.send(args.sessionId, args.input);
          return { kind: "session", output: delta };
        }
        case "read": {
          const { delta } = registry.read(args.sessionId);
          return { kind: "session", output: delta };
        }
        case "signal": {
          const { delta } = await registry.signal(args.sessionId, args.signal);
          return { kind: "session", output: delta };
        }
        case "close": {
          await registry.close(args.sessionId);
          return { kind: "closed", sessionId: args.sessionId };
        }
        case "list": {
          return { kind: "list", sessions: registry.list() };
        }
        default: throw new Error("unreachable terminal action");
      }
    },
    presentCall: (args) => ({
      card: "terminal",
      title: "terminal " + args.action + (args.sessionId !== undefined ? " " + args.sessionId : ""),
      ...(args.input !== undefined ? { description: args.input } : {})
    })
  });
}

function pathResolve(base, rel) {
  const { resolve } = require("node:path");
  return resolve(base, rel);
}