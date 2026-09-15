// Client plugin logic test: load lib/client.js under a mocked __ModuleLoader__
// and exercise apply(ctx) with mocked slots/locale/settingsScope services.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { join } from "node:path";
import assert from "node:assert";
const profileRequire = createRequire(join(os.homedir(), ".dsh", "profiles", "web", "package.json"));
function loadShared(name) {
  // CI: react is installed into the project node_modules (npm install react --no-save);
  // local dev: resolve from the profile dependency tree instead.
  try {
    return createRequire(import.meta.url)(name);
  } catch {
    return profileRequire(name);
  }
}

// --- mock defineStore (shape mirrors dsh-client-store: { spec, create }) ---
const mockDefineStore = (decl) => ({
  spec: decl,
  create: () => {
    let state = decl.init();
    const listeners = new Set();
    const actions = {};
    for (const key of Object.keys(decl.actions)) {
      actions[key] = (...params) => { decl.actions[key](state, ...params); for (const f of listeners) f(); };
    }
    return {
      actions,
      getSnapshot: () => state,
      subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }
    };
  }
});

// --- mocked services ---
let scopeState = { status: "ready", value: { defaultShell: "gitbash", terminalShell: "" }, revision: 3, writable: true };
const setCalls = [];
const localeRegisters = [];
const slotRegistrations = [];
let scopeSubscriber;
const ctx = {
  slots: {
    inject: (slot, fn) => { slotRegistrations.push({ slot, fn }); },
    register: (options, Component) => ({ ...options, Component })
  },
  locale: { register: (ns, dicts) => { localeRegisters.push({ ns, dicts }); } },
  settingsScope: {
    bind: () => ({
      getSnapshot: () => scopeState,
      // 捕获订阅回调：设置变更时由框架调用，测试要能手动触发（见末尾 settings change）
      subscribe: (fn) => { scopeSubscriber = fn; return () => {}; },
      set: (field, value) => { setCalls.push({ field, value }); },
      unset: () => {}
    })
  },
  effect: (fn) => { fn(); }
};

// --- load the built client bundle under a fake module loader ---
const bundle = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
assert.ok(bundle.includes("window.__ModuleLoader__.load"), "bundle wrapped");
// DSH >= 0.1.5 regression guard: the platform seed table spells the store
// package @deepseek-ai/dsh-client-store; the retired runtime name would miss it.
assert.ok(bundle.includes("@deepseek-ai/dsh-client-store"), "requests the seeded client store");
assert.ok(!bundle.includes("dsh-client-runtime"), "does not request the retired client runtime");
let exported;
globalThis.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      assert.strictEqual(id, "dsh-bash-terminal");
      exported = factory((name) => {
        if (name === "@deepseek-ai/dsh-client-store") return { defineStore: mockDefineStore };
        if (name === "react/jsx-runtime" || name === "react" || name === "react-dom/server") return loadShared(name);
        if (name === "@deepseek-ai/dsh-client-ui-primitives") {
          const React = loadShared("react");
          return {
            Menu: (props) => React.createElement("div", null, props.anchor),
            IconChevronDownOutline14: () => null
          };
        }
        throw new Error("unexpected require: " + name);
      });
    }
  }
};
new Function(bundle)();
assert.ok(exported, "client module exports");
assert.deepStrictEqual(exported.inject, ["slots", "locale", "settingsScope"]);
assert.strictEqual(typeof exported.apply, "function");

// --- run apply ---
exported.apply(ctx);

// locale dictionaries registered (shell row + terminal row + the follow option)
assert.strictEqual(localeRegisters.length, 1);
assert.strictEqual(localeRegisters[0].ns, "settings.bash-terminal");
for (const key of ["shell.title", "terminal.title", "terminal.follow"]) {
  assert.ok(localeRegisters[0].dicts.zh[key], "zh locale has " + key);
  assert.ok(localeRegisters[0].dicts.en[key], "en locale has " + key);
}

// two settings rows registered into the General item slot: shell + terminal
assert.strictEqual(slotRegistrations.length, 2);
assert.deepStrictEqual(slotRegistrations.map((r) => r.slot), ["settings.general.item", "settings.general.item"]);
const regShell = slotRegistrations[0].fn();
const regTerminal = slotRegistrations[1].fn();
for (const reg of [regShell, regTerminal]) {
  assert.strictEqual(reg.name, "settings.general.item");
  assert.strictEqual(reg.locale, "settings.bash-terminal");
  assert.ok(reg.store && typeof reg.store.create === "function", "store factory passed to register");
  assert.strictEqual(typeof reg.Component, "function", "row component passed");
}
assert.strictEqual(regShell.id, "bash-terminal-shell");
assert.strictEqual(regTerminal.id, "bash-terminal-terminal");
assert.strictEqual(typeof regShell.order, "number");
assert.strictEqual(regTerminal.order, regShell.order + 1, "the terminal row follows the shell row");
// 两行用的是同一个 store **spec**；框架对每次注册各调一次 create()，所以运行时是两份实例
// （下面按实例驱动，并验证设置变更必须落进**两份** store）
assert.strictEqual(regShell.store, regTerminal.store, "same store spec");

