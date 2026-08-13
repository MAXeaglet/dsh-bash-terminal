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
var import_client = require("@deepseek-ai/dsh-client-runtime/client");
var import_jsx_runtime = require("react/jsx-runtime");
var SETTINGS_NS = "settings.bash-terminal";
var SETTINGS_NAMESPACE = "bash-terminal";
var zh = {
  "shell.title": "\u9ED8\u8BA4\u7EC8\u7AEF",
  "shell.description": "shell \u5DE5\u5177\u6267\u884C\u547D\u4EE4\u65F6\u4F7F\u7528\u7684\u7EC8\u7AEF\uFF08\u7531\u4F60\u51B3\u5B9A\uFF0CAI \u65E0\u6CD5\u66F4\u6539\uFF09",
  "shell.powershell": "PowerShell",
  "shell.gitbash": "Git Bash",
  "shell.wsl": "WSL"
};
var en = {
  "shell.title": "Default terminal",
  "shell.description": "Terminal used by the shell tool (you control this; the AI cannot change it)",
  "shell.powershell": "PowerShell",
  "shell.gitbash": "Git Bash",
  "shell.wsl": "WSL"
};
var inject = ["slots", "locale", "settingsScope"];
function ShellPreferenceRow({ t, useStore, setShell }) {
  const shell = useStore((s) => s.shell);
  const writable = useStore((s) => s.writable);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "div",
    {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        padding: "12px 0"
      },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { minWidth: 0 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontSize: 14, fontWeight: 500, lineHeight: "22px", color: "var(--dsw-alias-label-primary, inherit)" }, children: t("shell.title") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontSize: 12, lineHeight: "18px", opacity: 0.65 }, children: t("shell.description") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
          "select",
          {
            value: shell,
            disabled: !writable,
            onChange: (e) => setShell(e.target.value),
            style: {
              fontSize: 14,
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid var(--dsw-alias-line-strong, #ccc)",
              background: "var(--dsw-alias-bg-layer-2, #fff)",
              color: "var(--dsw-alias-label-primary, inherit)",
              outline: "none",
              cursor: writable ? "pointer" : "not-allowed",
              maxWidth: 180
            },
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "powershell", children: t("shell.powershell") }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "gitbash", children: t("shell.gitbash") }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "wsl", children: t("shell.wsl") })
            ]
          }
        )
      ]
    }
  );
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
