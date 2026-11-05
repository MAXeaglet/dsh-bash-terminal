# dsh-bash-terminal × DSH 兼容性（0.1.5-rc.1 适配记录）

> 本文档记录 **2026-09-11 对 DSH 0.1.5-rc.1 的适配**，取代此前基于 0.1.1-rc.2 / 0.1.2-alpha.1 的评估。

## 环境

- 本机运行的 DSH：`@deepseek-ai/dsh@0.1.5-rc.1`（`dsh web`，pnpm 全局安装；前端 `@deepseek-ai/dsh-web-frontend@0.1.5-rc.1`）。
- 插件安装方式：junction `%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-bash-terminal` → `D:\WorkSpace\projects\dsh-bash-terminal`。
- 插件版本：0.3.15（本次适配后）。

## 症状

Web GUI 启动时报：

```
Failed to load plugins
failed to import loader entry f7933cfe (dsh-bash-terminal):
client-modules: require("@deepseek-ai/dsh-client-runtime/client") missed the module table
— not a platform seed word, not a materialized module, and no registered package factory
(a build-time externals drift, or a dynamic dependency that did not arrive)
```

## 根因

0.1.5 的浏览器模块表（壳层 `My()` → `ClientModuleSystem.staticModules`，即 `PLATFORM_MODULES`）**精确**为：

```js
react, react/jsx-runtime, react-dom, react-dom/client,
@deepseek-ai/cordis,
@deepseek-ai/dsh-client-store,          // ← 0.1.5 由 dsh-client-runtime 改名而来
@deepseek-ai/dsh-client-ui-slots,
@deepseek-ai/dsh-client-ui-primitives,
@deepseek-ai/dsh-client-ui-dockkit
```

两条规则叠加导致必然失败：

1. 种子词**只按精确裸名**命中（`makeRequire` 先 `seed.has(spec)`）；`stripClientSuffix`
   只对 boot graph 里的动态包行生效，对种子词不生效 —— 所以 `...@deepseek-ai/dsh-client-store/client`
   也不命中。
2. 旧名 `dsh-client-runtime` 在 0.1.5 已不存在（既不在种子表，也不是 boot graph 的包行，
   也没有已注册的工厂）→ `require` 抛上面的错误。

## 本次改动

| 位置 | 改动 |
|------|------|
| `src/client.jsx` | `import { defineStore } from "@deepseek-ai/dsh-client-runtime/client"` → `"@deepseek-ai/dsh-client-store"` |
| `lib/client.js` / `dist/client.js` | `node scripts/build-client.mjs` 重建（4 个 require 全部命中种子表，无需 `dsh.client.external`） |
| `package.json` `dsh.client.inject` | `[...dsh-client-runtime, dsh-client-locale, dsh-client-ui-settings, dsh-client-ui-slots]` → `[dsh-client-locale, dsh-client-ui-settings, dsh-api-remotes]`（`inject` 在 0.1.5 是**包级依赖边**；种子词/不存在的包会被 `arriveGraphRow` 静默忽略，但仍应写真实存在的包行） |
| `package.json` `peerDependencies` | 全部对齐 `^0.1.5-rc.1`；补上实际用到的 `@deepseek-ai/dsh-sandbox`；`cordis` → `^4.0.2`；`dsh-client-runtime` → `dsh-client-store` |
| `lib/index.js` | `ctx.settings.register(settingsNamespace("bash-terminal"), …)` → `ctx.settings.register("bash-terminal", …)`（0.1.5 的 `dsh-settings` 不再导出 `settingsNamespace`） |
| `test/client.mjs` | mock 改用 `@deepseek-ai/dsh-client-store`，并加回归断言：bundle 不得再出现 `dsh-client-runtime` |
| `node_modules/@deepseek-ai` | 重新指回 junction → `%USERPROFILE%\.dsh\profiles\node_modules\@deepseek-ai`（此前被 `npm install` 覆盖为插件私有副本，停在 0.1.0-rc.6，造成"插件跑旧 API、宿主是新版"的双份实例） |

