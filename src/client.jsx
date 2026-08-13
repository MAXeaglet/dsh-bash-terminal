// dsh-bash-terminal client plugin: a "Default terminal" preference row in the
// Web UI General settings. The user picks powershell / gitbash / wsl; the host
// shell tool obeys that choice (the model cannot change it).

import { defineStore } from "@deepseek-ai/dsh-client-runtime/client";

const SETTINGS_NS = "settings.bash-terminal";
const SETTINGS_NAMESPACE = "bash-terminal";

const zh = {
  "shell.title": "默认终端",
  "shell.description": "shell 工具执行命令时使用的终端（由你决定，AI 无法更改）",
  "shell.powershell": "PowerShell",
  "shell.gitbash": "Git Bash",
  "shell.wsl": "WSL"
};
const en = {
  "shell.title": "Default terminal",
  "shell.description": "Terminal used by the shell tool (you control this; the AI cannot change it)",
  "shell.powershell": "PowerShell",
  "shell.gitbash": "Git Bash",
  "shell.wsl": "WSL"
};

export const inject = ["slots", "locale", "settingsScope"];

function ShellPreferenceRow({ t, useStore, setShell }) {
  const shell = useStore((s) => s.shell);
  const writable = useStore((s) => s.writable);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        padding: "12px 0"
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 500, lineHeight: "22px", color: "var(--dsw-alias-label-primary, inherit)" }}>
          {t("shell.title")}
        </div>
        <div style={{ fontSize: 12, lineHeight: "18px", opacity: 0.65 }}>{t("shell.description")}</div>
      </div>
      <select
        value={shell}
        disabled={!writable}
        onChange={(e) => setShell(e.target.value)}
        style={{
          fontSize: 14,
          padding: "6px 10px",
          borderRadius: 8,
          border: "1px solid var(--dsw-alias-line-strong, #ccc)",
          background: "var(--dsw-alias-bg-layer-2, #fff)",
          color: "var(--dsw-alias-label-primary, inherit)",
          outline: "none",
          cursor: writable ? "pointer" : "not-allowed",
          maxWidth: 180
        }}
      >
        <option value="powershell">{t("shell.powershell")}</option>
        <option value="gitbash">{t("shell.gitbash")}</option>
        <option value="wsl">{t("shell.wsl")}</option>
      </select>
    </div>
  );
}

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(SETTINGS_NS, { zh, en }), "bash-terminal: settings dictionaries");
  const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE });
  const store = defineStore({
    init: () => ({ shell: "powershell", revision: -1, writable: false }),
    actions: {
      sync: (d, shell, revision, writable) => {
        if (revision !== undefined && revision <= d.revision) return;
        if (shell !== undefined) d.shell = shell;
        if (revision !== undefined) d.revision = revision;
        if (writable !== undefined) d.writable = writable;
      }
    }
  });
  // defineStore() yields a { spec, create } factory; slots.register creates
  // the live store, so we bind the actions in the inject callback and push
  // the initial snapshot there too (mirrors the theme row pattern).
  let bound;
  const push = (snap) => bound?.sync(snap.value?.defaultShell, snap.revision, snap.writable);
  ctx.slots.inject(
    "settings.general.item",
    () =>
      ctx.slots.register(
        {
          name: "settings.general.item",
          id: "bash-terminal-shell",
          order: 20,
          store,
          locale: SETTINGS_NS,
          inject: (actions) => {
            bound = actions;
            push(scope.getSnapshot());
            return { setShell: (value) => void scope.set("defaultShell", value) };
          }
        },
        ShellPreferenceRow
      ),
    "bash-terminal: settings row"
  );
  ctx.effect(() => scope.subscribe(() => push(scope.getSnapshot())), "bash-terminal: settings watch");
}
