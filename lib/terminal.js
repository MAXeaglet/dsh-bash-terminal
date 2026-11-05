// dsh-bash-terminal: interactive terminal tool over the official PTY seam.
// ctx.subprocess.spawnTerminal (node-pty under the hood) allocates a real
// terminal; this module owns model-facing sessions: open / send / read /
// signal (Ctrl+C etc.) / close. The backend follows the user's default
// terminal setting, exactly like the shell tool.
//
// Delivery model: every session keeps an append-only output ring addressed by
// ABSOLUTE character offsets - they never shift when the ring drops its oldest
// text - and every reader owns a cursor into it. A reply carries only the text
// that appeared since that reader's cursor, with the trailing unterminated line
// held back and reported as `pending`, so a long session never re-delivers what
// the model already has in context. The cursor advances only past what the
// reply actually carried, so the per-reply byte cap and the held-back tail can
// never lose output: the next read picks it up and `more` says it is waiting.
// `from` re-reads any retained position (0 = the whole retained log), `raw`
// returns the untouched byte stream instead of terminal-rendered text.
//
// Windows note: the official seam's process inspector is POSIX-only
// (createProcessInspector throws on win32), so on Windows the PTY is
// allocated directly through node-pty. Session readiness here is
// output-quiet based (waitSettled), which needs no process inspection.

import { defineTool, TOOL_ABORTED } from "@deepseek-ai/dsh-tools";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { PassThrough } from "node:stream";

/** Per-session retention cap for the raw output ring, UTF-8 bytes. */
const MAX_BUFFER_BYTES = 1024 * 1024;
/** Largest slice one reply hands to the model, UTF-8 bytes. */
const MAX_REPLY_BYTES = 32 * 1024;
/** Output with no newline at all is still delivered once this much accumulated, UTF-8 bytes. */
const FLUSH_BYTES = 8 * 1024;
/** Orientation window for a reader that never read this session before, characters. */
const ORIENT_CHARS = 4096;
/** Longest unterminated tail echoed back as `pending`, characters. */
const MAX_PENDING_CHARS = 400;
const DEFAULT_ROWS = 30;
const DEFAULT_COLS = 110;
/** Idle window for a local session (exported for tests). */
export const DEFAULT_IDLE_MS = 10 * 60 * 1000;
/** A remote (ssh) session stays open longer: the model may think between commands. */
export const REMOTE_IDLE_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 8;
const TERMINAL_SIGNALS = ["SIGINT", "SIGTERM", "SIGKILL", "SIGTSTP", "SIGHUP"];

// ---- settle tuning ---------------------------------------------------------
//
// `waitSettled` decides when a reply is complete, and the hard case is a REMOTE
// shell: `ssh host` prints nothing for seconds and then bursts a login banner,
// while a remote command can also go quiet for seconds mid-run. Using the local
// tuning there returned an empty reply while the banner was still in flight, so
// the model read "ssh printed nothing" and fell back to one-shot `ssh <cmd>`
// calls - the exact behaviour this tool exists to prevent. Remote sessions
// therefore poll faster and demand a longer silence before a reply is called
// complete.
//
// `POLL_MS` is deliberately below every quiet window: a wider poll interval
// samples `lastAppendAt` too coarsely and reports "quiet" for output that is
// still arriving.
/** How often the settle loop samples the ring. */
export const SETTLE_POLL_MS = 50;
/** Silence that marks a local command complete. */
export const LOCAL_QUIET_MS = 300;
/** Silence that marks a remote command complete. */
export const REMOTE_QUIET_MS = 1200;
/** Cap on one local wait. */
export const LOCAL_SETTLE_TIMEOUT_MS = 8000;
/** Cap on one remote wait: an ssh handshake plus a slow first command. */
export const REMOTE_SETTLE_TIMEOUT_MS = 20000;
/** How long to wait for the first output after a write before reporting `waiting`. */
export const AWAIT_OUTPUT_MS = 3500;
/** A remote command may take longer than a local one to say anything at all. */
export const REMOTE_AWAIT_OUTPUT_MS = 8000;
/** PTY TERM for remote sessions: a real terminal type, so remote colors and line editing work. */
export const REMOTE_TERM = "xterm-256color";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Number of leading characters of `text` that fit into `maxBytes` UTF-8 bytes,
 * never splitting a surrogate pair. Byte-accurate caps are the point: the old
 * `text.length` accounting let a 1 MiB cap hold up to 4 MiB of Cyrillic or CJK.
 * @param text - the text to measure.
 * @param maxBytes - the byte budget.
 * @returns the number of UTF-16 code units that fit, usable directly as a `String#slice` bound.
 */
export function fitChars(text, maxBytes) {
  if (maxBytes <= 0) return 0;
  let chars = 0;
  let bytes = 0;
  while (chars < text.length) {
    const step = Math.min(2048, text.length - chars);
    let stop = chars + step;
    if (stop < text.length && isLowSurrogate(text.charCodeAt(stop))) stop += 1;
    const blockBytes = Buffer.byteLength(text.slice(chars, stop));
    if (bytes + blockBytes <= maxBytes) {
      bytes += blockBytes;
      chars = stop;
      continue;
    }
    // The budget ends inside this block: measure character by character.
    while (chars < stop) {
      const code = text.codePointAt(chars);
      const width = Buffer.byteLength(String.fromCodePoint(code));
      if (bytes + width > maxBytes) return chars;
      bytes += width;
      chars += code > 0xffff ? 2 : 1;
    }
  }
  return chars;
}