## 0.1.5 仍然兼容的部分（已核对）

- 服务端：`dsh-tools`(`defineTool`/`TOOL_ABORTED`)、`dsh-sandbox`(`ESCALATION_TARGETS`/`approveEscalation`/
  `escalationHintMarker`/`sandboxDenialMarker`/`validateEscalationArgs`)、`dsh-llm`(`HarnessError`)、
  `dsh-shell`(`parseExitStatus`)、`dsh-timeout`(`MAX_TIMER_DELAY_MS`/`clampTimeout`/`deadline`/`timeoutOf`)
  同名导出齐全（宿主 0.1.5-rc.1 实测）。
- `ctx.subprocess.spawn` / `spawnTerminal`、`ctx.jobs`、`ctx.sandbox.confine`、
  `ctx.sandboxPolicy.resolve`、`ctx.shellEnv.collect`、`ctx.systemPrompt.section` 均在。
- 客户端：`settings.general.item` slot（`dsh-client-ui-settings` 的 slot 契约）形状未变；
  `ctx.settingsScope.bind({ namespace })` 快照仍是 `{ status, value, revision, writable, … }`；
  `defineStore({ init, actions })` 形状未变（与官方 `ui-theme` 行逐字一致）；
  `@deepseek-ai/dsh-client-ui-primitives` 仍导出 `Menu` / `IconChevronDownOutline14`。
- 设置白名单：0.1.5 走 `settings.describe()` 动态枚举，**没有** `settings-not-exposed` 限制
  （`install.ps1` 的白名单 patch 已成历史遗留）。

## 复现/验证命令

```powershell
cd D:\WorkSpace\projects\dsh-bash-terminal
node scripts/build-client.mjs          # 重建 bundle
npm test                               # unit / apply / buffer / terminal / settle / e2e（走宿主的 0.1.5-rc.1 包）
dsh --profile web --dump-config | Select-String dsh-bash-terminal   # 组合树
```

浏览器侧验证：刷新 `http://127.0.0.1:3080`，启动遮罩不再出现 `Failed to load plugins`，
且 设置 → 通用 中「默认终端」行可读可写。


---

# DSH 0.2.x adaptation (2026-10-05)

Supersedes the 0.1.5-rc.1 assessment above for the 0.2 line.

## Verified against

- `@deepseek-ai/dsh@0.2.0-rc.2`, installed from npm on Ubuntu (WSL2), Node 24.20.0.
- Gate behaviour read from `packages/boot/app-boot/src/plugin-compatibility.ts`
  (tag `dsh-v0.2.1-alpha.1`): only `peerDependencies` named `@deepseek-ai/dsh` or
  `@deepseek-ai/dsh-*` are checked, with `semver.satisfies(runtime, range, { includePrerelease: true })`.
  `engines.dsh` is **not** read; `dsh.manifestVersion` is not validated; a plugin
  with no `peerDependencies` at all skips the check entirely. An incompatible
  bundle is skipped at profile load (the profile still boots) and refused at
  install time.

## Removed APIs this plugin used

| API | Where | 0.2 status |
|---|---|---|
| `SettingsProvider.register(ns, schema, { base })` | `lib/index.js` | removed — 0.2 exposes `configure`/`describe`/`update`/`replace`/`mutate` |
| client `settingsScope` service | `lib/client.js`, `src/client.jsx` | removed in 0.1.7-rc.2 |

## Replacement

In 0.2 a plugin's config **is** its settings section: the profile row id is the
namespace and the exported `Config` is the schema. Fields marked `.volatile()`
are editable without remounting the plugin, and each volatile field arrives at
`apply()` as a live ref exposing `.get()` — nested objects and array elements
included. `lib/index.js` therefore reads `config.defaultShell` through
`readDefaultShell()` on every use, which is also what keeps the
`system-prompt/assemble` description refresh working.

