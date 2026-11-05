# Changelog

## 0.6.1 (2026-11-05)

### Fixed

- **Heredoc / multiline commands hung or lost bytes: the script no longer travels through argv.** `buildArgv` passed the whole command as one argv element (`wsl ... -e bash -lc <cmd>`, `bash -lc <cmd>`, `pwsh ... -Command <cmd>`), so the script was re-parsed by the Windows command line and the `wsl.exe` argument bridge. Heredoc terminators and embedded quotes could come through altered, and a `cat` whose heredoc redirect had been mangled was left reading a stdin that the background job never closed - the reported 5+ minute `shell/wsl-…` job. Commands beyond the ~32K Windows command-line limit failed with `ENAMETOOLONG` (or arrived truncated), which is what a large CSS heredoc hits. Bash backends now read the script from stdin (`bash -ls`): the subprocess seam writes the batch and closes the pipe in the same operation, so a `cat`/`read` sees EOF immediately. PowerShell receives the script through `-EncodedCommand` as base64 UTF-16LE, so newlines, quotes, `$` and backslashes reach it byte-for-byte at parser level. `-l` is kept, so PATH and the login environment are unchanged.
- PowerShell's encoded route prefixes the script with `$ProgressPreference = 'SilentlyContinue';`. Windows PowerShell 5.1 otherwise serializes its "Preparing modules for first use" progress record to stderr as a CLIXML blob on every `-EncodedCommand` invocation, which would have polluted the model-facing stderr of every PowerShell call.
- Background jobs leave no stdin handle open: the batch stdin mode ends the pipe right after the write, so `job_kill` is only needed for genuinely running work, never to break a stdin wait.

### Known PowerShell 5.1 host behavior

`-EncodedCommand` changes two host-level facts on Windows PowerShell 5.1 (both are PowerShell behaviors, not plugin choices; see COMPATIBILITY-DSH-NEWEST.md for the measurements):

- Cmdlet error records (`Write-Error`, `Get-Item` failures, ...) are serialized to stderr as CLIXML instead of plain text; the message is intact inside `<S S="Error">`, native program stderr (`git`, `node`, `cmd`, ...) is passed through unchanged, and exit codes are identical to the old `-Command` route (`exit N` → N, failing last statement → 1).
- The encoded payload is UTF-16LE base64, so the script budget is roughly 12K characters (the old raw `-Command` route allowed ~32K) before the Windows 32,767-character command line is exceeded.

Both are documented in COMPATIBILITY-DSH-NEWEST.md; `-File -` was tested as a stdin alternative and does not read a script from stdin on 5.1 (it echoes interactive prompts to stdout), so it is not usable.

### Testing

- `test/unit.mjs`: `buildArgv` for all three backends carries no raw script (bash gets `-ls`, PowerShell gets `-EncodedCommand`), the encoded payload round-trips the script exactly, and `buildStdin`/`spawnSpec` prove the script is a batch stdin write that is never `"ignore"` for bash.
- New `test/e2e.mjs`, included in `npm test`: mounts the real `LocalSubprocessRuntime` and drives the plugin's registered `shell` tool. A heredoc with quotes/`$`/backslashes/braces writes and reads back byte-for-byte in WSL foreground and background (the job's pull sources carry the output), same for Git Bash foreground, a bare `cat` exits on EOF, PowerShell runs multiline blocks and functions with quotes/`$` and clean stderr, and an 80 KB heredoc (beyond the old Windows command-line limit) hashes identical.
- `test/apply.mjs` mock-spawn assertions updated for the new argv and stdin dispositions, including the background spawn.
- `npm test` now runs `test/e2e.mjs` last.

## 0.6.0 (2026-10-16)

### Added

- **`terminal` action `ssh`: one login, many commands.** `{action: "ssh", sshHost:
  "second_brain"}` opens a session already logged in to a remote server, and every
  later `send` reuses that login, so remote work keeps its cwd, exported variables
  and shell state. Authentication stays interactive, so a password or 2FA prompt is
  answerable with `send` - something the one-shot `shell` tool can never do. The
  resulting session is reported as `ssh <host>` in `open` replies and in
  `terminal list`, and remote sessions get a longer idle window (30 min vs 10).
- **`sshShell` config (default `wsl`).** The backend that hosts ssh sessions is
  separate from `defaultShell` on purpose: ssh host aliases and keys live in the
  WSL `~/.ssh/config`, while `%USERPROFILE%\.ssh\config` is commonly empty, so
  `ssh <alias>` works in WSL and fails with "Could not resolve hostname" in
  PowerShell. Switching the everyday terminal to PowerShell no longer breaks remote
  work. An explicitly configured non-WSL backend is still honored, and the ssh action
  fails with an actionable message if WSL is unavailable.
