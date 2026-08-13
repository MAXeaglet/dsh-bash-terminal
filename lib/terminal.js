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

  async function open({ argv, shell, cwd, env, rows, cols, distro, initial }) {
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
      closed: false
    };
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
    sessions.delete(id);
    await session.handle.terminate();
    return true;
  }

  return { open, get, send, read, signal, close };
}

function validateArgs(args) {
  if (typeof args.action !== "string" || ["open", "send", "read", "signal", "close"].indexOf(args.action) === -1) {
    throw new Error("invalid action: expected open, send, read, signal, or close");
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
    description: "Interactive terminal session over the user's default terminal (Settings -> General -> Default terminal: powershell / gitbash / wsl). A real PTY hosts a persistent shell: open a session, send input and read output across turns, deliver signals (Ctrl+C = SIGINT) to the foreground process, and close when done. Backend and env follow the shell tool exactly; the session survives between calls until closed. Use this for interactive programs (REPLs, ssh, databases, TUI tools) or when you need shell state (cwd, variables, aliases) to persist across calls.",
    parameters: {
      action: {
        type: "string",
        enum: ["open", "send", "read", "signal", "close"],
        required: true,
        description: "open: create a session and return its id. send: write input and read new output. read: read new output without writing. signal: send a signal to the foreground process (SIGINT for Ctrl+C). close: terminate the session."
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
          }
        ]
      },
      render: (_args, value) => [{
        type: "text",
        text: value.kind === "open"
          ? "terminal session " + value.sessionId + " (pid " + value.pid + ", " + value.shell + ")" + (value.output ? "\n" + value.output : "")
          : value.kind === "closed"
            ? "terminal session " + value.sessionId + " closed"
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
          const env = { NO_COLOR: "1", TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat", ...ctx.shellEnv.collect(exec) };
          const session = await registry.open({ argv, shell, cwd, env, rows: DEFAULT_ROWS, cols: DEFAULT_COLS, distro: args.distro, initial: args.command !== undefined ? args.command + "\r" : undefined });
          return { kind: "open", sessionId: session.id, pid: session.handle.pid, shell, output: session.buffer.snapshot() };
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