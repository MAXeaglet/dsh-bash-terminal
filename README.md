# dsh-bash-terminal

![test](https://github.com/MAXeaglet/dsh-bash-terminal/actions/workflows/test.yml/badge.svg)

DSH（DeepSeek Harness）插件：一个 `shell` 工具，在 Windows 上统一执行 **PowerShell / Git Bash / WSL** 三种终端命令。

| 后端 | 实际执行 | 语法 / 路径 | 环境变量 |
|------|----------|-------------|----------|
| `powershell`（默认） | `pwsh -NoLogo -NoProfile -NonInteractive -Command <cmd>` | PowerShell；`C:\...` | `$env:NAME` |
| `gitbash` | Git for Windows `bash -lc <cmd>` | POSIX；`/d/WorkSpace`；PATH 含 `/usr/bin`、`/mingw64/bin` | `$NAME` |
| `wsl` | `wsl [-d <distro>] -e bash -lc <cmd>` | Linux；`/mnt/d/...` | `$NAME`（经 WSLENV） |

每次调用都启动全新 shell：**不保留状态**（cwd / 变量 / 别名）——请传 `workdir` 而不是用 `cd`。

## 设计要点

- **终端由用户决定，AI 无法更改**：Web UI 设置页（设置 → 通用）出现"默认终端"下拉（PowerShell / Git Bash / WSL）；`shell` 工具永远只使用该设置，不暴露终端参数给模型。设置通过 DSH settings 系统持久化（settings.yaml）。
- **不占用 `ctx.shell` 能力接缝**：DSH 自带的沙箱化 `pwsh` 工具保持原样可用；本插件的 `shell` 工具是**额外的**多终端入口。
- 通过共享的 `ctx.subprocess` seam 派生进程：进程树终止（Windows `taskkill /T`）、SIGTERM→grace→SIGKILL、输出 spill 文件，与官方 `dsh-tool-bash` / `dsh-tool-pwsh` 行为一致。
- 后台任务注册进通用 `jobs` registry，支持 `run_in_background` / `job_output` / `job_kill`。
- 工具参数 `shell` 是枚举（UI 自动渲染为下拉），模型每次调用自行选择终端。

## 安装（web profile）

### 标准安装（npm 发布后）

```powershell
# 1. 安装插件包
npm install -g dsh-bash-terminal          # 全局（或加入 profile 的依赖）
dsh plugin --profile web add dsh-bash-terminal

# 2. patch DSH 设置白名单（DSH 限制，见下方说明；install.ps1 可单独执行此步）
powershell -ExecutionPolicy Bypass -File install.ps1 install

# 3. 重启 dsh web
```

### 本地开发安装（junction 直连，改源码即时生效）
# 1. 链接插件包到 profile 的 node_modules（junction，改源码即时生效）
$profile = "$env:USERPROFILE\.dsh\profiles\web"
New-Item -ItemType Junction -Path "$profile\node_modules\dsh-bash-terminal" -Target "D:\WorkSpace\projects\dsh-bash-terminal" | Out-Null

# 2. 让插件能解析 @deepseek-ai/* 依赖（junction 到 profile 的依赖树）
New-Item -ItemType Junction -Path "D:\WorkSpace\projects\dsh-bash-terminal\node_modules\@deepseek-ai" -Target "$profile\..\node_modules\@deepseek-ai" | Out-Null

# 3. 在 cordis.patch.yml 追加挂载行（见下方 patch 片段）
# 4. （仅修改前端源码后）重新打包 client bundle:
#    cd D:\WorkSpace\projects\dsh-bash-terminal && node scripts/build-client.mjs
# 5. 让设置 UI 接受本插件的设置写入（DSH 限制，见下方说明）
# 6. 重启 dsh web
```

> **DSH 设置 UI 白名单限制**：DSH 的 api-gateway（dsh-host-apiproxy）对
> Web 设置客户端暴露的 settings namespace 有**硬编码白名单**（第三方插件
> 的设置默认会被 `settings-not-exposed` 拒绝，UI 里改了不生效）。
> install.ps1 会自动 patch 该白名单（加入 `bash-terminal`，先备份原文件）。
> **升级 DSH 后需重新运行 install.ps1** 恢复 patch。卸载时 install.ps1 会还原。

`cordis.patch.yml` 追加：

```yaml
- insert:
    - id: tool-bash-terminal
      name: 'dsh-bash-terminal'
```

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

## 卸载

```powershell
Remove-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-bash-terminal" -Force
# 并从 cordis.patch.yml 删掉 insert 块，重启 dsh web
```

## 沙箱（官方机制对接）

`shell` 工具走 DSH 官方沙箱接缝（`ctx.sandboxPolicy` + `ctx.sandbox`）：

- 每次调用解析当前沙箱策略；`danger-full-access` 会话直接执行（不包装）。
- PowerShell / Git Bash 后端经 `ctx.sandbox.confine` 包装 argv —— 与官方 executor 相同的 **fail-closed** 语义：请求受限模式但无可用后端时抛 `SandboxUnavailableError`，拒绝裸跑。
- WSL 后端不包装：WSL 独立 Linux 虚拟机本身就是隔离（结果报告 `enforcement: wsl-isolation`）。
- 受限模式下被沙箱拒绝时，结果携带官方标记 `[sandbox: file access denied under <mode> mode]` 与同轮升级提示；模型可凭 `sandbox_permissions` + `justification` 发起一次升级（经 `ctx.approval` 用户审批），与官方 bash/pwsh 工具完全一致。
- 注意：DSH 的 Windows ACL 沙箱 launcher（`node-addon-landlock-run-win32-x64`）当前尚未在 npm 发布，本机沙箱后端暂不可用；架构已就绪，DSH 发布后自动生效。

## ⚠️ 安全说明

`shell` 工具的命令**在 DSH 沙箱之外**运行，与 dsh 进程同权限（等同完整访问的命令执行），
不享受 `pwsh` 工具的 ConstrainedLanguage 限制。DSH 的文件操作工具（read/write/edit）仍受文件沙箱约束。
仅在你信任的会话中使用；需要受沙箱保护的 PowerShell 时请继续使用官方 `pwsh` 工具。

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
node scripts/build-client.mjs  # 打包前端设置项 bundle → dist/client.js
```