## Still required on 0.2.x

- The `SystemRoot` PTY fix (0.3.15-patched.1). `ctx.shellEnv.collect()` is
  unchanged in 0.2 and still returns only curated shell keys.
- Windows only: `apply()` returns early when `process.platform !== "win32"`, so
  this plugin cannot be exercised on Linux, including in a WSL staging bench.

## `ctx.jobs` contract (0.2.x) — verified against `dsh-jobs-local@0.2.0-rc.2`

The terminal session and the background `shell` job both register with the job
registry. Three details changed in 0.2, and each one failed until 0.5.0:

| Fact (0.2.0-rc.2) | Source | Consequence when violated |
|---|---|---|
| `owner` is the **session id**: `start()` calls `resolveOwner(spec.owner)` → `agents.get(session)` | `dsh-jobs-local/lib/index.js:413,528-535` | passing the Agent object threw `session "[object Object]" has no live agent`, so `terminal open` and `shell run_in_background` died **after** the PTY was spawned (session leaked, no id ever returned) |
| `spec.run(handle)` must return `{ cancel, done }` with `done` resolving `{ status, detail }` | `dsh-jobs-local/lib/index.js:437,448,736-739` | `settle()` writes `outcome.status` straight into the record; a raw PTY `{ exitCode, signal }` left the job "running" forever |
| `spec.output` is an array of pull sources `{ channel, read(fromByte) → { text, nextOffset, lossy } }`, polled every 150 ms | `dsh-jobs-local/lib/index.js:119-137,479-486`; reference implementation `dsh-tool-bash/lib/index.js:66-79,399` | without it `job_output` shows nothing: 0.2's pump never calls the producer's own `readOutput` hook |

`dsh-tool-jobs` renders every channel except `stderr` as stdout and drops
`channel: "log"` entirely, which is why the terminal session source reports
`channel: "stdout"`.

`test/jobs-contract.mjs` feeds that exact spec shape into the **real** registry
(`node test/jobs-contract.mjs`, run where the DSH `@deepseek-ai/*` tree is
resolvable) and asserts three things in one pass: the job is admitted for a
session-id owner, the pump carries the source text into `read()` chunks, and
the producer's `done` settles the record as `completed` instead of leaving it
"running" forever.

## Shell script transport (0.6.1) — verified against `dsh-subprocess-local@0.2.2-rc.1`

The `shell` tool no longer passes the command text as one argv element. On Windows
that route crosses `CreateProcess` (32,767-character command-line limit) and, for
WSL, the `wsl.exe` argument bridge a second time; heredoc terminators/quotes could
be re-parsed, and a truncated script could leave `cat` reading stdin forever.

| Backend | Invocation | Script delivery |
|---|---|---|
| `wsl` | `wsl [-d <distro>] -e bash -ls` | `stdio.stdin = { data: "<script>\n" }` |
| `gitbash` | `<Git>\bin\bash.exe -ls` | `stdio.stdin = { data: "<script>\n" }` |
| `powershell` | `pwsh -NoLogo -NoProfile -NonInteractive -EncodedCommand <base64>` | argv, UTF-16LE, `$ProgressPreference = 'SilentlyContinue';` prefix |

The seam's batch shape is what guarantees no open stdin survives:
`dsh-subprocess` defines `{ data }` as "writes the bytes and closes", and
`dsh-subprocess-local/lib/runner-launch-*.js` implements it with `stdin.end(data)`.
A command that reads stdin (`cat`, `read`) therefore sees EOF immediately, in
foreground and background alike; `job_kill` is no longer implicated in breaking a
stdin wait because there is nothing to wait on.

The login flag is preserved (`-l`): `bash -lc '<probe>'` and `bash -ls` with the
probe on stdin print the same `PWD` and identical `PATH` for Git Bash and WSL
(checked on this machine), so `git`, `node`, etc. resolve as before.

