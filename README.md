# dsh-bash-terminal

> 🌐 [English](README.en.md) · 社区交流：[LINUX DO](https://linux.do) · [GitHub](https://github.com/MAXeaglet/dsh-bash-terminal)

![test](https://github.com/MAXeaglet/dsh-bash-terminal/actions/workflows/test.yml/badge.svg)

DSH（DeepSeek Harness）插件：一个 `shell` 工具，在 Windows 上统一执行 **PowerShell / Git Bash / WSL** 三种终端命令。

| 后端 | 实际执行 | 语法 / 路径 | 环境变量 |
|------|----------|-------------|----------|
| `powershell`（默认） | `pwsh -NoLogo -NoProfile -NonInteractive -EncodedCommand <base64 UTF-16LE>` | PowerShell；`C:\...` | `$env:NAME` |
| `gitbash` | Git for Windows `bash -ls`（脚本写入 stdin） | POSIX；`/d/WorkSpace`；PATH 含 `/usr/bin`、`/mingw64/bin` | `$NAME` |
| `wsl` | `wsl [-d <distro>] -e bash -ls`（脚本写入 stdin） | Linux；`/mnt/d/...` | `$NAME`（经 WSLENV） |

**脚本按字节传递，不经过 argv。** 命令文本不会再作为一个 argv 元素穿过 Windows 命令行 / `wsl.exe` 参数桥：bash 从 stdin 读取脚本（写入后立即关闭管道，读 stdin 的 `cat`/`read` 会立刻看到 EOF，而不是挂起），连超过 32 KB 的大脚本也能原样执行；PowerShell 收到 base64 UTF-16LE 的 `-EncodedCommand`，换行与引号原样到达（编码后的载荷仍受 Windows 命令行长度限制）。`-l` 登录标志保留，PATH/环境与之前一致。

每次调用都启动全新 shell：**不保留状态**（cwd / 变量 / 别名）——请传 `workdir` 而不是用 `cd`。

## 设计要点

- **终端由用户决定，AI 无法更改**：Web UI 设置页（设置 → 通用）出现"默认终端"下拉（PowerShell / Git Bash / WSL）；`shell` 工具永远只使用该设置，不暴露终端参数给模型。设置通过 DSH settings 系统持久化（settings.yaml）。
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

# 2. patch DSH 设置白名单（DSH 限制，见下方说明）
powershell -ExecutionPolicy Bypass -File install.ps1 install

# 3. 重启 dsh web
```

> 已用临时 profile 实测：`bundles: [dsh-bash-terminal]` → dump-config 自动出现 `tool-bash-terminal` entry。

### 本地开发安装（junction 直连，改源码即时生效）

```powershell
# 1. 链接插件包到 profile 的 node_modules（junction，改源码即时生效）
$profile = "$env:USERPROFILE\.dsh\profiles\web"
New-Item -ItemType Junction -Path "$profile\node_modules\dsh-bash-terminal" -Target "D:\WorkSpace\projects\dsh-bash-terminal" | Out-Null

# 2. 让插件能解析 @deepseek-ai/* 依赖（junction 到 profile 的依赖树，插件与宿主共用同一份模块实例）
New-Item -ItemType Junction -Path "D:\WorkSpace\projects\dsh-bash-terminal\node_modules\@deepseek-ai" -Target "$profile\..\node_modules\@deepseek-ai" | Out-Null

# 3. 让 profile 通过官方 bundle 挂载插件（install.ps1 install 会自动做；等价于在 dsh.profile.bundles 加 "dsh-bash-terminal"）
# 4. （仅修改前端源码后）重新打包 client bundle:
#    cd D:\WorkSpace\projects\dsh-bash-terminal && node scripts/build-client.mjs
# 5. 重启 dsh web
```

> ⚠️ **不要在本项目里跑 `npm install`**：它会删掉上面第 2 步的 junction，转而给插件装一份**独立的**
> `@deepseek-ai/*` 副本 —— 插件和宿主就不再共用模块实例，宿主升级后插件会停在旧 API 上
> （本项目曾因此停在 0.1.0-rc.6）。只刷新 lock 时用 `npm install --package-lock-only`。

> **兼容性**：要求 DSH ≥ **0.1.5-rc.1**。0.1.5 把浏览器模块表里的 `@deepseek-ai/dsh-client-runtime`
> 改名为 `@deepseek-ai/dsh-client-store` 且只按精确裸名命中；旧 bundle 在新宿主上会报
> `Failed to load plugins` / `require(...) missed the module table`。
>
> 另：0.1.5 的 Web 设置面改为 `settings.describe()` 动态枚举，**不再有 namespace 白名单**
> （`settings-not-exposed` 已不存在），`install.ps1` 里的白名单 patch 只是历史遗留、可忽略。

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
- **远程服务器（推荐姿势）**：`terminal(action: "ssh", sshHost: "second_brain")` → 记下 `sessionId` → 之后每步都用 `terminal(action: "send", sessionId, input: "cd /srv/app && systemctl status nginx\n")`，**同一个登录**里连续操作。不要用 `shell(command: "ssh second_brain <cmd>")` 一步步来：那等于每条命令重开一次连接，cwd/变量全丢，还要为握手等上几秒
- 远程命令跑太久想中断：`terminal(action: "signal", sessionId, signal: "SIGINT")` —— 信号发给**远端前台进程**，不会把 ssh 客户端本身打断
- 读取是增量的：`send` 只回该命令的新输出；`more: true` 或 `waiting: true` 时再 `read` 一次；要看整段历史用 `terminal(action: "read", sessionId, full: true)`
- 查看活动会话：`terminal(action: "list")`
- 沙箱拒绝后升级：`shell(command: ..., sandbox_permissions: "workspace-write", justification: "...")`

## 配置

**Web UI 设置**（推荐）：设置 → 通用 →「默认终端」。

插件 row 的 `config`（覆盖默认，作为设置的 composition 基准）：

| 键 | 默认 | 说明 |
|----|------|------|
| `defaultShell` | `powershell` | 设置未覆盖时的后端 |
| `sshShell` | `wsl` | `terminal(action: "ssh")` 使用哪个后端登录远程主机 |
| `timeoutMs` | 120000 | 默认超时 |
| `maxTimeoutMs` | 600000 | 调用方 timeoutMs 上限 |
| `pwshPath` | 自动探测 | 固定 pwsh.exe 路径 |
| `gitBashPath` | 自动探测 | 固定 git bash.exe 路径 |
| `wslPath` | 自动探测 | 固定 wsl.exe 路径 |

> **为什么 `sshShell` 独立于 `defaultShell`**：ssh 的 host 别名和密钥在 **WSL** 的
> `~/.ssh/config` 里（Windows 侧 `%USERPROFILE%\.ssh\config` 常见为空文件），所以在
> PowerShell 里 `ssh second_brain` 会直接 `Could not resolve hostname`。把日常终端切成
> PowerShell 不应连带弄坏远程工作，因此 ssh 会话默认仍走 wsl；显式配成其它后端也会被尊重，
> 而 wsl 不可用时 ssh 动作会给出可操作的报错而不是静默失败。

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
- `action: ssh` **直接登录远程主机**（`sshHost`: `~/.ssh/config` 别名 / `user@host` / 地址），返回已登录的 `sessionId`；后续 `send` 复用**同一个 ssh 登录**，cwd、导出变量、shell 状态都保留。密码与 2FA 提示是交互式的，用 `send` 回答即可 —— 这是 `shell` 工具做不到的
- `action: send` 写入输入并读新输出；`action: read` 只读不写；`action: signal` 向前台进程组发信号（SIGINT = Ctrl+C）
- `action: close` 终止会话；`action: list` 列出活动会话（远程会话会显示 `sshHost`）
- **会话状态跨调用保持**（cwd / 变量 / 别名），适合 REPL、ssh、交互式 CLI
- **增量读取**：每次 send/read/signal 只返回**该读者游标之后**的新输出，并按终端显示渲染（剥离转义序列、折叠 `\r` 覆盖），不会把整段历史反复塞进上下文
- 每条回复带元信息：`nextOffset`（绝对流位置，游标停在这里）、`pending`（未换行的尾巴，通常是提示符）、`more: true`（还有整行输出在等下一次 read）、`waiting: true`（窗口到期时命令仍在产出，先再 read 一次再发下一条命令）、`elided`（更早的字符已不在保留环里）
- 单条回复上限 32 KB（UTF-8 字节）：超出部分留在环里，靠 `more` + 再 read 一次分页取回，**不丢输出**；游标只前进到实际交付的文本之后
- `from: 0`（或 `full: true`）重读整段保留日志，`from: <nextOffset>` 从旧位置续读，`raw: true` 返回未渲染的原始流
- 输出环按 **UTF-8 字节**计上限（默认 1 MiB，超限丢最旧）；多字节字符与代理对不会被截断
- `send` 等待输出稳定后返回**完整回复**：本地 300ms 静默 / 8s 上限，远程（ssh 会话）1200ms 静默 / 20s 上限
- 等待以**写入时的输出位置**为锚点：只有"写入之后出现了新输出、随后安静下来"才算完成。否则一次写入空闲会话会立刻返回上一条命令的输出、而新命令的输出一个字都没有（远程场景下这会被读成"命令没反应"）
- 命令迟迟不说话时（本地 3.5s / 远程 8s 内无任何新输出）返回 `waiting: true`，提示再 read 一次，而不是给出一个空结果
- 远程会话用 `TERM=xterm-256color` 并去掉 `NO_COLOR`（远端颜色与行编辑正常），本地会话保持 `dumb`
- 输入用 `\n`（或 `\r`）结尾表示回车

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
- **wsl.exe 交互模式在 ConPTY 下可能触发 WSL 服务 RPC 错误**（0x8007072c，偶发）—— 一次性 `wsl ... bash -ls` 命令正常；交互会话建议直接用 Windows Terminal / WSL 终端，或重试。
- **Windows 上 node-pty 不接受命名信号**：`signal` 的 `SIGINT` 映射为 Ctrl+C（`\x03`），其他信号（`SIGTERM` / `SIGKILL` / `SIGTSTP` / `SIGHUP`）退化为终止会话。
- Git Bash 交互会话完全正常。

## 已知限制

- WSL 后台进程在超时/中断后可能在发行版内短暂残留（WSL 实例在最后一个进程退出后自动关闭）。
- Git Bash 是 msys2 环境，与 WSL 的 Linux 行为存在差异（路径映射、包可用性）。
- 本插件仅在 `win32` 平台注册工具。

## 测试

```powershell
npm test                  # unit → apply → buffer → terminal → settle → e2e
node test\unit.mjs        # 纯函数单测（路径解析/argv/stdin/env/渲染/校验）
node test\apply.mjs       # apply + execute mock 集成测试（用户设置决定后端、workdir、WSLENV、超时、jobs spec）
node test\buffer.mjs      # 增量交付单测（绝对偏移、字节上限、行框定、分页、渲染）
node test\e2e.mjs         # 真实 spawn：WSL/Git Bash heredoc 字节一致（前台+后台）、裸 cat EOF、PowerShell 多行、80 KB 大脚本
node test\client.mjs      # client 插件逻辑测试（slot 注册/初始快照/setShell 写透）
node scripts\build-client.mjs  # 打包前端设置项 bundle → lib/client.js
```
