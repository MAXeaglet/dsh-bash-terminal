# DSH 插件开发沉淀（dsh-bash-terminal 实战）

从零开发一个交付级 DSH 插件（shell 三终端 + 沙箱 + 交互式 PTY + 原生设置 UI）的经验总结。
面向"下一个 DSH 插件开发者"，按"正确范式 → 关键机制 → 踩坑清单 → 测试/CI → 发布"组织。

---

## 一、DSH 插件架构（官方范式）

### 1. Bundle manifest（插件分发标准）

插件包声明 `dsh.bundle.patch`（指向包内 `cordis.patch.yml`），profile 在
`dsh.profile.bundles` 列出包名后 **DSH 自动应用挂载**，无需手改 profile 配置。

```json
// package.json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

```yaml
# cordis.patch.yml（包内，bundle 层）
- insert:
    - id: my-plugin
      name: my-plugin
```

安装：`dsh plugin --profile <p> add <pkg>`（或 profile bundles 手动加）。
**验证**：`dsh --profile <p> --dump-config` 看 entry 是否出现。

### 2. Host / Client 双面

- **Host 面**（`lib/index.js`）：服务端逻辑（工具注册、settings、subprocess）—— cordis 插件，`inject` 声明依赖，`apply(ctx, config)`。
- **Client 面**（浏览器）：`package.json` 声明 `dsh.client: { platform: "web" }` + `exports["./client"]`，源码打包成
  `window.__ModuleLoader__.load({ id, factory: (require) => ... })` 格式，host 通过
  `/plugins/<name>/client.js` 动态服务，浏览器端注入 `__DSH_BOOT__`。
- **共享模块**（浏览器 require 可用）：`react`、`react/jsx-runtime`、`react-dom`、
  `@deepseek-ai/cordis`、`dsh-client-runtime/client`、`dsh-client-ui-primitives`、
  `dsh-client-ui-slots` 等 —— 打包时 **external**（`esbuild --external:@deepseek-ai/* --external:react*`）。

### 3. 依赖注入规范

- `inject` 声明依赖（服务名：`tools`、`settings`、`subprocess`、`sandbox`、
  `sandboxPolicy`、`shellEnv`、`systemPrompt`、`jobs` 等）。
- 注册副作用用 `ctx.effect` 返回 disposer；无全局可变状态；进程派生走 `ctx.subprocess`。

---

## 二、关键机制

### 1. Settings（用户配置）

- 注册：`ctx.settings.register(settingsNamespace("ns"), z.object({...}), { base })`
- 读取：`scope.get()`（每次 update 后更新 resolved，无需 watch）
- ⚠️ **白名单限制**：Web 设置客户端只暴露 `dsh-host-apiproxy` 硬编码的 namespace 白名单
  （`WEB_SETTINGS_NAMESPACES` + 模型提供商）—— 第三方 namespace 写入被 `settings-not-exposed`
  拒绝。**workaround**：patch 该白名单（install.ps1 自动 + 备份）；治本等 DSH 上游支持
  （官方注释承认是 deferred work）。
- **原生设置行**：注册 `settings.general.item` slot（通用设置区）。**UI 必须照官方
  EnterBehaviorRow 语法**（不是凭感觉）：row 布局（标题+描述左、selector 右）、
  `border-bottom: 1px solid var(--dsw-alias-border-l2)`、16px padding、
  标题 14px/400 `label-primary`、描述 12px `label-tertiary`、胶囊 selector
  （`bg-module-platform` + 18px 圆角 + chevron 图标 + `align="end"` portal Menu）。
  CSS 用 `<style data-plugin-css>` 注入（与第一方行同构）。

### 2. Sandbox（沙箱接缝）

- `ctx.sandboxPolicy.resolve({ session })` → `{ mode, workspaceRoot, sessionId }`
- `ctx.sandbox.confine(argv, policy)` → `{ argv: [...runner, "--", ...argv], enforcement, denialSignatures, runnerFailureRules }`
- 语义：`danger-full-access` 不包装；受限模式 **fail-closed**（后端不可用抛
  `SandboxUnavailableError`，拒绝裸跑 —— 与官方 executor 一致）。
- 例外：Git Bash 因 Cygwin/MSYS2 与 Windows ACL 受限令牌不兼容（`CreateFileMapping`
  Win32 error 5），在本插件中与 WSL 一样不经过 `ctx.sandbox.confine` 包装；
  结果报告 `enforcement: gitbash-unconfined`。
- 升级契约：`sandbox_permissions`（enum `ESCALATION_TARGETS`）+ `justification`，
  经 `approveEscalation`（`ctx.approval`）严格宽化校验；被拒时渲染官方标记
  `[sandbox: file access denied under <mode> mode]` + 升级提示。
- Windows 后端 = ACL restricted-token launcher（`node-addon-landlock-run-win32-x64`）——
  可用时负责 PowerShell 的受限包装；Git Bash 因 Cygwin/MSYS2 不兼容保持不包装。

### 3. Subprocess / PTY

- `ctx.subprocess.spawn(spec)`：`{ argv, cwd, stdio, graceMs, signal, env }`，
  handle 有 `collected`（stdout/stderr 读取器）、`done`、`terminate()`。
- `ctx.subprocess.spawnTerminal(spec)`（node-pty/ConPTY）：`{ argv, cwd, env, rows, cols, graceMs }`
  → handle：`write(data)`、`output`（Readable）、`done`、`signalForeground(sig)`、
  `terminate()`。
- 交互式终端设计要点：会话注册进 jobs（`job_kill` 可管理）、**空闲超时自动关闭**
  （防 PTY 进程树泄漏）、缓冲上限 + 截断提示、settle 读取（等输出稳定返回完整回复）。

### 4. Jobs（后台任务）

`jobs.start({ kind, label, owner, run: () => ({ cancel?, done, readOutput? }) })` → jobId。
`done` 是 Promise<JobOutcome>；`readOutput` 增量读。工具 `run_in_background` 参数即此。

---

## 三、踩坑清单（血泪）

1. **npm install 会清空 junction 目标**！在插件项目跑 `npm install` 时，npm 递归清理了
   `node_modules/@deepseek-ai` junction 指向的 **profile 依赖树**（195 个包全没）。
   恢复：profiles 是 pnpm hoisted 布局，`@deepseek-ai` 应为**真实目录 + 逐包 junction**
   到 dsh 包（不是整目录 junction，DSH 启动会校验 symlink）。**教训：插件项目依赖用
   junction 时，绝不在该项目跑 npm install（用 npm pack 验证产物）**。
2. **PowerShell 5.1 `Set-Content -Encoding UTF8` 写 BOM** → DSH 的 JSON.parse 崩溃
   （`Unexpected token '﻿'`）。改 profile package.json 必须无 BOM
   （`[System.IO.File]::WriteAllText($p, $json, (New-Object System.Text.UTF8Encoding($false)))`）。
3. **Windows ConPTY 兼容性**：
   - Windows PowerShell 5.1 在某些受限环境无法在 ConPTY 启动（0x8009001d，证书类错误）——
     可能是环境特殊而非普遍；普通用户机器大概率正常（需实测确认）。
   - `wsl -e bash -i`（默认发行版）在 ConPTY 下失败（Wsl/Service/0x8007072c，RPC 句柄
     类型不匹配）→ 改用 `wsl -- bash -i` 即正常；显式 `-d <distro>` 时 `-e` 正常。
   - `AttachConsole failed` 是 node-pty 在非控制台宿主的清理钩子噪声，不影响功能。
4. **`defineStore(decl)` 返回 `{ spec, create }`**，不是 store！真正 store（含 actions）
   由 `slots.register` 内部 `create()` 生成 —— 在 `inject` 回调里绑定 actions 并
   push 初始快照（theme 行模式）。
5. **测试断言路径大小写**：CI（windows-latest）的 `SystemRoot` 是 `C:\Windows`，
   本机可能是 `C:\WINDOWS` —— 断言必须动态取 `process.env.SystemRoot`，别硬编码。
6. **client/terminal 测试跨环境模块解析**：本机 react/node-pty 在 profile 依赖树，
   CI 没有 → 双路径解析（`createRequire(import.meta.url)` 优先，profile fallback），
   CI workflow 用 `npm install react react-dom node-pty --no-save`。
7. **run_code 模板字符串转义**：往文件写含 `\r`/`\n`/反引号的内容时，外层模板会
   提前解析（`\r` 变真实 CR → JS 源码语法错；反引号需转义）。用数组 join 或
   仔细转义。
8. **React 组件测试**：直接调用组件函数会触发 hook 违规（`useState` 在渲染器外）。
   用 `react-dom/server` 的 `renderToString(createElement(Component, props))`。

---

## 四、测试与 CI

- 套件：unit（纯函数）、apply（mock ctx 集成）、client（__ModuleLoader__ 模拟 + 真实
  React 渲染）、terminal（**真实 node-pty** 交互会话）。
- 环境相关测试宽容处理（PowerShell 5.1 / wsl 无发行版时 NOTE 跳过而非失败）。
- CI：windows-latest + `npm install react react-dom node-pty --no-save` +
  `node scripts/build-client.mjs`（先 build client 再跑 client 测试）。

---

## 五、发布

```powershell
node scripts/build-client.mjs          # 重建 client bundle
npm pack --dry-run                     # 检查内容（lib/dist/src/cordis.patch.yml/README/LICENSE）
npm publish --otp <验证码>              # 2FA 账号需要
git tag v<version> && git push origin v<version>
```

---

## 六、设计原则（对照 DSH 15 条）

- 依赖走 `inject`；副作用 `ctx.effect` 返回 disposer；无全局可变状态；
  能力封装成 seam（消费官方 `ctx.sandbox`/`ctx.subprocess`/`ctx.jobs` 而非重造）；
  外部副作用（进程）有逆（terminate/teardown）。
- **侵入性边界**：插件 = 独立可卸载的 bundle 增量，不替换官方 `ctx.shell` provider
  （tool-pwsh 是 PowerShell 专用消费者，替换会破坏契约）、不禁用官方工具 ——
  "原生"是融入而不破坏。