PowerShell note: Windows PowerShell 5.1 emits its "Preparing modules for first
use" progress record as a CLIXML blob on stderr for `-EncodedCommand` invocations.
Prefixing the encoded script with `$ProgressPreference = 'SilentlyContinue';`
suppresses it; the prefix shares line 1, so later error line numbers stay
accurate. On pwsh 7 the prefix is a harmless no-op.

Windows PowerShell 5.1 also serializes **cmdlet error records** on stderr as
CLIXML under `-EncodedCommand` (a host-side quirk tracked upstream as
[PowerShell/PowerShell#16678](https://github.com/PowerShell/PowerShell/issues/16678)):
the text is intact inside `<S S="Error">` but is not the plain `-Command`
format. Native program stderr (`git`, `node`, `cmd`, ...) is passed through
unchanged, and exit codes are identical to `-Command` (`exit N` → N, a failing
last statement → 1, a terminating error → 1). The reason for accepting this is
the alternative: `-Command <script>` is exactly the argv route this release
removes, and `-File -` does not read a script from stdin on 5.1 (it echoes
interactive prompts to stdout), so `-EncodedCommand` is the only tested way to
keep PowerShell's exit-code semantics without putting the script in argv.

## Live ssh session check (manual — needs a real host)

`node scripts/verify-ssh-session.mjs [sshHost]` drives the plugin's own ssh
action against a real server and asserts the properties that make a session
worth having. It is deliberately outside `npm test` (a host and credentials are
required) and it only creates and removes its own scratch directory under
`/tmp` — no services are touched.

Verified on 2026-10-16 against `second_brain` (Ubuntu 26.04.1, `wsl` backend):

| Property | Observed |
|---|---|
| ssh session backend | `wsl`, session reported with `sshHost: "second_brain"` |
| one login, many commands | remote `$$` **identical** across sends (`1695997`) — one shell, not one per command |
| state survives | exported `DSH_MARK` and `cwd` still set in later commands |
| Ctrl+C reaches the remote job | `^C` echoed, session usable afterwards |
| cleanup | scratch dir removed, `who` empty, no leftover processes |
| logout | `Connection to 178.217.99.183 closed.` |

Machine-specific facts that shaped the design:

- ssh config lives at **`/home/igor/.ssh/config` inside WSL** (hosts:
  `second_brain`, `singapore`, `vdsina_2g`), while
  `C:\Users\igroc\.ssh\config` is a **0-byte file**. `ssh second_brain` therefore
  resolves in WSL and fails from PowerShell with `Could not resolve hostname` —
  hence `sshShell` defaults to `wsl` independently of `defaultShell`.
- The one-shot `shell` tool *can* run `ssh -o BatchMode=yes host '<cmd>'`, which is
  exactly why the model kept doing that: it is a valid pattern for a single
  command and loses cwd/variables for anything longer. Only the session tool keeps
  state, and only the session tool can answer an interactive prompt.
- **Always end `send` input with `\r`**, not `\n`. A PTY wants `\r`; with `\n` the
  command may still run, but `waitSettled` then returns before the reply arrives and
  the model gets an empty result for that step.
- A brief `send` reply is expected when a command legitimately prints nothing (or is
  still thinking): the answer is `read` again, and `waiting: true` says so.

## Environment notes (this machine)

- The DSH install carries `node-pty@1.2.0-beta.15` under
  `@deepseek-ai/dsh/node_modules`, whose `spawn()` returns **`pid: 0`** on
  Windows; the plugin's own dependency (`node-pty@^1.1.0`, resolved from the
  profile) returns a real pid. If the plugin ever resolves the DSH copy,
  `open`/`list` will report pid 0.
- Running the tests in the project dir needs `node_modules` there: junction
  `@deepseek-ai` → `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai`
  and `node-pty` → `<profile>\node_modules\node-pty` (the profile's 1.1.0, not
  the DSH copy — see above).
