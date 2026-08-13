// Client plugin logic test: load dist/client.js under a mocked __ModuleLoader__
// and exercise apply(ctx) with mocked slots/locale/settingsScope services.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import assert from "node:assert";
const profileRequire = createRequire("C:/Users/10045/.dsh/profiles/web/package.json");
function loadShared(name) {
  // CI: react is installed into the project node_modules (npm install react --no-save);
  // local dev: resolve from the profile dependency tree instead.
  try {
    return createRequire(import.meta.url)(name);
  } catch {
    return profileRequire(name);
  }
}

// --- mock defineStore (shape mirrors dsh-client-runtime: { spec, create }) ---
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
let scopeState = { status: "ready", value: { defaultShell: "gitbash" }, revision: 3, writable: true };
const setCalls = [];
const localeRegisters = [];
const slotRegistrations = [];
const ctx = {
  slots: {
    inject: (slot, fn) => { slotRegistrations.push({ slot, fn }); },
    register: (options, Component) => ({ ...options, Component })
  },
  locale: { register: (ns, dicts) => { localeRegisters.push({ ns, dicts }); } },
  settingsScope: {
    bind: () => ({
      getSnapshot: () => scopeState,
      subscribe: () => () => {},
      set: (field, value) => { setCalls.push({ field, value }); },
      unset: () => {}
    })
  },
  effect: (fn) => { fn(); }
};

// --- load the built client bundle under a fake module loader ---
const bundle = readFileSync(new URL("../dist/client.js", import.meta.url), "utf8");
assert.ok(bundle.includes("window.__ModuleLoader__.load"), "bundle wrapped");
let exported;
globalThis.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      assert.strictEqual(id, "dsh-bash-terminal");
      exported = factory((name) => {
        if (name === "@deepseek-ai/dsh-client-runtime/client") return { defineStore: mockDefineStore };
        if (name === "react/jsx-runtime" || name === "react") return loadShared(name);
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

// locale dictionaries registered
assert.strictEqual(localeRegisters.length, 1);
assert.strictEqual(localeRegisters[0].ns, "settings.bash-terminal");
assert.ok(localeRegisters[0].dicts.zh["shell.title"]);
assert.ok(localeRegisters[0].dicts.en["shell.title"]);

// settings row registered into the General item slot
assert.strictEqual(slotRegistrations.length, 1);
assert.strictEqual(slotRegistrations[0].slot, "settings.general.item");
const regObj = slotRegistrations[0].fn();
const reg = regObj;
const Component = regObj.Component;
assert.strictEqual(reg.name, "settings.general.item");
assert.strictEqual(reg.id, "bash-terminal-shell");
assert.strictEqual(typeof reg.order, "number");
assert.strictEqual(reg.locale, "settings.bash-terminal");
assert.ok(reg.store && typeof reg.store.create === "function", "store factory passed to register");
assert.strictEqual(typeof Component, "function", "row component passed");

// inject callback binds actions, pushes initial snapshot, exposes setShell
let lastSync;
const injected = reg.inject({ sync: (...args) => { lastSync = args; } });
assert.ok(injected && typeof injected.setShell === "function");
assert.deepStrictEqual(lastSync, ["gitbash", 3, true], "initial snapshot pushed (user default gitbash)");

// setShell writes through to the settings scope
injected.setShell("wsl");
assert.deepStrictEqual(setCalls, [{ field: "defaultShell", value: "wsl" }]);

// row component renders a select reflecting the store value
const renderState = { shell: "wsl", revision: 3, writable: true };
const selectors = [];
const fakeUseStore = (sel) => { selectors.push(sel(renderState)); return selectors[selectors.length - 1]; };
const t = (k) => ({ "shell.title": "默认终端", "shell.powershell": "PowerShell", "shell.gitbash": "Git Bash", "shell.wsl": "WSL" }[k] ?? k);
const html = Component({ t, useStore: fakeUseStore, setShell: injected.setShell });
assert.ok(html && typeof html === "object", "component rendered");
assert.deepStrictEqual(selectors, ["wsl", true], "component reads shell + writable from store");

// settings change -> bound actions sync again (subscribe callback fires push)
scopeState = { status: "ready", value: { defaultShell: "powershell" }, revision: 4, writable: true };
// re-invoke the stored subscribe callback path: the bundle registered a
// subscription when apply ran; we captured nothing, so emulate by calling
// the register inject again with a fresh bound (fresh push uses new state).
const injected2 = reg.inject({ sync: (...args) => { lastSync = args; } });
assert.deepStrictEqual(lastSync, ["powershell", 4, true], "re-push after settings change");

console.log("CLIENT LOGIC TESTS PASSED");