// 每次注册各 create() 一份 store → 用各自的实例驱动：inject() 绑定的是**这一行**的 actions，
// 初始快照必须落进**它自己**的 store。
const storeShell = regShell.store.create();
const storeTerminal = regTerminal.store.create();
const injectedShell = regShell.inject(storeShell.actions);
assert.ok(injectedShell && typeof injectedShell.setValue === "function");
assert.deepStrictEqual(storeShell.getSnapshot(), { shell: "gitbash", terminal: "", revision: 3, writable: true }, "shell store got the initial snapshot");
const injectedTerminal = regTerminal.inject(storeTerminal.actions);
assert.deepStrictEqual(storeTerminal.getSnapshot(), { shell: "gitbash", terminal: "", revision: 3, writable: true }, "terminal store got the initial snapshot");

// each row writes through to its own settings key
injectedShell.setValue("wsl");
assert.deepStrictEqual(setCalls, [{ field: "defaultShell", value: "wsl" }]);
injectedTerminal.setValue("gitbash");
assert.deepStrictEqual(setCalls, [
  { field: "defaultShell", value: "wsl" },
  { field: "terminalShell", value: "gitbash" }
]);

// rows render through real React (DSH-native Menu/Button are mocked)
const { renderToString } = loadShared("react-dom/server");
const renderState = { shell: "wsl", terminal: "", revision: 3, writable: true };
const selectors = [];
const fakeUseStore = (sel) => { selectors.push(sel(renderState)); return selectors[selectors.length - 1]; };
const t = (k) => ({
  "shell.title": "Shell 工具默认终端",
  "shell.description": "shell 工具执行命令时使用的终端",
  "terminal.title": "Terminal 工具默认终端",
  "terminal.description": "交互式 terminal 工具打开会话时使用的终端",
  "terminal.follow": "跟随 Shell 工具默认",
  "shell.powershell": "PowerShell",
  "shell.gitbash": "Git Bash",
  "shell.wsl": "WSL"
}[k] ?? k);

const htmlShell = renderToString(loadShared("react").createElement(regShell.Component, {
  t, useStore: fakeUseStore, field: "shell",
  options: ["powershell", "gitbash", "wsl"],
  titleKey: "shell.title", descKey: "shell.description", setValue: injectedShell.setValue
}));
assert.ok(htmlShell.includes("Shell 工具默认终端"), "shell row renders its own title");
assert.ok(htmlShell.includes("WSL"), "shell selector shows the current shell label");
assert.ok(htmlShell.includes("btSelector"), "selector uses the official capsule class");
assert.ok(!htmlShell.includes("跟随 Shell 工具默认"), "the shell row does not offer the follow option");

const htmlTerminal = renderToString(loadShared("react").createElement(regTerminal.Component, {
  t, useStore: fakeUseStore, field: "terminal",
  options: ["", "powershell", "gitbash", "wsl"],
  titleKey: "terminal.title", descKey: "terminal.description", setValue: injectedTerminal.setValue
}));
assert.ok(htmlTerminal.includes("Terminal 工具默认终端"), "terminal row renders its own title");
assert.ok(htmlTerminal.includes("跟随 Shell 工具默认"), "terminal row shows the follow label while unset");

assert.deepStrictEqual(selectors, ["wsl", true, "", true], "rows read their own field + writable from the store");

// 设置变更 → 订阅回调必须把新快照推进**每一份** store（回归守卫：只记一个 bound 的话，
// shell 那一行会停在旧值 —— 这正是 review 指出的 bug）
scopeState = { status: "ready", value: { defaultShell: "powershell", terminalShell: "gitbash" }, revision: 4, writable: true };
scopeSubscriber();
assert.deepStrictEqual(storeShell.getSnapshot(), { shell: "powershell", terminal: "gitbash", revision: 4, writable: true }, "shell store re-synced after the change");
assert.deepStrictEqual(storeTerminal.getSnapshot(), { shell: "powershell", terminal: "gitbash", revision: 4, writable: true }, "terminal store re-synced after the change");

console.log("CLIENT LOGIC TESTS PASSED");