- **The shell tool now points at the terminal tool.** Its description said "no state
  persists between calls" without saying what to do instead, and the system-prompt
  section told the model to use `shell` for terminal commands and never mentioned the
  session tool. Both now route stateful, interactive and multi-step remote work to
  `terminal`, which is what stops a model from doing multi-command server work as one
  `ssh host <command>` call per step.

### Fixed

- **`waitSettled` no longer returns instantly on an idle session - the reason remote
  work looked broken.** A session that was already quiet when the input was written is
  "quiet" by definition, so the silence test matched immediately and the reply carried
  the PREVIOUS command's output and nothing from the command just sent. Over ssh that
  read as "the command did nothing", and the model abandoned the session for one-shot
  calls. The wait is now anchored to the output position at entry: a reply is complete
  only once output has appeared after the write and then gone quiet, and a command that
  answers nothing within `awaitOutputMs` reports `waiting` instead of an empty result.
- **The settle loop could never time out against a producer that never pauses.** The
  cap check ran after the silence-window restart, so continuous output reset `last` on
  every poll and the loop never ended. It is checked first now.
- `waiting: true` is rendered into the tool result ("still producing output - read
  again before sending the next command"), so a truncated wait is visible to the model
  rather than looking like a finished command.
- Remote sessions get `TERM=xterm-256color` and drop `NO_COLOR`, so the far side
  colorizes and line-edits correctly; local sessions keep the `dumb` default.
- `ssh` runs behind an interactive LOCAL shell rather than as the top-level process:
  with ssh on top, SIGINT from the `signal` action interrupted the ssh client or the
  whole session instead of the remote foreground command, so Ctrl+C could not stop a
  runaway remote job.
- Destination validation accepts bracketed IPv6 literals and rejects a leading `-`, so
  a hostile destination cannot arrive as an ssh option (`-oProxyCommand=…`).
- `test/terminal.mjs` exits 0 again: node-pty's detached ConPTY console agent aborts
  with "AttachConsole failed" while the process tree is being torn down, which turned a
  fully green run into exit code 1 and broke the `&&` chain in `npm test`.
- `createTerminalRegistry` takes an optional PTY spawner, so tests can drive sessions
  deterministically on Windows instead of silently allocating real ConPTYs (the win32
  path bypasses `ctx.subprocess` by design).

### Testing

- New `test/settle.mjs`: the settle regression above (slow producer not mistaken for
  settled, cap expiring mid-stream, the idle-session anchor), plus the ssh action end
  to end against a fake PTY - backend selection independent of `defaultShell`, argv,
  startup input, remote `TERM`, `sshHost` in `list`, the `waiting` trailer, remote vs
  local idle windows, and destination validation.
- `test/unit.mjs` covers `validateSshHost`, `resolveSshShell` and `settleOptions`.
- New `scripts/verify-ssh-session.mjs`: a manual live check against a real host
  (same remote shell PID across commands, state surviving sends, Ctrl+C reaching the
  remote foreground process, clean logout, scratch directory removed). Not part of
  `npm test` - it needs a reachable host and credentials.
- CI runs `buffer.mjs`, `terminal.mjs` and `settle.mjs` too; `npm test` includes
  `settle.mjs`.

## 0.5.0 (2026-10-13)

- **Incremental terminal delivery (breaking for model-facing reads).** `terminal`
  used to re-send the whole session log on every send/read/signal, so the same
  output re-entered the context on every call (quadratic growth, and the model had
  to re-scan stale text to find the new lines). Sessions now keep an append-only
  ring addressed by ABSOLUTE character offsets that never shift when the ring drops
  its oldest text, and every reader (keyed by agent session id) owns a cursor:
  a reply carries only the output produced since that cursor, and the cursor
  advances only past text the reply actually carried, so a cap or a held-back tail
  can never lose output.
- Line framing: a reply stops at the last newline and reports the unterminated tail
  as `pending` (usually the prompt line), so nothing arrives as a torn line.
- A tail that renders to nothing (a bare control sequence on a fresh session) is
  no longer reported as `pending: ""` - an empty tail is no tail.
- Per-reply cap: 32 KB of UTF-8 bytes, paged with `more: true`; `from: 0`
  (or `full: true`) re-reads the whole retained log, `from: <nextOffset>` resumes an
  earlier position, `raw: true` returns the untouched stream. `nextOffset`, `more`,
  `elided`, and `pending` are rendered into the tool result, because that text is
  what the model sees.
- Rendering: delivered text is stripped of OSC/CSI/escape traffic and `\r` overwrites
  collapse to the surviving text (`raw: true` opts out).
- Byte-accurate accounting: the ring cap and the reply cap count UTF-8 bytes (the old
  `text.length` cap could hold 4x its nominal size in Cyrillic/CJK), the head/tail cut
  never splits a surrogate pair, and PTY chunks are decoded through a `StringDecoder`
  so a multi-byte character split between two reads is not corrupted into U+FFFD.
- The sticky `truncated` flag is gone: it latched on the first overflow and then lied
  on every later reply. `elided` reports how much of a request fell out of the ring,
  and only for that reply.
- A session the plugin terminates itself (`close`, `job_kill`, the idle timeout)
  settles its job as `killed` with the detail `session terminated`: node-pty reports
  our kill as signal 0 plus a Windows `STATUS_CONTROL_C_EXIT` exit code, which read
  as a natural exit with a nonsense code.
- A session whose shell exited on its own (or was killed by a job) now reports
  `exited: true` in `terminal list` and refuses `send`/`signal` with `terminal
  session has exited (exit code N): …` instead of silently writing into a dead PTY
  handle - which read to the model as "the command ran and printed nothing".
  `read` keeps serving the final output until the session is closed.
- **DSH 0.2.x jobs contract (3 fixes).** `jobs.start()` resolves an owner through the
  agent registry, so `owner` must be the session id: handing over the Agent object
  failed with `session "[object Object]" has no live agent`, which broke `terminal open`
  and `shell run_in_background` on 0.2.0-rc.2 (the PTY was already spawned, so the
  session leaked with no id ever returned).
- The terminal session's job now resolves `done` into `{ status, detail }`:
  `jobs.settle()` writes `outcome.status` straight into the record, and the raw PTY
  `{ exitCode, signal }` left the job "running" forever.
- Both jobs (terminal session and background shell) advertise `spec.output` pull
  sources with `read(fromByte)`, the only thing 0.2.x's pump reads: `job_output` now
  shows the stream instead of nothing. The producer's legacy `readOutput` hook is kept
  for hosts that still read it.
- Tests: `test/buffer.mjs` covers offsets, byte caps, surrogate safety, line framing,
  paging, rendering, reader isolation, and the job-facing shapes; `test/terminal.mjs`
  now drives real PTY sessions against the incremental contract (no duplication,
  `from: 0` re-read, `pending`, `raw`, and the job spec). Also fixed a pre-existing TDZ
  crash in `test/apply.mjs` (`makeAssembly` was used before its declaration).

## 0.4.0 (2026-10-05)

- **Adapted to DSH 0.2.x.** `SettingsProvider.register()` was removed in 0.2
  (the 0.2 provider exposes only `configure`/`describe`/`update`/`replace`/
  `mutate`), so the plugin's `ctx.settings.register(...)` call threw on load and
  the `shell` tool never registered. The plugin's own config is now its settings
  section: the row id is the namespace, the exported `Config` is the schema, and
  `defaultShell` is marked `.volatile()` so a change still re-renders the tool
  description without a restart. `Config.defaultShell` keeps the three-value
  enum, so an out-of-enum value is rejected at the settings boundary; a stale
  hand-edited value falls back to the resolved default instead of failing prompt
  assembly.
- **A volatile field is a live ref in 0.2.x, not a value.** Every field marked
  `.volatile()` reaches `apply()` as an object with `.get()`, so the plugin
  unwraps it on each read (`readDefaultShell()`); reading it as a plain value
  made `SHELLS.includes(...)` fail on the ref object and aborted `apply()`.
- **The Web UI settings row is disabled.** Its client half binds the client
  `settingsScope` service, removed in DSH 0.1.7-rc.2, and a client plugin that
  fails to load takes the whole Web GUI plugin list down with it. `dsh.client`
  and the `./client` export are therefore removed; the setting is edited through
  the plugin's own settings section, and `src/client.jsx` stays in the tree for
  a future port. Client-only peers (`dsh-client-store`, `dsh-client-locale`,
  `dsh-client-ui-settings`, `dsh-client-ui-slots`, `dsh-client-ui-primitives`,
  `react`) and `@deepseek-ai/dsh-settings` are dropped from `peerDependencies`.
- `peerDependencies` widened to `>=0.1.5-rc.1 <0.3.0` for every
  `@deepseek-ai/dsh-*` entry. DSH 0.2 refuses a plugin whose declared dsh peer
  ranges do not match the running runtime (prereleases participate in the
  match), so the previous `^0.1.5-rc.1` range excluded the whole 0.2 line.
- The Windows PTY fix from 0.3.15-patched.1 is unchanged and still required: the
  `shellEnv.collect()` seam is a curated shell set with no `SystemRoot`, and
  `wsl.exe` under ConPTY dies with `Wsl/Service/0x8007072c` without it.

## 0.3.15 (2026-09-11)

- **适配 DSH 0.1.5-rc.1**. 客户端模块表（`PLATFORM_MODULES`）把 `@deepseek-ai/dsh-client-runtime` 改名为 `@deepseek-ai/dsh-client-store`，并且只按**精确裸名**命中（没有 `/client` 子路径，也没有包工厂兜底）。客户端 bundle 原先 `require("@deepseek-ai/dsh-client-runtime/client")`，在 0.1.5 下必然 miss → Web GUI 启动报 `Failed to load plugins / require(...) missed the module table`。现改为 `@deepseek-ai/dsh-client-store`，bundle 的 4 个 require（`react`、`react/jsx-runtime`、`dsh-client-store`、`dsh-client-ui-primitives`）全部落在平台种子表内，不需要 `dsh.client.external`。
- `dsh.client.inject` 更新为 0.1.5 真实存在的客户端包名（`dsh-client-locale`、`dsh-client-ui-settings`、`dsh-api-remotes`）。
- 服务端 settings 接缝不再导出 `settingsNamespace()`（0.1.5 起 `register(ns: string, schema, { base })` 直接收命名空间字符串）；已同步去掉该包装，代码对 0.1.0/0.1.5 两代 API 都成立。
- `peerDependencies` 对齐 `^0.1.5-rc.1`（新增实际依赖的 `dsh-sandbox`，`cordis` 提到 `^4.0.2`）；client 测试新增回归断言：bundle 不得再出现 `dsh-client-runtime`。
- `install.ps1` 的 settings 白名单 patch 加了存在性探测：0.1.5 已无硬编码白名单，脚本不再为了无匹配的替换去重写宿主文件（那只会给它加个 BOM）。
- Git Bash 不再经 `ctx.sandbox.confine` 包装：DSH 的 Windows ACL 受限令牌 runner 与 Cygwin/MSYS2 不兼容（bash 启动时 `CreateFileMapping` Win32 error 5 直接终止），现在 Git Bash 在受限模式下也按不包装运行，结果报告 `enforcement: gitbash-unconfined`。修复 #6。

## 0.3.14 (2026-08-14)

- Settings row now mirrors the shipped EnterBehaviorRow exactly: row layout (title + tertiary description left, capsule selector right), 36px capsule trigger (`--dsw-alias-bg-module-platform`, 18px radius, hover state) with a chevron, `align="end"` portal Menu. CSS injected the same way as first-party rows.
- Removed the "(由你决定，AI 无法更改)" description phrase.

## 0.3.13 (2026-08-14)

- Settings row follows the shipped General-section row grammar (column stack, 1px bottom hairline via `--dsw-alias-border-l2`, 16px vertical padding, 14px/400 title) — matches the Appearance row's layout.

## 0.3.12 (2026-08-14)

- **User-facing native UI**: the Settings -> General "Default terminal" row now renders with DSH-native primitives (`Menu` + `Button` + `IconCodeOutline16`) instead of a plain HTML `<select>` — it looks and behaves exactly like a first-party setting. Client test renders the row through real React (renderToString) with mocked primitives.

## 0.3.11 (2026-08-14)

- `terminal` tool: WSL interactive on the default distro now uses `wsl -- bash -i` (plain `-e` fails under ConPTY with WSL service RPC 0x8007072c); explicit `-d <distro>` keeps `-e`. Verified: pwd -> /mnt/d/WorkSpace.
- CI fixes: wsl argv assertion uses SystemRoot (case-insensitive); client/terminal tests resolve react + node-pty cross-environment (CI installs them no-save); wsl interactive test tolerates environments without a distro.

## 0.3.10 (2026-08-14)

- install.ps1 migrates the profile to the official bundle install (adds `dsh-bash-terminal` to `dsh.profile.bundles` and removes the legacy manual insert), writing package.json without a UTF-8 BOM (PS 5.1 `Set-Content` BOM broke DSH's JSON.parse). Current web profile verified: bundle provides the `tool-bash-terminal` entry via `--dump-config`.

## 0.3.9 (2026-08-14)

- **Official bundle manifest**: the package now declares `dsh.bundle.patch` (ships its own `cordis.patch.yml`); a profile listing `dsh-bash-terminal` in `dsh.profile.bundles` auto-applies the mount — verified via a temp profile + `--dump-config` (entry appears without any manual profile patch).

## 0.3.8 (2026-08-14)

- Test coverage: `shell` background execution registers a job with working `cancel` / `done` / `readOutput` hooks (13 apply/execute cases total).

## 0.3.7 (2026-08-14)

- `terminal` tool: reads now wait for output to settle (quiet for 300ms, cap 5s) instead of a fixed delay, so `send` returns the COMPLETE reply (verified: full multi-line output, e.g. `seq 1 8`).

## 0.3.6 (2026-08-14)

- Test coverage: `terminal` open-with-initial-command (immediate execution in a fresh shell) and the job hooks shape (cancel / done / readOutput) verified against a real node-pty session.

## 0.3.5 (2026-08-14)

- `terminal` tool: buffer overflow is reported (`truncated` flag + "[terminal buffer overflowed; oldest output dropped]" notice) so a busy session never silently loses history.

## 0.3.4 (2026-08-14)

- `terminal` tool: WSL sessions now carry DSH_* environment variables via WSLENV, matching the `shell` tool.

## 0.3.3 (2026-08-14)

- `terminal` tool: new `list` action enumerates live sessions (sessionId / shell / pid) for multi-session management.

## 0.3.2 (2026-08-14)

- Session cap: at most 8 concurrent terminal sessions (fail-fast beyond).
- Multi-backend interactive verification: Git Bash (full), PowerShell 5.1 and wsl.exe documented ConPTY limits (0x8009001d / 0x8007072c; pwsh 7 and one-shot -lc work).
- README (zh/en): interactive-terminal known limits.

## 0.3.1 (2026-08-14)

- Terminal sessions register with the generic jobs registry (jobId on open; `job_kill` / `job_output` work on them).
- Idle timeout: sessions auto-close after 10 minutes without send/read/signal (configurable via `idleMs` on open) so abandoned PTYs never leak process trees.

## 0.3.0 (2026-08-14)

- **Interactive terminal tool (`terminal`)**: persistent PTY sessions over the official `ctx.subprocess.spawnTerminal` seam (node-pty). Actions: `open` / `send` / `read` / `signal` (Ctrl+C etc.) / `close`. Shell state (cwd, variables, aliases) persists across calls; the backend follows the user's default terminal setting. Verified with a real node-pty interactive Git Bash session (cd + pwd + echo + SIGINT + close).

## 0.2.3 (2026-08-14)

- Fail-closed test coverage (unavailable sandbox backend rejects the call).
- README sandbox documentation.
- GitHub Actions CI (unit / apply / client suites on windows-latest).

## 0.2.2 (2026-08-14)

- **Official denial rendering**: a confined call whose stderr matches the runner's denial signatures reports `sandbox.denied: true` and the model-facing output carries the exact official markers — `[sandbox: file access denied under <mode> mode]` plus the same-turn escalation hint.

## 0.2.1 (2026-08-14)

- **Official sandbox-escalation surface**: the `shell` tool now advertises `sandbox_permissions` / `justification` (the exact tool-bash / tool-pwsh contract): a denied call can be retried once with the narrowest wider mode, routed through `ctx.approval` (`approveEscalation`), with strict-widening validation.

## 0.2.0 (2026-08-14)

- **Sandbox integration (official seam)**: the `shell` tool resolves the DSH sandbox policy per call (`ctx.sandboxPolicy`) and confines PowerShell / Git Bash argv through `ctx.sandbox` — the same fail-closed `SandboxUnavailableError` semantics as the shipped executors. WSL runs unconfined (its Linux-VM isolation IS the sandbox). Sandbox facts (`sandbox.mode` / `sandbox.enforcement`) ride on foreground results.
- **Model preference**: the plugin's system-prompt section instructs agents to prefer the `shell` tool over `pwsh` for terminal commands; the tool description leads with the user-chosen default terminal.

## 0.1.0 (2026-08-14)

Initial release.

- `shell` tool: run commands through PowerShell / Git Bash / WSL on Windows.
- Default terminal is chosen by the user in the Web UI settings (Settings -> General -> Default terminal); the model cannot override it.
- Background execution via the generic jobs registry (`run_in_background` / `job_output` / `job_kill`).
- Client plugin registers the settings row; host plugin reads the user setting on every call.
- install.ps1: junction install, cordis.patch.yml mount, and automatic patch of the dsh-host-apiproxy settings allowlist (DSH limitation; see README).