/**
 * Wait until the terminal output goes quiet (no new bytes for quietMs) or the
 * cap elapses. Reads after interactive input then return the complete reply
 * instead of a fixed-delay slice.
 *
 * The wait is anchored to the OUTPUT POSITION AT ENTRY, and that anchor is the
 * whole point. A session that was already idle when the input was written is
 * "quiet" by definition, so a naive silence test returned instantly with the
 * PREVIOUS command's output and nothing from the command just sent - which on a
 * remote session reads to the model as "the command did nothing", and is what
 * pushed it back to one-shot `ssh host <command>` calls. So a reply is only
 * complete once output has appeared after the write AND then gone quiet.
 *
 * If nothing appears within `awaitOutputMs`, the wait gives up and reports
 * `waiting`, so the model reads again instead of assuming an empty result.
 *
 * @param buffer - the session ring.
 * @param options.quietMs - silence that counts as complete.
 * @param options.timeoutMs - cap on the wait.
 * @param options.awaitOutputMs - how long to wait for the first new output.
 * @returns whether the wait ended on silence, and whether output was still expected or flowing.
 */
export async function waitSettled(buffer, options = {}) {
  const quietMs = options.quietMs ?? LOCAL_QUIET_MS;
  const timeoutMs = options.timeoutMs ?? LOCAL_SETTLE_TIMEOUT_MS;
  const awaitOutputMs = options.awaitOutputMs ?? AWAIT_OUTPUT_MS;
  const start = Date.now();
  // The position at entry: anything at or below it belongs to earlier commands.
  const startPos = buffer.end();
  let last = buffer.lastAppendAt();
  for (;;) {
    await delay(SETTLE_POLL_MS);
    // The cap is checked FIRST, and before the silence window is restarted: a
    // producer that never pauses would otherwise keep resetting `last` and the
    // wait would never end at all.
    if (Date.now() - start >= timeoutMs) {
      const quietFor = Date.now() - last;
      return { settled: false, waiting: quietFor < quietMs };
    }
    const now = buffer.lastAppendAt();
    if (now > last) {
      // Output landed during this poll: restart the silence window.
      last = now;
      continue;
    }
    const produced = buffer.end() > startPos;
    if (produced && Date.now() - last >= quietMs) return { settled: true, waiting: false };
    if (!produced && Date.now() - start >= awaitOutputMs) {
      // Nothing came back in time. The command may be slow rather than silent,
      // so this is reported as still running instead of as an empty result.
      return { settled: false, waiting: true };
    }
  }
}

/** Settle tuning for a session: remote sessions need the longer, slower windows. */
export function settleOptions(remote) {
  return remote
    ? { quietMs: REMOTE_QUIET_MS, timeoutMs: REMOTE_SETTLE_TIMEOUT_MS, awaitOutputMs: REMOTE_AWAIT_OUTPUT_MS }
    : { quietMs: LOCAL_QUIET_MS, timeoutMs: LOCAL_SETTLE_TIMEOUT_MS, awaitOutputMs: AWAIT_OUTPUT_MS };
}

// ---- ssh sessions ----------------------------------------------------------

/**
 * Host aliases an `ssh` action accepts. Deliberately narrow: this string is
 * typed into a shell as an argv word, so anything that could introduce another
 * word, a flag, or a redirect is rejected before it reaches the PTY. Covers
 * ~/.ssh/config aliases (second_brain), user@host, FQDNs, bare and bracketed
 * IPv6 literals, and `user@host` with a trailing `:port`.
 *
 * The lookahead rejects a leading `-`, so a hostile destination can never arrive
 * as an ssh option (`-oProxyCommand=...`) - the classic way a hostname argument
 * turns into command execution.
 */
const SSH_HOST_RE = /^(?!-)[A-Za-z0-9._:@\[\]-]+$/;

/**
 * Validate a model-supplied ssh destination.
 * @param host - the host alias, user@host, or address.
 * @returns the trimmed host.
 */
export function validateSshHost(host) {
  if (typeof host !== "string" || host.trim().length === 0) {
    throw new Error("invalid sshHost: expected a non-empty string (an ~/.ssh/config alias, user@host, or address)");
  }
  const trimmed = host.trim();
  if (!SSH_HOST_RE.test(trimmed)) {
    throw new Error("invalid sshHost: " + JSON.stringify(trimmed) + " - expected a host alias, user@host, or address (no spaces, flags, or shell metacharacters)");
  }
  return trimmed;
}

/**
 * Which backend hosts an ssh session.
 *
 * The aliases live in the LINUX side's ~/.ssh/config, and that is also where the
 * keys are. On this machine the Windows %USERPROFILE%\.ssh\config is an empty
 * file, so `ssh second_brain` from the PowerShell backend fails with "Could not
 * resolve hostname" - which is exactly why the ssh action does not simply obey
 * the user's default terminal. `wsl` is the configured default; if the user
 * names another backend explicitly, that choice is honored.
 * @param configured - the sshShell config value.
 * @param paths - resolved executables.
 * @returns the backend for ssh sessions.
 */
export function resolveSshShell(configured, paths) {
  const wanted = typeof configured === "string" && configured.trim().length > 0 ? configured.trim() : "wsl";
  if (wanted === "wsl" && paths.wsl !== undefined) return "wsl";
  if (wanted !== "wsl") return wanted;
  return "powershell";
}

