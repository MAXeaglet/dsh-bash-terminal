// dsh-bash-terminal client plugin: "Default terminal" preference rows in the
// Web UI General settings, mirroring the shipped EnterBehaviorRow grammar
// (row layout, capsule selector with chevron, --dsw-* tokens).
//
// 本地分设改动（2026-09-08 起，移植到 0.3.15）：上游只有一行设置（写 defaultShell，
// shell 与 terminal 工具共用）。本地把这一行拆成两行——Shell 工具默认终端（写
// defaultShell，语义不变）+ Terminal 工具默认终端（写 terminalShell，含「跟随 Shell
// 工具默认」= ""）。host 侧 lib/index.js 的 terminalShellOf() 决定 terminal 工具实际用哪个。
// 为什么必须改 client 并重打包：这行下拉不是通用 schema 表单渲染，而是本插件自定义注册进
// settings.general.item 槽位的 React 行（见 本地自改留痕/dsh-bash-terminal改动/*.md）。
//
// DSH >= 0.1.5: the browser module table (PLATFORM_MODULES) seeds react,
// @deepseek-ai/cordis, @deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-slots,
// @deepseek-ai/dsh-client-ui-primitives and @deepseek-ai/dsh-client-ui-dockkit by
// exact bare specifier. The old dsh-client-runtime name is gone from that table
// (and so is its /client subpath), so this bundle requests dsh-client-store.

import { useState } from "react";
import { defineStore } from "@deepseek-ai/dsh-client-store";
import { IconChevronDownOutline14, Menu } from "@deepseek-ai/dsh-client-ui-primitives";

const SETTINGS_NS = "settings.bash-terminal";
const SETTINGS_NAMESPACE = "bash-terminal";
const SHELLS = ["powershell", "gitbash", "wsl"];

// Injected once when the browser loads the bundle (node tests guard on document).
const ROW_CSS = 
  ".btRow{border-bottom:1px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}" +
  ".btRowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}" +
  ".btTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}" +
  ".btDesc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}" +
  ".btSelector{background:var(--dsw-alias-bg-module-platform);height:36px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:18px;align-items:center;gap:12px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}" +
  ".btSelector:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
  ".btChevron{flex:none}";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"bash-terminal-row\"]") === null) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-bash-terminal";
  tag.dataset.pluginCss = "bash-terminal-row";
  tag.textContent = ROW_CSS;
  document.head.appendChild(tag);
}

const zh = {
  "shell.title": "Shell 工具默认终端",
  "shell.description": "shell 工具执行命令时使用的终端",
  "terminal.title": "Terminal 工具默认终端",
  "terminal.description": "交互式 terminal 工具打开会话时使用的终端",
  "terminal.follow": "跟随 Shell 工具默认",
  "shell.powershell": "PowerShell",
  "shell.gitbash": "Git Bash",
  "shell.wsl": "WSL"
};
const en = {
  "shell.title": "Shell tool default terminal",
  "shell.description": "Terminal used by the shell tool",
  "terminal.title": "Terminal tool default terminal",
  "terminal.description": "Terminal used when the interactive terminal tool opens a session",
  "terminal.follow": "Follow the shell tool",
  "shell.powershell": "PowerShell",
  "shell.gitbash": "Git Bash",
  "shell.wsl": "WSL"
};

export const inject = ["slots", "locale", "settingsScope"];

/** 公共行组件：两行只有「读 store 哪个字段 / 标题 / 选项集 / 写哪个 key」不同。 */
function SelectRow({ t, useStore, field, options, titleKey, descKey, setValue }) {
  const value = useStore((s) => (field === "terminal" ? s.terminal : s.shell));
  const writable = useStore((s) => s.writable);
  const [open, setOpen] = useState(false);
  const labelOf = (id) => (id === "" ? t("terminal.follow") : t("shell." + id));
  const items = options.map((id) => ({ id, label: labelOf(id) }));
  return (
    <div className="btRow">
      <div className="btRowText">
        <div className="btTitle">{t(titleKey)}</div>
        <div className="btDesc">{t(descKey)}</div>
      </div>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        selectedId={value}
        onSelect={(id) => {
          setOpen(false);
          setValue(id);
        }}
        align="end"
        portal
        anchor={
          <button
            type="button"
            className="btSelector"
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={!writable}
            onClick={() => setOpen(!open)}
            style={!writable ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
          >
            {labelOf(value)}
            <IconChevronDownOutline14 className="btChevron" />
          </button>
        }
      />
    </div>
  );
}

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(SETTINGS_NS, { zh, en }), "bash-terminal: settings dictionaries");
  const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE });
  const store = defineStore({
    init: () => ({ shell: "powershell", terminal: "", revision: -1, writable: false }),
    actions: {
      // 两个字段各自独立；revision 守卫让两行重复 push 时只认最新快照（幂等）。
      sync: (d, shell, terminal, revision, writable) => {
        if (revision !== undefined && revision <= d.revision) return;
        if (shell !== undefined) d.shell = shell;
        if (terminal !== undefined) d.terminal = terminal;
        if (revision !== undefined) d.revision = revision;
        if (writable !== undefined) d.writable = writable;
      }
    }
  });
  let bound;
  const push = (snap) => bound?.sync(snap.value?.defaultShell, snap.value?.terminalShell, snap.revision, snap.writable);
  const registerRow = (id, order, field, options, key, titleKey, descKey) =>
    ctx.slots.inject(
      "settings.general.item",
      () =>
        ctx.slots.register(
          {
            name: "settings.general.item",
            id,
            order,
            store,
            locale: SETTINGS_NS,
            inject: (actions) => {
              bound = actions;
              push(scope.getSnapshot());
              return { setValue: (value) => void scope.set(key, value) };
            }
          },
          (props) => <SelectRow {...props} field={field} options={options} titleKey={titleKey} descKey={descKey} />
        ),
      "bash-terminal: settings row " + id
    );

  registerRow("bash-terminal-shell", 20, "shell", SHELLS, "defaultShell", "shell.title", "shell.description");
  registerRow("bash-terminal-terminal", 21, "terminal", ["", ...SHELLS], "terminalShell", "terminal.title", "terminal.description");
  ctx.effect(() => scope.subscribe(() => push(scope.getSnapshot())), "bash-terminal: settings watch");
}
