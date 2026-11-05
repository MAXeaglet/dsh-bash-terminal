// Manual contract probe (NOT part of `npm test`): needs the DSH @deepseek-ai/*
// tree resolvable, i.e. run it in a project dir whose node_modules/@deepseek-ai
// points at the DSH install (see COMPATIBILITY-DSH-NEWEST.md).
// Integration probe: feed the EXACT job spec shape the fixed plugin produces
// into the real @deepseek-ai/dsh-jobs-local registry of this DSH install.
import { Context } from "@deepseek-ai/cordis";
import * as jobsPlugin from "@deepseek-ai/dsh-jobs-local";

const ctx = new Context();
const agentCtx = ctx;
ctx.provide("agents");
ctx.set("agents", { get: (id) => (id === "session-1" ? { id: "session-1", ctx: agentCtx } : undefined) });
console.log("module keys:", Object.keys(jobsPlugin).join(","));
ctx.plugin(jobsPlugin.default ?? jobsPlugin, {});
await new Promise((resolve) => setTimeout(resolve, 200));

const registry = ctx.get("jobs");
if (registry === undefined) throw new Error("jobs service did not mount");
registry.attachController("probe");

// The plugin's terminal-session spec, verbatim in shape.
const pending = "session output line one\nsession output line two\n";
let reads = 0;
const id = registry.start({
  kind: "terminal/session",
  label: "terminal probe (gitbash)",
  owner: "session-1",
  output: [{
    channel: "stdout",
    read: (from) => {
      reads += 1;
      if (from >= pending.length) return { text: "", nextOffset: from, lossy: false };
      return { text: pending.slice(from), nextOffset: pending.length, lossy: false };
    }
  }],
  run: () => ({
    cancel: () => {},
    done: Promise.resolve({ status: "completed", detail: "exit code: 7" })
  })
});
console.log("job id:", id);
console.log("job view:", JSON.stringify({ status: registry.get(id, "session-1").status, owner: registry.get(id, "session-1").owner }));
await new Promise((resolve) => setTimeout(resolve, 500));
const read = registry.read(id, "session-1");
console.log("pump reads:", reads);
console.log("chunks:", JSON.stringify(read.chunks.map((c) => ({ at: c.at, channel: c.channel, text: c.text }))));
console.log("read lossy:", read.lossy, "result:", JSON.stringify(read.result));
console.log("final status:", registry.get(id, "session-1").status);
const ok = read.chunks.length > 0
  && read.chunks.map((c) => c.text).join("") === pending
  && registry.get(id, "session-1").status === "completed";
console.log(ok ? "REAL JOB REGISTRY: OK" : "REAL JOB REGISTRY: FAILED");
process.exit(ok ? 0 : 1);