/** Interactive-shell argv (no -c: the terminal itself is the session). */
export function terminalArgv(shell, paths, distro) {
  switch (shell) {
    case "powershell": return [paths.pwsh, "-NoLogo", "-NoProfile"];
    case "gitbash": return [paths.gitbash, "-i"];
    case "wsl": {
      // Both forms below are fine: the 0x8007072c RPC failure that once looked
      // argv-dependent was really a missing SystemRoot in the PTY environment -
      // see the env construction in the "open" action below.
      if (distro !== undefined && distro.trim().length > 0) {
        return [paths.wsl, "-d", distro.trim(), "-e", "bash", "-i"];
      }
      return [paths.wsl, "--", "bash", "-i"];
    }
    default: throw new Error("invalid shell: " + JSON.stringify(shell));
  }
}

/**
 * Complete environment for one PTY child.
 *
 * `ctx.shellEnv.collect()` returns an OVERLAY of `DSH_*` values, not a whole
 * environment, and node-pty REPLACES the child's environment with whatever it
 * is handed - unlike `ctx.subprocess`, which layers a given env over the
 * ambient one. So the process environment is materialized as the base layer
 * here, and the overlay still wins.
 *
 * This matters most for `wsl.exe`, which cannot initialise under ConPTY
 * without `SystemRoot` and reports that as `Wsl/Service/0x8007072c`.
 *
 * @param dshEnv - the `DSH_*` overlay from the shell-env seam.
 * @returns the complete environment for the PTY child.
 */
