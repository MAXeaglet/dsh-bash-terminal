# dsh-bash-terminal

> Community: [LINUX DO](https://linux.do) · [GitHub](https://github.com/MAXeaglet/dsh-bash-terminal)

A DeepSeek Harness (DSH) plugin: one `shell` tool that runs commands through **PowerShell / Git Bash / WSL** on Windows, plus an **interactive terminal** tool — all following the terminal **you** choose in the Web UI settings.

![test](https://github.com/MAXeaglet/dsh-bash-terminal/actions/workflows/test.yml/badge.svg)

## Features

| Backend | Runs | Syntax / paths | Env vars |
|---------|------|----------------|----------|
| `powershell` (default) | `pwsh -NoLogo -NoProfile -NonInteractive -EncodedCommand <base64 UTF-16LE>` | PowerShell; `C:\\...` | `$env:NAME` |
| `gitbash` | Git for Windows `bash -ls` (script on stdin) | POSIX; `/d/WorkSpace`; PATH includes `/usr/bin` and `/mingw64/bin` | `$NAME` |
| `wsl` | `wsl [-d <distro>] -e bash -ls` (script on stdin) | Linux; `/mnt/d/...` | `$NAME` (via WSLENV) |

**The script is delivered byte-for-byte, never through argv.** The command text is no longer a single argv element crossing the Windows command line / `wsl.exe` argument bridge: bash reads the script from stdin (the pipe is closed right after the write, so a `cat`/`read` sees EOF instead of hanging), including scripts far larger than the 32 KB Windows command-line limit, and PowerShell receives it base64-encoded as UTF-16LE so newlines and quotes are exact (the encoded payload keeps its own argv budget). The `-l` login flag is kept, so PATH and the environment are the same as before.

- **User decides, the AI cannot override**: pick the default terminal in Settings -> General -> Default terminal (PowerShell / Git Bash / WSL). The setting persists through the DSH settings system; the `shell` tool always obeys it.
- **Official sandbox seam**: the `shell` tool resolves the DSH sandbox policy per call and confines PowerShell argv through `ctx.sandbox` — same fail-closed `SandboxUnavailableError` semantics as the shipped executors. Git Bash and WSL run unconfined: WSL is its own Linux VM, while Git Bash cannot run under the DSH Windows ACL restricted-token runner (Cygwin/MSYS2 aborts with `CreateFileMapping` Win32 error 5). Official `sandbox_permissions` / `justification` escalation and denial markers included.
- **Interactive terminal**: the `terminal` tool opens persistent real-PTY sessions over node-pty — on non-Windows via the official `ctx.subprocess.spawnTerminal` seam, on Windows directly through node-pty because the upstream seam's process inspector is POSIX-only. Actions `open` / `send` / `read` / `signal` / `close` / `list`; shell state persists across calls; reads are incremental (see below); sessions are managed as background jobs and auto-close when idle.
- **Background execution** via the generic jobs registry (`run_in_background` / `job_output` / `job_kill`).

## Install

The package ships the official `dsh.bundle` manifest (its own `cordis.patch.yml`): listing `dsh-bash-terminal` in a profile's `dsh.profile.bundles` auto-applies the mount — no manual profile edits.

```powershell
npm install -g dsh-bash-terminal
dsh plugin --profile web add dsh-bash-terminal        # adds to profile bundles + applies the patch
powershell -ExecutionPolicy Bypass -File install.ps1 install   # patches the DSH settings-UI allowlist (see below)
# restart dsh web
```

> **DSH limitation**: the Web settings client only exposes a hard-coded allowlist of settings namespaces (`dsh-host-apiproxy`); third-party settings writes are refused with `settings-not-exposed` otherwise. `install.ps1` patches the allowlist (with a backup) — re-run it after upgrading DSH; `install` / `uninstall` restores it.

For local development (junction install, source changes apply instantly) see the Chinese README's development section.

## Sandbox

- `danger-full-access` sessions run directly (no wrapping).
- Confined sessions wrap PowerShell argv through `ctx.sandbox.confine`; fail-closed when no backend is available.
- Git Bash is never wrapped: the Windows ACL restricted-token runner cannot host Cygwin/MSYS2 (`CreateFileMapping` Win32 error 5); results report `enforcement: gitbash-unconfined`.
- WSL is never wrapped (its VM isolation is the sandbox; results report `enforcement: wsl-isolation`).
- Denied calls render the official `[sandbox: file access denied under <mode> mode]` marker plus a same-turn escalation hint; the model may retry once with `sandbox_permissions` + `justification` (user-approved via `ctx.approval`).
- Note: when DSH's Windows ACL runner is available, it confines PowerShell; Git Bash remains unconfined due to the Cygwin/MSYS2 incompatibility.

## Interactive terminal

`terminal` actions: `open` (start a local session on the configured default terminal), `ssh` (start a session already logged in to a remote host - the right choice for server work), `send` (write input + read new output), `read`, `signal` (SIGINT = Ctrl+C etc.), `close`, `list` (enumerate live sessions).

**Remote work belongs in one session, not one call per command.** `terminal(action: "ssh", sshHost: "second_brain")` logs in once and returns a `sessionId`; every later `send` reuses that login, so the remote cwd, exported variables and shell state survive between commands. `sshHost` takes an `~/.ssh/config` alias, `user@host`, or an address; authentication stays interactive, so a password or 2FA prompt is answered with `send` - which the one-shot `shell` tool can never do. Remote sessions are marked `sshHost` in `open` replies and in `list`, idle for 30 minutes instead of 10, get `TERM=xterm-256color` with `NO_COLOR` dropped (so remote colors and line editing work), and the ssh login runs behind an interactive local shell so `signal` sends SIGINT to the **remote foreground command** rather than to the ssh client.

Because the ssh aliases and keys live in the WSL `~/.ssh/config` (while Windows' `%USERPROFILE%\.ssh\config` is commonly empty), ssh sessions use the `sshShell` config (default `wsl`) rather than `defaultShell` - switching your everyday terminal to PowerShell will not break remote work. An explicitly configured non-WSL backend is honored, and an unavailable WSL fails with an actionable message.

Reads wait for output to settle so `send` returns the complete reply: quiet 300ms / cap 8s locally, quiet 1200ms / cap 20s for remote sessions. The wait is **anchored to the output position at entry** - a reply counts as complete only once output has appeared *after* the write and then gone quiet, so a write into an already-idle session never returns the previous command's output as if it were the new one. A command that says nothing within 3.5s (local) or 8s (remote) is reported as `waiting: true` instead of an empty result, telling the model to read again.

Reads are **incremental**: each send/read/signal returns only the output produced since that reader's cursor, rendered the way a terminal shows it (escape sequences stripped, `\r` overwrites collapsed), so a long session never re-delivers history into the context. Every reply carries `nextOffset` (the absolute stream position the cursor stopped at), `pending` (an unterminated tail, usually the prompt line), `more: true` (complete lines already waiting for another read), `waiting: true` (still producing output - read again before typing the next command), and `elided` (characters that fell out of the retained ring). One reply is capped at 32 KB of UTF-8 bytes; the rest stays in the ring and pages in over further reads, so nothing is lost - the cursor advances only past text the model actually received. `from: 0` (or `full: true`) re-reads the whole retained log, `from: <nextOffset>` resumes an earlier position, `raw: true` returns the untouched stream. The ring itself is capped by **UTF-8 bytes** (1 MiB, drop-oldest) and never cuts a multi-byte character or a surrogate pair. State (cwd / variables / aliases) persists across calls; end input with `\\n` (or `\r`). Sessions are background jobs (`job_kill` works) and auto-close when idle (`idleMs` overrides on open).

## Interactive terminal known limits (ConPTY)

- **Windows PowerShell 5.1 cannot start in a ConPTY** (0x8009001d) — install [PowerShell 7](https://github.com/PowerShell/PowerShell/releases) for interactive PowerShell (one-shot commands are unaffected).
- **wsl.exe interactive mode may hit a WSL service RPC error under ConPTY** (0x8007072c, intermittent) — one-shot `wsl ... bash -ls` works; for interactive WSL prefer a real terminal (Windows Terminal / WSL app) or retry.
- **node-pty accepts no named signals on Windows**: `signal` maps `SIGINT` to Ctrl+C (`\x03`); other signals (`SIGTERM` / `SIGKILL` / `SIGTSTP` / `SIGHUP`) degrade to terminating the session.
- Git Bash interactive sessions work fully.

## Config

Web UI: Settings -> General -> Default terminal. Plugin row `config` overrides: `defaultShell`, `sshShell`, `timeoutMs`, `maxTimeoutMs`, `pwshPath`, `gitBashPath`, `wslPath`.

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 uninstall
```

## Tests

```powershell
npm test   # unit -> apply -> buffer -> terminal -> settle -> e2e
```

`test/e2e.mjs` drives the real `ctx.subprocess` provider: WSL and Git Bash heredocs are written and read back byte-for-byte (foreground and background, including the job's output sources), a bare `cat` proves stdin reaches EOF instead of hanging, PowerShell runs multiline blocks with quotes/`$` without CLIXML noise, and an 80 KB heredoc (beyond the old 32 KB Windows command-line limit) hashes identical.
