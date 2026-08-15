# Contributing

感谢你考虑为 dsh-bash-terminal 贡献！本插件遵循 DSH 官方设计语言（seam / effect / inject），请保持。

## 开发

```powershell
cd D:\WorkSpace\projects\dsh-bash-terminal
node scripts/build-client.mjs   # 前端设置项 bundle → dist/client.js
node test/unit.mjs              # 纯函数单测
node test/apply.mjs             # apply/execute mock 集成
node test/client.mjs            # client 插件逻辑
node test/terminal.mjs          # 真实 node-pty 交互会话（gitbash）
```

> terminal.mjs 需要本机安装 Git Bash 与 node-pty（profiles 依赖树）。PowerShell 5.1 / wsl 交互的 ConPTY 限制已记录为宽容跳过。

## 结构

- `lib/index.js` — host 插件：`shell` 工具、settings 注册、沙箱对接（confine / escalation / denial）、`terminal` 工具接线
- `lib/terminal.js` — 交互式终端：registry（会话/缓冲/空闲超时）+ 工具（open/send/read/signal/close/list）
- `src/client.jsx` — client 插件：设置页「默认终端」下拉（esbuild 打包 → `dist/client.js`）
- `cordis.patch.yml` — 官方 `dsh.bundle` manifest（profile bundles 自动挂载）
- `install.ps1` — 安装/卸载：junction 链接 + 依赖 + 白名单 patch + bundle 迁移

## 设计准则

- 依赖走 `inject` 声明；注册副作用用 `ctx.effect` 返回 disposer
- 无全局可变状态（会话/缓冲在插件闭包）
- 进程派生走 `ctx.subprocess`；沙箱走 `ctx.sandbox` + `ctx.sandboxPolicy`（fail-closed）
- 交互终端走 PTY 接缝：非 Windows 用 `ctx.subprocess.spawnTerminal`；Windows 因上游 process inspector 仅支持 POSIX，临时直连 node-pty（`lib/terminal.js` 的 `spawnPtyHandle`）
- 后台/会话管理走通用 jobs registry

## 提交流程

1. Fork → 分支 → 单主题提交
2. 跑全部测试（四个套件）+ `node scripts/build-client.mjs`（如改 client 源码）
3. PR 描述写清「改了什么 / 为什么 / 验证了什么」

## 发布

```powershell
node scripts/build-client.mjs
npm pack --dry-run            # 检查内容（lib/dist/src/cordis.patch.yml/README/LICENSE）
npm publish --otp <验证码>    # 账号启用 2FA
git tag v<version> && git push origin v<version>
```
