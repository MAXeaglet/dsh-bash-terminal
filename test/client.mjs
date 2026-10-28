// Client plugin logic test: load lib/client.js under a mocked __ModuleLoader__
// and exercise apply(ctx) against the DSH 0.2.x settings seam
// (`configForms` + keyed row/bundle slots) instead of the removed 0.1.x
// `settingsScope` / `settings.general.item` pair.
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

// --- load the built client bundle under a fake module loader ---
const bundle = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
assert.ok(bundle.includes("window.__ModuleLoader__.load"), "bundle wrapped");
// Regression guards for the retired seams: the 0.2.x client must not reach for
// `settingsScope` or the old runtime package name again.
assert.ok(bundle.includes("@deepseek-ai/dsh-client-ui-primitives"), "requests the platform primitives seed");
assert.ok(bundle.includes("configForms"), "uses the 0.2.x configForms seam");
assert.ok(bundle.includes("plugins.row.config"), "registers the keyed row slot");
assert.ok(bundle.includes("plugins.bundle.config"), "registers the keyed bundle slot");
assert.ok(!bundle.includes("settingsScope"), "does not use the removed settingsScope service");
assert.ok(!bundle.includes("dsh-client-runtime"), "does not request the retired client runtime");

let exported;
globalThis.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      assert.strictEqual(id, "dsh-bash-terminal");
      exported = factory((name) => {
        if (name === "react" || name === "react/jsx-runtime") return loadShared(name);
        if (name === "@deepseek-ai/dsh-client-ui-primitives") {
          const React = loadShared("react");
          // Only the two components this bundle destructures are needed; the
          // registration surface is what the assertions below inspect.
          return {
            SegmentedControl: (props) => React.createElement("div", null, props.children),
            SettingsForm: (props) => React.createElement("div", null, props.children)
          };
        }
        throw new Error("unexpected require: " + name);
      });
    }
  }
};
new Function(bundle)();
assert.ok(exported, "client module exports");
assert.deepStrictEqual(exported.inject, ["slots", "locale", "configForms"]);
assert.strictEqual(typeof exported.apply, "function");

// --- mocked services ---
const localeBinds = [];
const localeRegisters = [];
const whileServedCalls = [];
const slotInjections = [];
const slotRegistrations = [];
const disposers = [];
const ctx = {
  locale: {
    bind: (ns) => { localeBinds.push(ns); },
    register: (ns, dicts) => { localeRegisters.push({ ns, dicts }); return () => {}; }
  },
  effect: (fn) => { const d = fn(); if (typeof d === "function") disposers.push(d); return d; },
  configForms: {
    whileServed: (namespaces, fn) => { whileServedCalls.push(namespaces); return fn(); }
  },
  slots: {
    inject: (slot, fn) => { slotInjections.push(slot); return fn(); },
    register: (options, Component) => { slotRegistrations.push({ options, Component }); return () => {}; }
  }
};

// --- run apply ---
exported.apply(ctx);
assert.strictEqual(disposers.length >= 2, true, "effects registered disposers");

// locale dictionaries bound + registered for this page's namespace
assert.deepStrictEqual(localeBinds, ["settings.bashTerminal"]);
assert.strictEqual(localeRegisters.length, 1);
assert.strictEqual(localeRegisters[0].ns, "settings.bashTerminal");
assert.ok(localeRegisters[0].dicts.zh.title, "zh dictionary provided");
assert.ok(localeRegisters[0].dicts.en.title, "en dictionary provided");

// the pages only appear once the Host serves the plugin's namespace
assert.deepStrictEqual(whileServedCalls, [["tool-bash-terminal"]]);
assert.deepStrictEqual(slotInjections, ["plugins.row.config", "plugins.bundle.config"]);

// row page: keyed "<package>#<row id>" exactly as the Plugins page computes it
assert.strictEqual(slotRegistrations.length, 2);
const row = slotRegistrations.find((r) => r.options.name === "plugins.row.config");
const bundlePage = slotRegistrations.find((r) => r.options.name === "plugins.bundle.config");
assert.ok(row, "row registration present");
assert.ok(bundlePage, "bundle registration present");
assert.strictEqual(row.options.key, "dsh-bash-terminal#tool-bash-terminal");
assert.strictEqual(row.options.locale, "settings.bashTerminal");
assert.strictEqual(bundlePage.options.key, "dsh-bash-terminal");
assert.strictEqual(typeof row.Component, "function", "row component passed");
assert.strictEqual(typeof bundlePage.Component, "function", "bundle summary component passed");

// disposers are safe to call (module unload path)
for (const dispose of disposers) dispose();

console.log("CLIENT LOGIC TESTS PASSED");
