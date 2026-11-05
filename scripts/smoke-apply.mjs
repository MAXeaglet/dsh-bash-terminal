// Deploy smoke test: does the plugin still APPLY under a DSH-shaped context?
//
// `node --check` only proves the files parse. This loads lib/index.js, runs
// apply() against a fake fiber context that mirrors the real seams, and asserts
// both tools register and the system-prompt section is declared - the failure
// mode being guarded is a Config/schema or registration error that would take
// the whole harness down at mount time, not just this plugin.
//
// Run before copying the build into a live profile:
//   node scripts/smoke-apply.mjs
import { apply, Config } from "../lib/index.js";

const registered = [];
const sections = [];
const listeners = [];
const logs = [];

const ctx = {
  logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  systemPrompt: { section: (s) => sections.push(s) },
  tools: { register: (t) => registered.push(t) },
  shellEnv: { collect: () => ({}) },
  subprocess: { spawn: () => { throw new Error("not used in smoke test"); } },
  sandbox: { confine: (argv) => ({ argv, enforcement: "smoke" }) },
  sandboxPolicy: { resolve: () => ({ mode: "danger-full-access" }) },
  effect: () => () => {},
  on: (event, handler) => listeners.push({ event, handler }),
  get: (key) => (key === "jobs" ? undefined : undefined)
};

// The defaults the live profile actually mounts with (cordis.patch.yml).
const config = { defaultShell: "wsl" };
apply(ctx, config);

const names = registered.map((t) => t.name).sort();
console.log("registered tools:", JSON.stringify(names));
console.log("prompt sections:", JSON.stringify(sections.map((s) => s.name)));
console.log("prompt listeners:", JSON.stringify(listeners.map((l) => l.event)));

if (!names.includes("shell")) throw new Error("the shell tool did not register");
if (!names.includes("terminal")) throw new Error("the terminal tool did not register");
if (!sections.some((s) => s.name === "tool:bash-terminal")) throw new Error("the system-prompt section was not declared");

const terminal = registered.find((t) => t.name === "terminal");
if (!terminal.parameters.properties.action.enum.includes("ssh")) throw new Error("the ssh action is missing from the live tool schema");
if (terminal.parameters.properties.sshHost === undefined) throw new Error("sshHost is missing from the live tool schema");

// The description must carry the routing that makes the model pick a session.
if (!terminal.description.includes("action \"ssh\"")) throw new Error("the terminal description does not advertise the ssh action");

const shell = registered.find((t) => t.name === "shell");
if (!shell.description.includes("use the terminal tool when state must survive")) throw new Error("the shell description does not route stateful work to the terminal tool");

// The prompt section is the strongest nudge; it must name the terminal tool.
const section = sections.find((s) => s.name === "tool:bash-terminal");
if (!section.text.includes("terminal tool")) throw new Error("the system-prompt section does not mention the terminal tool");
if (!section.text.includes("sshHost")) throw new Error("the system-prompt section does not mention sshHost");

// A volatile field arrives as a live ref in 0.2.x; apply() must read through it.
const live = {
  ...ctx,
  logger: { info: () => {}, warn: () => {} },
  tools: { register: () => {} },
  systemPrompt: { section: () => {} }
};
const refConfig = {
  defaultShell: { get: () => "gitbash" },
  sshShell: { get: () => "wsl" }
};
apply(live, refConfig);

// The exported Config must accept the mounted shape without throwing. A
// `.volatile()` field comes back as a live ref (that is what makes it the
// plugin's hot-reloadable settings section), so read it through `.get()`.
const parsed = Config({ defaultShell: "wsl" });
const readField = (value) => (value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value);
console.log("config defaults:", JSON.stringify({ defaultShell: readField(parsed.defaultShell), sshShell: readField(parsed.sshShell), timeoutMs: parsed.timeoutMs }));
if (readField(parsed.sshShell) !== "wsl") throw new Error("the sshShell config default is not wsl: " + readField(parsed.sshShell));
if (readField(Config({ sshShell: "gitbash" }).sshShell) !== "gitbash") throw new Error("an explicit sshShell is not honored");

console.log("PLUGIN APPLY SMOKE TEST PASSED");
process.exit(0);