export function buildPtyEnv(dshEnv) {
  return { ...process.env, NO_COLOR: "1", TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat", ...dshEnv };
}

/**
 * Number of trailing characters of `text` that fit into `maxBytes` UTF-8 bytes,
 * never splitting a surrogate pair. This is the retention rule: the ring keeps
 * the newest output, so the cut has to be measured from the end.
 * @param text - the text to measure.
 * @param maxBytes - the byte budget.
 * @returns the trailing UTF-16 code units that fit, usable directly in `String#slice(-n)`.
 */
export function tailChars(text, maxBytes) {
  if (maxBytes <= 0) return 0;
  let start = text.length;
  let total = 0;
  while (start > 0) {
    const step = Math.min(2048, start);
    let begin = start - step;
    if (begin > 0 && isLowSurrogate(text.charCodeAt(begin))) begin -= 1;
    const blockBytes = Buffer.byteLength(text.slice(begin, start));
    if (total + blockBytes <= maxBytes) {
      total += blockBytes;
      start = begin;
      continue;
    }
    // The budget ends inside this block: measure whole code points from the end.
    while (start > begin) {
      let code = text.codePointAt(start - 1);
      let width = 1;
      if (code >= 0xdc00 && code <= 0xdfff && start >= 2) {
        code = text.codePointAt(start - 2);
        width = 2;
      }
      const cost = Buffer.byteLength(String.fromCodePoint(code));
      if (total + cost > maxBytes) return text.length - start;
      total += cost;
      start -= width;
    }
  }
  return text.length - start;
}

/**
 * In-memory output ring for one session.
 *
 * Offsets are ABSOLUTE character positions in the session's output stream: they
 * do not move when the ring drops its oldest text, so a reader can hold one
 * across calls without silently reading shifted data. `readFrom` reports how
 * much of a request fell out of the ring as `elided` instead.
 *
 * @param capBytes - retention cap in UTF-8 bytes (drop-oldest).
 * @returns the ring: `append`, `readFrom`, `start`, `end`, `snapshot`, `lastAppendAt`.
 */
export function createBuffer(capBytes = MAX_BUFFER_BYTES) {
  let text = "";
  /** Absolute position of `text[0]`. */
  let start = 0;
  /** `Buffer.byteLength(text)`, maintained incrementally. */
  let bytes = 0;
  let lastAppendAt = Date.now();

  /** Drop the oldest characters until the ring fits `capBytes` again. */
  function trim() {
    if (bytes <= capBytes || text.length === 0) return;
    const cut = text.length - tailChars(text, capBytes);
    if (cut <= 0) return;
    text = text.slice(cut);
    start += cut;
    // Re-measure instead of subtracting: the budget decides the cut, so an
    // incremental running total would only add a way to drift.
    bytes = Buffer.byteLength(text);
  }

  return {
    append(chunk) {
      if (chunk.length === 0) return;
      text += chunk;
      bytes += Buffer.byteLength(chunk);
      lastAppendAt = Date.now();
      trim();
    },
    /**
     * Everything retained from `offset` to the current end of the stream.
     * @param offset - absolute character offset.
     * @returns the delta, the absolute end position, and how many requested characters were already evicted.
     */
    readFrom(offset) {
      const from = Math.max(offset, start);
      return {
        delta: text.slice(from - start),
        nextOffset: start + text.length,
        elided: Math.max(0, start - offset)
      };
    },
    start: () => start,
    end: () => start + text.length,
    snapshot: () => text,
    lastAppendAt: () => lastAppendAt
  };
}

/** OSC … BEL/ST, CSI … final byte, and two-character escape sequences. */
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const ANSI_CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_ESC = /\u001b[@-Z\\-_]/g;
/** C0 controls a terminal never shows as text ('\r' is handled separately). */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Render one delivered slice the way a terminal would show it: escape
 * sequences dropped, `\r` overwrites collapsed to the text that survives them.
 * Purely presentational - the ring keeps the raw stream, and `raw: true`
 * returns it untouched.
 * @param text - one raw slice of terminal output.
 * @returns the same text without terminal control traffic.
 */
export function scrubTerminalText(text) {
  let out = text.replace(ANSI_OSC, "").replace(ANSI_CSI, "").replace(ANSI_ESC, "");
  out = out.replace(/\r\n/g, "\n").replace(CONTROL, "");
  if (out.includes("\r")) {
    out = out
      .split("\n")
      .map((line) => {
        const parts = line.split("\r").filter((part) => part.length > 0);
        return parts.length === 0 ? "" : parts[parts.length - 1];
      })
      .join("\n");
  }
  return out;
}

/**
 * Assemble one model-facing reply from a session's ring.
 *
 * Line framing holds back an unterminated tail (usually the prompt line) and the
 * byte cap holds back output that does not fit, so the cursor stops exactly at
 * the text the model received. Nothing is dropped: `more` reports that complete
 * lines are already waiting, and `pending` shows the held-back tail.
 *
 * @param buffer - the session's output ring.
 * @param cursor - absolute character offset to read from.
 * @param raw - return the untouched stream instead of terminal-rendered text.
 * @returns the reply fields shared by open / send / read / signal.
 */
export function sliceReply(buffer, cursor, raw = false) {
  const { delta, nextOffset, elided } = buffer.readFrom(cursor);
  const newlineAt = delta.lastIndexOf("\n");
  let delivered;
  if (newlineAt >= 0) {
    delivered = fitChars(delta, MAX_REPLY_BYTES);
    if (delivered < newlineAt + 1) {
      // The byte cap bit before the last complete line: cut at the last newline
      // inside the cap, or hand over the hard-cut slice when not even one line fits.
      const inside = delta.slice(0, delivered).lastIndexOf("\n");
      delivered = inside >= 0 ? inside + 1 : delivered;
    } else {
      delivered = newlineAt + 1;
    }
  } else {
    delivered = Buffer.byteLength(delta) >= FLUSH_BYTES ? fitChars(delta, MAX_REPLY_BYTES) : 0;
  }
  const rest = delta.slice(delivered);
  const tail = rest.slice(rest.lastIndexOf("\n") + 1);
  const text = delta.slice(0, delivered);
  const render = (value) => (raw ? value : scrubTerminalText(value));
  // A tail that renders to nothing (a bare control sequence on a fresh session)
  // is not a tail: reporting `pending: ""` would only mislead the model.
  const pendingText = tail.length > 0 ? render(tail).slice(-MAX_PENDING_CHARS) : "";
  return {
    output: render(text),
    nextOffset: cursor + delivered,
    elided,
    more: rest.includes("\n"),
    pending: pendingText.length > 0 ? pendingText : undefined
  };
}

/**
 * A session's ring as a background-job pull source (the `spec.output` contract
 * of `ctx.jobs` in DSH 0.2.x: one `read(fromByte)` per poll). It reads the raw
 * stream from a cursor of its own, so `job_output` never disturbs the model's
 * read position on the same session.
 * @param session - the terminal session to expose.
 * @returns the source, labelled as stdout.
 */
export function sessionSource(session) {
  return {
    channel: "stdout",
    read: (fromOffset) => {
      const { delta, nextOffset, elided } = session.buffer.readFrom(fromOffset);
      return { text: delta, nextOffset, lossy: elided > 0 };
    }
  };
}

/**
 * Project a settled PTY into a job outcome. `jobs.settle()` writes
 * `outcome.status` straight into the job record, so the raw
 * `{ exitCode, signal }` a PTY resolves with would leave the job "running"
 * forever; the registry contract wants a terminal status here. A session we
 * terminated ourselves reports `killed`: node-pty surfaces that as signal 0
 * plus a Windows STATUS_CONTROL_C_EXIT code, which is not a natural exit.
 * @param outcome - what the PTY's `done` resolved with.
 * @param terminated - whether this plugin terminated the session (close/kill).
 * @returns `{ status, detail }` for the job registry.
 */
export function ptyOutcome(outcome, terminated = false) {
  const signal = outcome === undefined ? undefined : outcome.signal;
  const killed = terminated || (signal !== undefined && signal !== null && signal !== 0 && signal !== "0" && signal !== "");
  if (killed) return { status: "killed", detail: terminated ? "session terminated" : "signal: " + String(signal) };
  return { status: "completed", detail: "exit code: " + String(outcome === undefined ? 0 : outcome.exitCode ?? 0) };
}

/**
 * Direct node-pty handle with the same surface the official seam returns:
 * output (stream), pid, done, write / signalForeground / terminate. Used on
 * win32 where the official spawnTerminal's process inspector is unsupported.
 */
async function spawnPtyHandle({ argv, cwd, env, rows, cols }) {
  const mod = await import("node-pty");
  const nodePty = mod.default ?? mod;
  const term = nodePty.spawn(argv[0], argv.slice(1), {
    // `name` is the TERM the PTY reports; env.TERM wins for the child itself.
    // A remote session asks for a real terminal type (see REMOTE_TERM).
    name: env.TERM ?? "dumb",
    cols,
    rows,
    cwd,
    env
  });
  const output = new PassThrough();
  term.onData((chunk) => output.write(Buffer.from(chunk, "utf8")));
  const done = new Promise((resolve) => term.onExit(({ exitCode, signal }) => resolve({ exitCode, signal })));
  return {
    pid: term.pid,
    output,
    done,
    write: (data) => term.write(data),
    // node-pty accepts no named signals on Windows: Ctrl+C is the \x03 byte
    // (ConPTY delivers it to the foreground process), other signals degrade
    // to terminating the session.
    signalForeground: (sig) => {
      if (sig === "SIGINT") { term.write("\x03"); return; }
      term.kill();
    },
    terminate: async () => { try { term.kill(); } catch {} }
  };
}

/** Key one reader's cursor: sessions are host-wide, agents must not share one. */
function readerKey(exec) {
  const id = exec.agent === undefined ? undefined : exec.agent.id;
  return typeof id === "string" && id.length > 0 ? id : "shared";
}

/**
 * Terminal-session registry owned by the plugin fiber: opens PTYs through
 * the official seam, forwards output into a capped ring, and tears every
 * session down on plugin disposal.
 *
 * `spawnPty` is injectable so a test can drive the whole session surface -
 * remote marking, settle windows, signals, jobs - against a scripted PTY. That
 * matters on Windows, where the production path deliberately bypasses
 * `ctx.subprocess` (its process inspector is POSIX-only), so a fake
 * `ctx.subprocess.spawnTerminal` alone would never be reached and a test would
 * quietly allocate real ConPTYs instead.
 *
 * @param ctx - the plugin fiber context.
 * @param spawnPty - optional PTY allocator; defaults to the win32 node-pty path
 *   or the official `ctx.subprocess.spawnTerminal` seam elsewhere.
 */
export function createTerminalRegistry(ctx, spawnPty) {
  const spawn = spawnPty ?? (process.platform === "win32"
    ? (spec) => spawnPtyHandle(spec)
    : (spec) => ctx.subprocess.spawnTerminal({ ...spec, graceMs: 3000 }));
  const sessions = new Map();
  ctx.effect(() => () => {
    for (const session of sessions.values()) {
      void session.handle.terminate().catch(() => {});
    }
    sessions.clear();
  }, "bash-terminal: terminal sessions teardown");

  async function open({ argv, shell, cwd, env, rows, cols, distro, initial, idleMs, sshHost }) {
    if (sessions.size >= MAX_SESSIONS) {
      throw new Error("terminal: too many open sessions (" + MAX_SESSIONS + "); close one before opening another");
    }
    // A remote session is one whose work happens on the far side of an ssh
    // login: it gets a real TERM (remote programs colorize and line-edit
    // correctly) and the slower settle tuning above.
    const remote = sshHost !== undefined;
    const childEnv = remote
      ? (() => { const { NO_COLOR, ...rest } = env; return { ...rest, TERM: REMOTE_TERM }; })()
      : env;
    const handle = await spawn({ argv, cwd, env: childEnv, rows, cols });
    const buffer = createBuffer();
    // A PTY emits bytes: decode across chunk boundaries so a multi-byte
    // character split between two reads is not corrupted into U+FFFD.
    const decoder = new StringDecoder("utf8");
    handle.output.on("data", (chunk) => buffer.append(typeof chunk === "string" ? chunk : decoder.write(chunk)));
    const session = {
      id: randomUUID(),
      handle,
      buffer,
      shell,
      distro,
      // The ssh destination when this session was opened by the ssh action; its
      // presence is what marks the session remote for settle and env tuning.
      sshHost,
      closed: false,
      // Set when this plugin terminates the PTY (close / job kill / idle), so
      // the job outcome can tell our kill from a natural shell exit.
      terminated: false,
      // Set when the PTY itself is gone - by its own exit or a kill. The ring
      // keeps serving `read`; `send`/`signal` refuse instead of writing into a
      // handle nobody consumes.
      exited: false,
      exitOutcome: undefined,
      // Remote sessions idle longer by default: after a long remote build the
      // model may think for minutes, and re-establishing the login is the
      // expensive part.
      idleMs: idleMs ?? (remote ? REMOTE_IDLE_MS : DEFAULT_IDLE_MS),
      cursors: new Map()
    };
    // The PTY is gone: flush a half-decoded character and stop accepting input.
    const markExited = (outcome) => {
      session.exited = true;
      session.exitOutcome = outcome;
      buffer.append(decoder.end());
    };
    void handle.done.then((outcome) => markExited(outcome), () => markExited(undefined));
    // Idle guard: any read/send/signal touches the timer; expiry terminates the
    // session so an abandoned PTY never leaks a process tree.
    const touch = () => {
      if (session.closed) return;
      clearTimeout(session.idleTimer);
      session.idleTimer = setTimeout(() => {
        if (session.closed) return;
        session.closed = true;
        session.terminated = true;
        sessions.delete(session.id);
        void session.handle.terminate().catch(() => {});
      }, session.idleMs);
    };
    session.touch = touch;
    touch();
    sessions.set(session.id, session);
    if (initial !== undefined && initial.length > 0) {
      await handle.write(initial);
      // Remote windows here too: the startup input for an ssh session IS the
      // login, so a local-tuned wait gave up mid-handshake and left the login
      // banner for a second read, which the model had to know to make.
      await waitSettled(buffer, settleOptions(remote));
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

  /**
   * One reader's incremental reply.
   *
   * A reader that never read this session starts at the tail window rather than
   * at the beginning of the retention ring, and its `elided` count says how much
   * came before. An explicit `from` overrides the cursor for this reply only.
   *
   * @param session - the session to read.
   * @param caller - the reader key (the agent's session id, or "shared").
   * @param options.from - absolute offset to read from; defaults to the reader's cursor.
   * @param options.raw - return the untouched stream.
   * @param options.waiting - output was still arriving when the wait cap expired.
   * @returns the reply fields for the tool result.
   */
  function deliver(session, caller, options = {}) {
    const fresh = options.from === undefined && !session.cursors.has(caller);
    const cursor = options.from === undefined
      ? (fresh
        ? Math.max(session.buffer.start(), session.buffer.end() - ORIENT_CHARS)
        : session.cursors.get(caller))
      : Math.max(0, Math.floor(options.from));
    const reply = sliceReply(session.buffer, cursor, options.raw === true);
    session.cursors.set(caller, reply.nextOffset);
    const elided = Math.max(reply.elided, fresh ? cursor : 0);
    return {
      output: reply.output,
      nextOffset: reply.nextOffset,
      ...(elided > 0 ? { elided } : {}),
      ...(reply.more ? { more: true } : {}),
      ...(reply.pending !== undefined ? { pending: reply.pending } : {}),
      ...(options.waiting === true ? { waiting: true } : {})
    };
  }

  /**
   * Refuse input the PTY can no longer consume. A session whose shell exited
   * (or was killed by a job) still holds its final output for `read`, but a
   * `send`/`signal` into a dead handle would silently do nothing - which reads
   * to the model as "the command ran and printed nothing".
   * @param session - the session being written to.
   * @param action - the action name for the message.
   */
  function assertLive(session, action) {
    if (session.exited !== true) return;
    const code = session.exitOutcome === undefined ? "" : " (exit code " + String(session.exitOutcome.exitCode ?? 0) + ")";
    throw new Error("terminal session has exited" + code + ": " + action + " needs a live session - read the remaining output, close it, and open a new one");
  }

  async function send(id, input, caller, options) {
    const session = get(id);
    assertLive(session, "send");
    await session.handle.write(input);
    const settled = await waitSettled(session.buffer, settleOptions(session.sshHost !== undefined));
    return deliver(session, caller, { ...options, waiting: settled.waiting });
  }

  async function signal(id, sig, caller, options) {
    const session = get(id);
    if (!TERMINAL_SIGNALS.includes(sig)) throw new Error("invalid terminal signal: " + JSON.stringify(sig));
    assertLive(session, "signal");
    await session.handle.signalForeground(sig);
    const settled = await waitSettled(session.buffer, settleOptions(session.sshHost !== undefined));
    return deliver(session, caller, { ...options, waiting: settled.waiting });
  }

  function read(id, caller, options) {
    return deliver(get(id), caller, options);
  }

  function list() {
    return [...sessions.values()].map((session) => ({
      sessionId: session.id,
      shell: session.shell,
      pid: session.handle.pid,
      closed: session.closed,
      exited: session.exited === true,
      ...(session.sshHost !== undefined ? { sshHost: session.sshHost } : {})
    }));
  }

  async function close(id) {
    const session = get(id);
    session.closed = true;
    session.terminated = true;
    clearTimeout(session.idleTimer);
    sessions.delete(id);
    await session.handle.terminate();
    return true;
  }

  return { open, get, send, read, signal, close, list, deliver, peek: (id) => sessions.get(id) };
}

function validateArgs(args) {
  if (typeof args.action !== "string" || ["open", "ssh", "send", "read", "signal", "close", "list"].indexOf(args.action) === -1) {
    throw new Error("invalid action: expected open, ssh, send, read, signal, close, or list");
  }
  if ((args.action === "send" || args.action === "read" || args.action === "signal" || args.action === "close") && (typeof args.sessionId !== "string" || args.sessionId.length === 0)) {
    throw new Error("invalid sessionId: required for " + args.action);
  }
  if (args.action === "ssh") validateSshHost(args.sshHost);
  if (args.sshHost !== undefined && args.action !== "ssh") {
    throw new Error("invalid sshHost: only the ssh action takes a host (open a plain session with action \"open\")");
  }
  if (args.action === "send" && (typeof args.input !== "string" || args.input.length === 0)) {
    throw new Error("invalid input: expected a non-empty string for send");
  }
  if (args.action === "signal" && (typeof args.signal !== "string" || TERMINAL_SIGNALS.indexOf(args.signal) === -1)) {
    throw new Error("invalid signal: expected one of " + TERMINAL_SIGNALS.join(", "));
  }
  const reads = args.action === "send" || args.action === "read" || args.action === "signal";
  if (args.from !== undefined && (!Number.isSafeInteger(args.from) || args.from < 0)) {
    throw new Error("invalid from: expected a non-negative integer stream offset");
  }
  if (args.from !== undefined && args.full === true) {
    throw new Error("invalid arguments: pass either from or full, not both");
  }
  if (args.full !== undefined && typeof args.full !== "boolean") {
    throw new Error("invalid full: expected a boolean");
  }
  if (args.raw !== undefined && typeof args.raw !== "boolean") {
    throw new Error("invalid raw: expected a boolean");
  }
  if (!reads && (args.from !== undefined || args.full === true)) {
    throw new Error("invalid arguments: from/full apply to send, read, and signal");
  }
}

/** The reply fields every session-carrying result shares. */
const REPLY_PROPERTIES = {
  output: { type: "string", required: true },
  nextOffset: { type: "integer", required: true },
  more: { type: "boolean" },
  elided: { type: "integer" },
  pending: { type: "string" },
  waiting: { type: "boolean" }
};

/**
 * Render a reply as text for the model: the delivered output, then one compact
 * trailer carrying the facts the next call needs (stream offset, waiting
 * output, held-back tail, dropped characters).
 * @param value - the tool result value.
 * @returns the content block.
 */
function renderReply(value) {
  const facts = [];
  if (value.elided !== undefined) facts.push(value.elided + " earlier characters omitted");
  if (value.more === true) facts.push("more output waiting - read again");
  if (value.waiting === true) facts.push("still producing output - read again before sending the next command");
  if (value.pending !== undefined) facts.push("tail without newline: " + JSON.stringify(value.pending));
  facts.push("offset " + value.nextOffset);
  const trailer = "[" + facts.join(" | ") + "]";
  if (value.output.length === 0) return trailer;
  return value.output.endsWith("\n") ? value.output + trailer : value.output + "\n" + trailer;
}

export function terminalTool(ctx, registry, paths, defaultShell, sshShell) {
  return defineTool({
    name: "terminal",
    description: "Run commands in a PERSISTENT interactive terminal session over the user's default terminal (Settings -> General -> Default terminal: powershell / gitbash / wsl). A real PTY hosts one long-lived shell: open a session, then send input and read output across as many calls as you like, deliver signals (Ctrl+C = SIGINT) to the foreground process, and close when done. The session survives between calls and is managed as a background job (job_kill / job_output work on it); idle sessions close automatically. Use this INSTEAD of the shell tool whenever shell state must persist (cwd, exported variables, an activated venv, a backgrounded process), whenever a command is interactive (prompts, passwords, 2FA, pagers, REPLs, tunnels, databases, TUI tools), and above all for WORK ON A REMOTE SERVER: action \"ssh\" with sshHost opens one ssh login and every later send reuses it, so multi-step remote work keeps its cwd, environment and shell variables instead of paying for a fresh connection per command. Reads are INCREMENTAL: send/read/signal return only the output produced since your previous read on this session, rendered the way a terminal shows it (escape sequences stripped, \\r overwrites collapsed). Every reply carries `nextOffset` (the absolute stream position your cursor now sits at), `pending` (an unterminated tail, usually the prompt line), `more: true` when complete lines are already waiting for another read, `waiting: true` when output was still arriving as the wait cap expired (read again before typing the next command), and `elided` when characters fell out of the retained ring. Pass `from: 0` (or `full: true`) to re-read the whole retained log, `from: <nextOffset>` to resume from a position you saw earlier, and `raw: true` for the untouched byte stream.",
    parameters: {
      action: {
        type: "string",
        enum: ["open", "ssh", "send", "read", "signal", "close", "list"],
        required: true,
        description: "open: create a session and return its id. ssh: open a session already logged in to a remote server (requires sshHost) - the right choice for work on a server across several commands. send: write input and read new output. read: read new output without writing. signal: send a signal to the foreground process (SIGINT for Ctrl+C). close: terminate the session. list: list live sessions."
      },
      sessionId: {
        type: "string",
        description: "Session id returned by open/ssh; required for send/read/signal/close."
      },
      sshHost: {
        type: "string",
        description: "With action ssh: the destination to log in to - an ~/.ssh/config alias (e.g. second_brain), user@host, or an address. Authentication stays interactive, so a password or 2FA prompt can be answered with send."
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
      from: {
        type: "integer",
        description: "With send/read/signal: absolute stream offset to read from instead of your current cursor (0 = the whole retained log; each reply reports the offset it stopped at)."
      },
      full: {
        type: "boolean",
        description: "With send/read/signal: shorthand for from: 0 - re-read the whole retained log instead of only new output."
      },
      raw: {
        type: "boolean",
        description: "With open/send/read/signal: return the untouched terminal stream (escape sequences and \\r overwrites included) instead of the terminal-rendered text."
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
              sshHost: { type: "string" },
              ...REPLY_PROPERTIES
            }
          },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { type: "string", required: true, const: "session" },
              ...REPLY_PROPERTIES
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
                    closed: { type: "boolean" },
                    exited: { type: "boolean" },
                    sshHost: { type: "string" }
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
          ? "terminal session " + value.sessionId + " (pid " + value.pid + ", " + value.shell + (value.sshHost !== undefined ? ", ssh " + value.sshHost : "") + ")\n" + renderReply(value)
          : value.kind === "closed"
            ? "terminal session " + value.sessionId + " closed"
            : value.kind === "list"
              ? (value.sessions.length === 0 ? "no open terminal sessions" : value.sessions.map((s) => s.sessionId + " (" + s.shell + (s.sshHost !== undefined ? " -> ssh " + s.sshHost : "") + ", pid " + s.pid + (s.exited === true ? ", exited" : "") + ")").join("\n"))
              : renderReply(value)
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
      const caller = readerKey(exec);
      const options = {
        ...(args.from !== undefined ? { from: args.from } : args.full === true ? { from: 0 } : {}),
        ...(args.raw === true ? { raw: true } : {})
      };

      const sshShellOption = sshShell === undefined ? "wsl" : sshShell();

      /**
       * Open a session and register it as a background job. Shared by `open`
       * and `ssh`: the only differences are the backend, the startup input, and
       * whether the session counts as remote.
       *
       * A remote session is opened by typing `ssh <host>` into an INTERACTIVE
       * LOCAL SHELL rather than by spawning `ssh` as the top-level process. That
       * ordering is deliberate: with ssh as the top-level process, SIGINT from
       * the signal action interrupts the ssh client itself (or the whole
       * session) instead of the remote foreground command, so Ctrl+C could no
       * longer stop a runaway remote job. Behind a local shell, signals, the
       * ring and the job wiring all behave exactly like any other session.
       * @param target - backend, argv, cwd, env and startup input for the session.
       */
      async function openSession({ shell, argv, cwd, env, initial, sshHost }) {
        if (argv[0] === undefined) throw new Error("terminal: " + shell + " backend unavailable - executable not found");
        const session = await registry.open({
          argv,
          shell,
          cwd,
          env,
          rows: DEFAULT_ROWS,
          cols: DEFAULT_COLS,
          distro: args.distro,
          initial,
          idleMs: args.idleMs,
          ...(sshHost !== undefined ? { sshHost } : {})
        });
        // The startup banner is this reader's first reply, and it leaves the
        // cursor at its end: the next send returns only that command's output.
        const startup = registry.deliver(session, caller, { from: 0, ...(args.raw === true ? { raw: true } : {}) });
        const jobs = ctx.get("jobs");
        const jobId = jobs === undefined ? undefined : jobs.start({
          kind: "terminal/session",
          label: "terminal " + session.id.slice(0, 8) + " (" + shell + ")",
          // DSH 0.2.x resolves `owner` through the agent registry, so it is
          // the SESSION ID, not the Agent object.
          ...(exec.agent?.id !== undefined ? { owner: exec.agent.id } : {}),
          output: [sessionSource(session)],
          run: () => ({
            // job_kill (and any teardown cancel) terminates the PTY: record
            // that it was us, so the settled job reads `killed`, not a natural
            // exit with node-pty's STATUS_CONTROL_C_EXIT code.
            cancel: () => {
              session.terminated = true;
              void session.handle.terminate().catch(() => {});
            },
            done: session.handle.done.then(
              (outcome) => ptyOutcome(outcome, session.terminated === true),
              (error) => ({ status: "failed", detail: String(error) })
            )
          })
        });
        return {
          kind: "open",
          sessionId: session.id,
          ...(jobId !== undefined ? { jobId } : {}),
          pid: session.handle.pid,
          shell,
          ...(sshHost !== undefined ? { sshHost } : {}),
          ...startup
        };
      }

      /** The PTY environment for one session, WSLENV overlay included. */
      function sessionEnv(shell) {
        const dshEnv = ctx.shellEnv.collect(exec);
        const env = buildPtyEnv(dshEnv);
        if (shell === "wsl" && dshEnv !== undefined) {
          const keys = Object.keys(dshEnv);
          if (keys.length > 0) env.WSLENV = [env.WSLENV, keys.join(":")].filter(Boolean).join(":");
        }
        return env;
      }

      /** Resolve one session's local working directory. */
      function sessionCwd() {
        return args.workdir !== undefined
          ? (headerCwd !== undefined && !isAbsolute(args.workdir) ? resolve(headerCwd, args.workdir) : args.workdir)
          : (headerCwd ?? process.cwd());
      }

      switch (args.action) {
        case "open": {
          const shell = defaultShell();
          return await openSession({
            shell,
            argv: terminalArgv(shell, paths, args.distro),
            cwd: sessionCwd(),
            env: sessionEnv(shell),
            initial: args.command !== undefined ? args.command + "\r" : undefined
          });
        }
        case "ssh": {
          const sshHost = validateSshHost(args.sshHost);
          const shell = resolveSshShell(sshShellOption, paths);
          if (shell === "powershell") {
            throw new Error("terminal: ssh sessions need the wsl backend, because the ssh host aliases and keys live in the WSL ~/.ssh/config (the Windows one is empty). Set the sshShell config to \"wsl\" and make sure wsl.exe is available.");
          }
          return await openSession({
            shell,
            argv: terminalArgv(shell, paths, args.distro),
            cwd: sessionCwd(),
            env: sessionEnv(shell),
            initial: "ssh " + sshHost + "\r",
            sshHost
          });
        }
        case "send": return { kind: "session", ...await registry.send(args.sessionId, args.input, caller, options) };
        case "read": return { kind: "session", ...registry.read(args.sessionId, caller, options) };
        case "signal": return { kind: "session", ...await registry.signal(args.sessionId, args.signal, caller, options) };
        case "close": {
          await registry.close(args.sessionId);
          return { kind: "closed", sessionId: args.sessionId };
        }
        case "list": return { kind: "list", sessions: registry.list() };
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

//#region internals for tests
export const internals = {
  readerKey,
  renderReply,
  validateArgs,
  MAX_BUFFER_BYTES,
  MAX_REPLY_BYTES,
  FLUSH_BYTES,
  ORIENT_CHARS,
  MAX_PENDING_CHARS
};
//#endregion
