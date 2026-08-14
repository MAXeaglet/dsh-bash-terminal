window.__ModuleLoader__.load({
	id: "dsh-bash-terminal",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.jsx
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");
var import_client = require("@deepseek-ai/dsh-client-runtime/client");
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
var import_jsx_runtime = require("react/jsx-runtime");
var SETTINGS_NS = "settings.bash-terminal";
var SETTINGS_NAMESPACE = "bash-terminal";
var SHELLS = ["powershell", "gitbash", "wsl"];
var ROW_CSS = ".btRow{border-bottom:1px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}.btRowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}.btTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}.btDesc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}.btSelector{background:var(--dsw-alias-bg-module-platform);height:36px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:18px;align-items:center;gap:12px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}.btSelector:hover{background:var(--dsw-alias-interactive-bg-hover)}.btChevron{flex:none}";
if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="bash-terminal-row"]') === null) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-bash-terminal";
  tag.dataset.pluginCss = "bash-terminal-row";
  tag.textContent = ROW_CSS;
  document.head.appendChild(tag);
}
var zh = {
  "shell.title": "\u9ED8\u8BA4\u7EC8\u7AEF",
  "shell.description": "shell \u5DE5\u5177\u6267\u884C\u547D\u4EE4\u65F6\u4F7F\u7528\u7684\u7EC8\u7AEF",
  "shell.powershell": "PowerShell",
  "shell.gitbash": "Git Bash",
  "shell.wsl": "WSL"
};
var en = {
  "shell.title": "Default terminal",
  "shell.description": "Terminal used by the shell tool",
  "shell.powershell": "PowerShell",
  "shell.gitbash": "Git Bash",
  "shell.wsl": "WSL"
};
var inject = ["slots", "locale", "settingsScope"];
function ShellPreferenceRow({ t, useStore, setShell }) {
  const shell = useStore((s) => s.shell);
  const writable = useStore((s) => s.writable);
  const [open, setOpen] = (0, import_react.useState)(false);
  const items = SHELLS.map((id) => ({ id, label: t("shell." + id) }));
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "btRow", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "btRowText", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "btTitle", children: t("shell.title") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "btDesc", children: t("shell.description") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      import_dsh_client_ui_primitives.Menu,
      {
        open,
        onClose: () => setOpen(false),
        items,
        selectedId: shell,
        onSelect: (id) => {
          setOpen(false);
          setShell(id);
        },
        align: "end",
        portal: true,
        anchor: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
          "button",
          {
            type: "button",
            className: "btSelector",
            "aria-haspopup": "menu",
            "aria-expanded": open,
            disabled: !writable,
            onClick: () => setOpen(!open),
            style: !writable ? { opacity: 0.5, cursor: "not-allowed" } : void 0,
            children: [
              t("shell." + shell),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconChevronDownOutline14, { className: "btChevron" })
            ]
          }
        )
      }
    )
  ] });
}
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(SETTINGS_NS, { zh, en }), "bash-terminal: settings dictionaries");
  const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE });
  const store = (0, import_client.defineStore)({
    init: () => ({ shell: "powershell", revision: -1, writable: false }),
    actions: {
      sync: (d, shell, revision, writable) => {
        if (revision !== void 0 && revision <= d.revision) return;
        if (shell !== void 0) d.shell = shell;
        if (revision !== void 0) d.revision = revision;
        if (writable !== void 0) d.writable = writable;
      }
    }
  });
  let bound;
  const push = (snap) => bound?.sync(snap.value?.defaultShell, snap.revision, snap.writable);
  ctx.slots.inject(
    "settings.general.item",
    () => ctx.slots.register(
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

		return module.exports;
	}
});
