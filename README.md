# dsh-bash-terminal

> 🌐 [English](README.en.md) · 社区交流：[LINUX DO](https://linux.do) · [GitHub](https://github.com/MAXeaglet/dsh-bash-terminal)

![test](https://github.com/MAXeaglet/dsh-bash-terminal/actions/workflows/test.yml/badge.svg)

DSH（DeepSeek Harness）插件：一个 `shell` 工具，在 Windows 上统一执行 **PowerShell / Git Bash / WSL** 三种终端命令。

| 后端 | 实际执行 | 语法 / 路径 | 环境变量 |
|------|----------|-------------|----------|
| `powershell`（默认） | `pwsh -NoLogo -NoProfile -NonInteractive -Command <cmd>` | PowerShell；`C:\...` | `$env:NAME` |
| `gitbash` | Git for Windows `bash -lc <cmd>` | POSIX；`/d/WorkSpace`；PATH 含 `/usr/bin`、`/mingw64/bin` | `$NAME` |
| `wsl` | `wsl [-d <distro>] -e bash -lc <cmd>` | Linux；`/mnt/d/...` | `$NAME`（经 WSLENV） |

每次调用都启动全新 shell：**不保留状态**（cwd / 变量 / 别名）——请传 `workdir` 而不是用 `cd`。

## 设计要点

- **终端由用户决定，AI 无法更改**：Web UI 设置页（设置 → 插件 → dsh-bash-terminal）出现“默认终端”选择器（PowerShell / Git Bash / WSL）；`shell` 工具永远只使用该设置，不暴露终端参数给模型。设置持久化在 profile 的 `cordis.patch.yml`（0.2.x 的 Config 文档）。
- **不占用 `ctx.shell` 能力接缝**：DSH 自带的沙箱化 `pwsh` 工具保持原样可用；本插件的 `shell` 工具是**额外的**多终端入口。
- 通过共享的 `ctx.subprocess` seam 派生进程：进程树终止（Windows `taskkill /T`）、SIGTERM→grace→SIGKILL、输出 spill 文件，与官方 `dsh-tool-bash` / `dsh-tool-pwsh` 行为一致。
- 后台任务注册进通用 `jobs` registry，支持 `run_in_background` / `job_output` / `job_kill`。
- 前端设置页的「默认终端」是枚举（UI 自动渲染为下拉），模型每次调用都只按该设置执行，无法自行切换终端。

## 安装（web profile）

### 标准安装（npm 发布后，官方 bundle 机制）

插件带官方 `dsh.bundle` manifest（包内 `cordis.patch.yml`），profile 列出本包时 DSH **自动应用挂载**，无需手改 profile 配置：

```powershell
# 1. 安装插件包
npm install -g dsh-bash-terminal
dsh plugin --profile web add dsh-bash-terminal   # 自动加进 profile 的 bundles 并应用 patch

# 2. 重启 dsh web
```

> 0.2.x 不需要再跑 `install.ps1` 的 settings 白名单 patch：设置面已改为插件自己的 Config schema
> （Web UI 在「设置 → 插件 → dsh-bash-terminal」渲染「默认终端」选择器），旧的
> `settings-not-exposed` 白名单机制不复存在。`install.ps1` 只为 0.1.x 老宿主保留。

> 已用临时 profile 实测：`bundles: [dsh-bash-terminal]` → dump-config 自动出现 `tool-bash-terminal` entry。

### 本地开发安装（junction 直连，改源码即时生效）

```powershell
# 1. 链接插件包到 profile 的 node_modules（junction，改源码即时生效）
$profile = "$env:USERPROFILE\.dsh\profiles\web"
New-Item -ItemType Junction -Path "$profile\node_modules\dsh-bash-terminal" -Target "D:\WorkSpace\projects\dsh-bash-terminal" | Out-Null

# 2. 让插件能解析 @deepseek-ai/* 依赖（junction 到 profile 的依赖树，插件与宿主共用同一份模块实例）
New-Item -ItemType Junction -Path "D:\WorkSpace\projects\dsh-bash-terminal\node_modules\@deepseek-ai" -Target "$profile\..\node_modules\@deepseek-ai" | Out-Null

# 3. 让 profile 通过官方 bundle 挂载插件：在 dsh.profile.bundles 加 "dsh-bash-terminal"（0.2.x 不需要 install.ps1）
# 4. （仅修改前端源码后）重新打包 client bundle:
#    cd D:\WorkSpace\projects\dsh-bash-terminal && node scripts/build-client.mjs
# 5. 重启 dsh web
```

> ⚠️ **不要在本项目里跑 `npm install`**：它会删掉上面第 2 步的 junction，转而给插件装一份**独立的**
> `@deepseek-ai/*` 副本 —— 插件和宿主就不再共用模块实例，宿主升级后插件会停在旧 API 上
> （本项目曾因此停在 0.1.0-rc.6）。只刷新 lock 时用 `npm install --package-lock-only`。

> **兼容性**：要求 DSH **0.2.x**（已在 **0.2.0-rc.2** 与 **0.2.1-alpha.2** 实测）。0.2.0 起设置面改为
> 「插件自己的 Config schema + `configForms` / keyed slot 注册」：旧的 `ctx.settings.register()`、
> `settingsScope` 和 `settings.general.item` 都已移除，本插件的宿主/客户端两半均已改写；
> `peerDependencies` 声明 `^0.2.0-rc.2`，满足时 DSH 直接安装/装配，**不再需要精确版本豁免**。
>
> 注意：0.2.x 的 `ctx.sandbox.confine()` 是 **async**（返回 `Promise<{ argv, enforcement, … }>`）。
> 受限模式（read-only / workspace-write）下的 PowerShell 必须 `await` 之后才拿得到 argv，
> 否则会以非法 argv 失败——这个问题在 0.2.0-rc.2 上就已存在，只是因为 Git Bash 后端不包装、
> 多数人用不到受限 PowerShell 才没暴露。本版本已修复。
>
> 仍停留在 0.1.x 的用户请继续使用 0.3.15 及更早版本；本版本不再声明兼容 0.1.x。

> 当前已不再需要手动改 profile 的 `cordis.patch.yml`：插件包内自带 `dsh.bundle.patch`（包内 `cordis.patch.yml`），只要 profile 的 `dsh.profile.bundles` 里有 `dsh-bash-terminal`，DSH 就会自动挂载。

验证组合树（无需重启）：

```powershell
node "$env:APPDATA\nvm\v24.16.0\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile web --dump-config | Select-String dsh-bash-terminal
```

## 使用

**用户在 Web UI 设置默认终端**：打开设置（齿轮）→ 通用 →「默认终端」下拉，选择 PowerShell / Git Bash / WSL 之一。改动即时生效并持久化。

模型看到 `shell` 工具后，执行命令时自动使用你选择的终端（工具不暴露终端参数，模型无法更改你的选择）：

- 默认终端 = Git Bash 时：`shell(command: "git status")` 走 Git Bash
- 默认终端 = WSL 时：`shell(command: "ls -la /mnt/d/WorkSpace")` 走 WSL；传 `distro: "Ubuntu"` 可指定发行版
- 默认终端 = PowerShell 时：`shell(command: "Get-Process node")` 走 PowerShell

## 模型使用示例

- 一次性命令（默认终端）：`shell(command: "git status", description: "查看 git 状态")`
- 跨轮保持状态（交互式）：`terminal(action: "open")` → 记下 `sessionId` → `terminal(action: "send", sessionId, input: "cd /d/project\n")` → `terminal(action: "send", sessionId, input: "npm run dev\n")` → `terminal(action: "close", sessionId)`
- 中断正在运行的程序：`terminal(action: "signal", sessionId, signal: "SIGINT")`
- 查看活动会话：`terminal(action: "list")`
- 沙箱拒绝后升级：`shell(command: ..., sandbox_permissions: "workspace-write", justification: "...")`

## 配置

**Web UI 设置**（推荐）：设置 → 通用 →「默认终端」。

插件 row 的 `config`（覆盖默认，作为设置的 composition 基准）：

| 键 | 默认 | 说明 |
|----|------|------|
| `defaultShell` | `powershell` | 设置未覆盖时的后端 |
| `timeoutMs` | 120000 | 默认超时 |
| `maxTimeoutMs` | 600000 | 调用方 timeoutMs 上限 |
| `pwshPath` | 自动探测 | 固定 pwsh.exe 路径 |
| `gitBashPath` | 自动探测 | 固定 git bash.exe 路径 |
| `wslPath` | 自动探测 | 固定 wsl.exe 路径 |

## 发布（npm）

npm 账号已启用 2FA 发布验证，需一次性验证码：

```powershell
cd D:\WorkSpace\projects\dsh-bash-terminal
npm publish --otp <验证码>   # 验证码来自你的认证器
```

发布前先 `npm pack --dry-run` 检查内容、跑 `node scripts/build-client.mjs` 重建 client bundle。

## 卸载

推荐直接运行：

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 uninstall
```

它会删除 junction、恢复设置白名单、清理旧版遗留的 `cordis.patch.yml` 挂载块，并从 `dsh.profile.bundles` 移除 `dsh-bash-terminal`。之后重启 dsh web 即可。

手动卸载时，除了删除 `node_modules\dsh-bash-terminal`，还要记得从 profile `package.json` 的 `dsh.profile.bundles` 中移除 `dsh-bash-terminal`。

## 交互式终端（terminal 工具）

`terminal` 工具在 PTY 接缝（node-pty；Windows 上因上游 `spawnTerminal` 的 process inspector 仅支持 POSIX，由 `lib/terminal.js` 直连 node-pty，非 Windows 仍走官方 `ctx.subprocess.spawnTerminal`）上提供**持久交互会话**：

- `action: open` 启动一个真实终端会话（按你设置的默认终端；wsl 可传 `distro`），返回 `sessionId`
- `action: send` 写入输入并读新输出；`action: read` 只读不写；`action: signal` 向前台进程组发信号（SIGINT = Ctrl+C）
- `action: close` 终止会话
- **会话状态跨调用保持**（cwd / 变量 / 别名），适合 REPL、ssh、交互式 CLI
- `send` 会等待输出稳定（300ms 静默，上限 5s）返回**完整回复**；输出超 1MB 时报 `truncated` 提示
- 输入用 `\\n`（或 \\r）结尾表示回车

## 沙箱（官方机制对接）

`shell` 工具走 DSH 官方沙箱接缝（`ctx.sandboxPolicy` + `ctx.sandbox`）：

- 每次调用解析当前沙箱策略；`danger-full-access` 会话直接执行（不包装）。
- PowerShell 后端经 `ctx.sandbox.confine` 包装 argv —— 与官方 executor 相同的 **fail-closed** 语义：请求受限模式但无可用后端时抛 `SandboxUnavailableError`，拒绝裸跑。
- Git Bash 后端不包装：DSH 的 Windows ACL 受限令牌 runner 与 Cygwin/MSYS2 不兼容（bash 启动即因 `CreateFileMapping` Win32 error 5 终止），因此 Git Bash 在受限模式下也不经沙箱包装；结果报告 `enforcement: gitbash-unconfined`。
- WSL 后端不包装：WSL 独立 Linux 虚拟机本身就是隔离（结果报告 `enforcement: wsl-isolation`）。
- 受限模式下被沙箱拒绝时，结果携带官方标记 `[sandbox: file access denied under <mode> mode]` 与同轮升级提示；模型可凭 `sandbox_permissions` + `justification` 发起一次升级（经 `ctx.approval` 用户审批），与官方 bash/pwsh 工具完全一致。
- 注意：DSH 的 Windows ACL runner 可用时，PowerShell 的受限模式会经它包装；Git Bash 因 Cygwin/MSYS2 不兼容而保持不包装。

## ⚠️ 安全说明

`shell` 工具在受限模式下：PowerShell 会经 `ctx.sandbox.confine` 包装（fail-closed）；Git Bash 因 Cygwin/MSYS2 与 Windows ACL 受限令牌不兼容而**不包装**（与 dsh 进程同权限）；WSL 因独立 Linux VM 不包装。它是**额外的多终端入口**，不享受官方 `pwsh` 工具的 ConstrainedLanguage 限制。DSH 的文件操作工具（read/write/edit）仍受文件沙箱约束。仅在你信任的会话中使用；需要受沙箱保护的 PowerShell 时请继续使用官方 `pwsh` 工具。

## 交互终端已知限制（ConPTY）

- **PowerShell 5.1 无法在 ConPTY 启动**（0x8009001d）—— 交互式 PowerShell 需要安装 [PowerShell 7](https://github.com/PowerShell/PowerShell/releases)（一次性命令不受影响）。
- **wsl.exe 交互模式在 ConPTY 下可能触发 WSL 服务 RPC 错误**（0x8007072c，偶发）—— 一次性 `wsl -e bash -lc ...` 命令正常；交互会话建议直接用 Windows Terminal / WSL 终端，或重试。
- **Windows 上 node-pty 不接受命名信号**：`signal` 的 `SIGINT` 映射为 Ctrl+C（`\x03`），其他信号（`SIGTERM` / `SIGKILL` / `SIGTSTP` / `SIGHUP`）退化为终止会话。
- Git Bash 交互会话完全正常。

## 已知限制

- WSL 后台进程在超时/中断后可能在发行版内短暂残留（WSL 实例在最后一个进程退出后自动关闭）。
- Git Bash 是 msys2 环境，与 WSL 的 Linux 行为存在差异（路径映射、包可用性）。
- 本插件仅在 `win32` 平台注册工具。

## 测试

```powershell
cd D:\WorkSpace\projects\dsh-bash-terminal
node test\unit.mjs    # 纯函数单测（路径解析/argv/env/渲染/校验）
node test\apply.mjs   # apply + execute mock 集成测试（用户设置决定后端、workdir、WSLENV、超时）
node test\client.mjs  # client 插件逻辑测试（slot 注册/初始快照/setShell 写透）
node scripts/build-client.mjs  # 打包前端设置项 bundle → lib/client.js
```
