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
npm test                               # unit / apply / client / terminal 四套（走宿主的 0.1.5-rc.1 包）
dsh --profile web --dump-config | Select-String dsh-bash-terminal   # 组合树
```

浏览器侧验证：刷新 `http://127.0.0.1:3080`，启动遮罩不再出现 `Failed to load plugins`，
且 设置 → 通用 中「默认终端」行可读可写。

---

## 2026-10-17：适配 DSH 0.2.x（0.2.0-rc.2 / 0.2.1-alpha.2）

> 承接 PR #12（设置接缝迁到 0.2.0）与 issue #13（peer 声明），补上 0.2.x 的运行时修复与兼容声明。

### 症状

0.2.1-alpha.2 上，`shell` 工具用默认 Git Bash 正常；但**受限模式（read-only / workspace-write）+ PowerShell**
的调用全部失败：`ctx.sandbox.confine(...)` 返回 Promise，`confined.argv` 为 `undefined`，随后
`ctx.subprocess.spawn` 收到非法 argv 抛错。

### 根因

0.2.x 的 `@deepseek-ai/dsh-sandbox-local` 里 `LocalSandboxProvider.confine(argv, policy, signal)` 是
`async` 方法（返回 `Promise<{ argv, enforcement, denialSignatures, runnerFailureRules }>`），
`confineSpawn()` 却按同步返回值使用。**0.2.0-rc.2 上就已如此**——只是 Git Bash/WSL 不包装、
默认终端又是 Git Bash，受限 PowerShell 这条路径从未被走到。

### 改动

| 位置 | 改动 |
|------|------|
| `lib/index.js` | `confineSpawn()` 改为 `async`；`await ctx.sandbox.confine(...)`；调用点 `await confineSpawn(...)`。`await` 对 0.1.x 的同步返回值无副作用。 |
| `package.json` | DSH `peerDependencies` 从 `^0.1.5-rc.1` → `^0.2.0-rc.2`（= `>=0.2.0-rc.2 <0.3.0-0`）：0.2.0-rc.2 与 0.2.1-alpha.2 均满足，**不再需要精确版本豁免**；0.1.x 不再声明支持。 |
| `test/apply.mjs` | `ctx.sandbox.confine` mock 改为 async（漏 `await` 立即失败）；settings mock 换成 0.2.x 的 `ctx.fiber.config`（volatile `{ get() }` 持有者）。 |
| `test/client.mjs` | 重写为 0.2.x 客户端接缝：mock `locale` / `configForms.whileServed` / keyed `slots`；断言 `plugins.row.config`（key `dsh-bash-terminal#tool-bash-terminal`) 与 `plugins.bundle.config`（key `dsh-bash-terminal`）；新增回归断言 bundle 不得包含 `settingsScope`。 |
| `README*.md` / `CHANGELOG.md` | 兼容性段落改为 0.2.x；注明 0.2.x 不再需要 `install.ps1` 的 settings 白名单 patch。 |

### 验证

| 检查 | 结果 |
|------|------|
| 四套测试（unit / apply / client / terminal） | 通过；terminal 为真实 node-pty 交互会话 |
| 0.2.1-alpha.2 实机（DSH NEXT 2.0.18-next，Windows 11） | 插件装配 active，`shell` / `terminal` 工具注册，Git Bash 后端执行正常 |
| 反向验证 | 去掉两处 `await` → `node test/apply.mjs` 立即以非法 argv 失败；恢复后通过 |
| 0.2.0-rc.2 | 见 PR #12 的验证表（当时默认 Git Bash，受限 PowerShell 路径未覆盖） |
| 受限 PowerShell 路径 | 由 async-mock 单测覆盖；未在真实 ACL runner 下回归（本机既有沙箱限制） |

---

## 2026-10-18：后台 job 的 owner 与输出源（DSH 0.2.1-rc.2）

> 补齐 `shell` 工具 `run_in_background: true` 这条路径在 0.2.1 上的两处失效。

### 症状

1. 后台任务创建即失败：`session "[object Object]" has no live agent`。
2. 修掉 owner 后任务能跑完，但 `job_output` 始终为空（`completed` 却读不到 stdout/stderr）。

### 根因

1. `@deepseek-ai/dsh-jobs-local` 的 `JobRegistry.start()` 把 `owner` 当作**会话 id**，
   通过 `ctx.agents.get(id)` 解析；官方 `dsh-tool-bash` / `dsh-tool-pwsh` 传的是 `exec.agent.id`。
   本插件传了 Agent 对象，于是每个后台任务都在注册期失败。
2. 0.2.x 的 jobs 改为**拉取式输出**：registry 按绝对偏移轮询 `spec.output` 里的 pull 源；
   旧的 `run()` 返回值里的 `readOutput` 钩子不再被读取。插件只提供了后者，所以输出永远空。

### 改动

| 位置 | 改动 |
|------|------|
| `lib/index.js` | `jobs.start({ owner: exec.agent.id })`；`proc` 增加非消费式 `readStream(channel, offset)` 与 `spawnErrorText()`；新增 `backgroundSources(live)` 生成 stdout/stderr 两个 pull 源，`jobs.start({ output })` 里懒绑定 `live.proc`（进程在 `run()` 内才 spawn）；`internals.backgroundSources` 暴露给测试 |
| `test/apply.mjs` | 后台用例新增回归断言：`owner` 必须是 agent id（不是对象）；`spec.output` 必须是 `[stdout, stderr]` 两个源，`read(0)` 返回文本并前进 `nextOffset` |

### 验证

| 检查 | 结果 |
|------|------|
| `node test/unit.mjs` / `apply.mjs` / `client.mjs` / `terminal.mjs` | 四套全过（terminal 为真实 node-pty 会话） |
| 实机（DSH NEXT 2.0.1-rc.2 / rc.3，Git Bash） | 后台任务 stdout 与 `[stderr]` 分离呈现，状态 `completed`、退出码 0；`job_output` 不再是空 |
| 反向观察 | 修复前同一命令：任务 completed 但输出为空；owner 未改时任务注册即报 no live agent |
