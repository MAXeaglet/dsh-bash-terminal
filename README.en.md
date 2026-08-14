# dsh-bash-terminal

> Community: [LINUX DO](https://linux.do) · [GitHub](https://github.com/MAXeaglet/dsh-bash-terminal)

A DeepSeek Harness (DSH) plugin: one `shell` tool that runs commands through **PowerShell / Git Bash / WSL** on Windows, plus an **interactive terminal** tool — all following the terminal **you** choose in the Web UI settings.

![test](https://github.com/MAXeaglet/dsh-bash-terminal/actions/workflows/test.yml/badge.svg)

## Features

| Backend | Runs | Syntax / paths | Env vars |
|---------|------|----------------|----------|
| `powershell` (default) | `pwsh -NoLogo -NoProfile -NonInteractive -Command <cmd>` | PowerShell; `C:\\...` | `$env:NAME` |
| `gitbash` | Git for Windows `bash -lc <cmd>` | POSIX; `/d/WorkSpace`; PATH includes `/usr/bin` and `/mingw64/bin` | `$NAME` |
| `wsl` | `wsl [-d <distro>] -e bash -lc <cmd>` | Linux; `/mnt/d/...` | `$NAME` (via WSLENV) |

- **User decides, the AI cannot override**: pick the default terminal in Settings -> General -> Default terminal (PowerShell / Git Bash / WSL). The setting persists through the DSH settings system; the `shell` tool always obeys it.
- **Official sandbox seam**: the `shell` tool resolves the DSH sandbox policy per call and confines PowerShell / Git Bash argv through `ctx.sandbox` — same fail-closed `SandboxUnavailableError` semantics as the shipped executors. WSL runs unconfined (its Linux-VM isolation IS the sandbox). Official `sandbox_permissions` / `justification` escalation and denial markers included.
- **Interactive terminal**: the `terminal` tool opens persistent real-PTY sessions over the official `ctx.subprocess.spawnTerminal` seam (node-pty). Actions `open` / `send` / `read` / `signal` / `close`; shell state persists across calls; sessions are managed as background jobs and auto-close when idle.
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
- Confined sessions wrap PowerShell / Git Bash argv through `ctx.sandbox.confine`; fail-closed when no backend is available.
- WSL is never wrapped (its VM isolation is the sandbox; results report `enforcement: wsl-isolation`).
- Denied calls render the official `[sandbox: file access denied under <mode> mode]` marker plus a same-turn escalation hint; the model may retry once with `sandbox_permissions` + `justification` (user-approved via `ctx.approval`).
- Note: DSH's Windows ACL sandbox launcher (`node-addon-landlock-run-win32-x64`) is not yet published on npm; the integration is architecture-ready and activates automatically when DSH ships it.

## Interactive terminal

`terminal` actions: `open` (start a session on the configured default terminal), `send` (write input + read new output), `read`, `signal` (SIGINT = Ctrl+C etc.), `close`, `list` (enumerate live sessions). Reads wait for output to settle (quiet 300ms, cap 5s) so `send` returns the complete reply; buffer overflow reports a `truncated` notice. State (cwd / variables / aliases) persists across calls; end input with `\\n`. Sessions are background jobs (`job_kill` works) and auto-close after 10 idle minutes (`idleMs` overrides on open).

## Interactive terminal known limits (ConPTY)

- **Windows PowerShell 5.1 cannot start in a ConPTY** (0x8009001d) — install [PowerShell 7](https://github.com/PowerShell/PowerShell/releases) for interactive PowerShell (one-shot commands are unaffected).
- **wsl.exe interactive mode may hit a WSL service RPC error under ConPTY** (0x8007072c, intermittent) — one-shot `wsl -e bash -lc ...` works; for interactive WSL prefer a real terminal (Windows Terminal / WSL app) or retry.
- Git Bash interactive sessions work fully.

## Config

Web UI: Settings -> General -> Default terminal. Plugin row `config` overrides: `defaultShell`, `timeoutMs`, `maxTimeoutMs`, `pwshPath`, `gitBashPath`, `wslPath`.

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 uninstall
```

## Tests

```powershell
node test/unit.mjs && node test/apply.mjs && node test/client.mjs && node test/terminal.mjs
```
