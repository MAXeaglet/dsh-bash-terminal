// Incremental-delivery tests: absolute stream offsets, byte-accurate caps, line
// framing, per-reply paging, terminal rendering, and the job-facing shapes.
// Pure logic - no PTY is started here.
import {
  createBuffer,
  createTerminalRegistry,
  fitChars,
  internals,
  ptyOutcome,
  scrubTerminalText,
  sessionSource,
  sliceReply,
  tailChars
} from "../lib/terminal.js";
import assert from "node:assert";

const { MAX_REPLY_BYTES, FLUSH_BYTES, ORIENT_CHARS } = internals;
const byteLength = (text) => Buffer.byteLength(text, "utf8");
const lines = (count) => Array.from({ length: count }, (_, i) => "line " + i + "\n").join("");

// ---- retention is byte-accurate and never splits a character ----------------
const ring = createBuffer(30);
ring.append("привет");
ring.append("мир");
ring.append("ё".repeat(50));
assert.ok(byteLength(ring.snapshot()) <= 30, "the cap counts UTF-8 bytes: " + byteLength(ring.snapshot()));
assert.strictEqual(ring.snapshot(), "ё".repeat(15), "the ring keeps the newest text, cut to the cap");
assert.ok(!ring.snapshot().includes("\ufffd"), "no broken character survives the trim");

const emoji = createBuffer(6);
emoji.append("😀😀😀");
assert.strictEqual(emoji.snapshot(), "😀", "a surrogate pair is never cut in half");
assert.strictEqual(tailChars("😀😀😀", 6), 2, "tailChars counts UTF-16 code units (2 per emoji), so the count is a slice bound");
assert.strictEqual(fitChars("😀😀😀", 6), 2);
assert.strictEqual(fitChars("привет", 4), 2);
assert.strictEqual(fitChars("abc", 99), 3);
assert.strictEqual(fitChars("abc", 0), 0);
assert.strictEqual(tailChars("abc", 0), 0);

// ---- offsets are absolute: they do not shift when the ring drops text -------
const abs = createBuffer(64);
abs.append("hello\n");
assert.deepStrictEqual(abs.readFrom(0), { delta: "hello\n", nextOffset: 6, elided: 0 });
abs.append("x".repeat(200));
const fromZero = abs.readFrom(0);
assert.strictEqual(fromZero.nextOffset, abs.end(), "nextOffset is the absolute end of the stream");
assert.strictEqual(fromZero.delta, abs.snapshot());
assert.ok(fromZero.elided > 0, "evicted text is reported as elided, not silently shifted: " + fromZero.elided);
const held = abs.end();
abs.append("tail\n");
assert.deepStrictEqual(abs.readFrom(held), { delta: "tail\n", nextOffset: held + 5, elided: 0 }, "a cursor held across an eviction still reads exactly what follows it");

// ---- line framing: a reply stops at the last complete line ------------------
const prompt = createBuffer();
prompt.append("PS> ");
const framed = sliceReply(prompt, 0);
assert.strictEqual(framed.output, "", "an unterminated tail alone is not delivered as output");
assert.strictEqual(framed.nextOffset, 0, "the cursor stays before the held-back tail");
assert.strictEqual(framed.pending, "PS> ", "the tail is reported as pending");
assert.strictEqual(framed.more, false);
prompt.append("echo hi\r\nhi\r\nPS> ");
const after = sliceReply(prompt, 0);
assert.strictEqual(after.output, "PS> echo hi\nhi\n", "delivered text stops at the last newline and is terminal-rendered");
assert.strictEqual(after.pending, "PS> ");
assert.strictEqual(after.nextOffset, "PS> echo hi\r\nhi\r\n".length);

// ---- a burst without any newline is still delivered -------------------------
const burst = createBuffer();
burst.append("x".repeat(FLUSH_BYTES + 7));
const flushed = sliceReply(burst, 0);
assert.ok(flushed.output.length > 0, "output with no newline at all is delivered once it is large enough");
assert.ok(byteLength(flushed.output) <= MAX_REPLY_BYTES, "the flush valve still honours the reply cap");
assert.strictEqual(flushed.pending, undefined, "everything was delivered - nothing is pending");

// ---- the per-reply cap pages instead of losing output -----------------------
const source = lines(20000);
const paged = createBuffer();
paged.append(source);
let cursorAt = 0;
let reassembled = "";
let pages = 0;
for (;;) {
  const reply = sliceReply(paged, cursorAt);
  assert.ok(byteLength(reply.output) <= MAX_REPLY_BYTES, "one reply never exceeds the cap: " + byteLength(reply.output));
  reassembled += reply.output;
  cursorAt = reply.nextOffset;
  pages += 1;
  if (reply.more !== true || pages >= 50) break;
}
assert.ok(pages > 3, "a large burst is paged over several replies, got " + pages);
assert.strictEqual(reassembled, source, "paging loses nothing and repeats nothing");

// ---- terminal rendering -----------------------------------------------------
assert.strictEqual(scrubTerminalText("\u001b[2J\u001b[?2004hhi\u001b]0;title\u0007"), "hi");
assert.strictEqual(scrubTerminalText("50%\r100%\r"), "100%");
assert.strictEqual(scrubTerminalText("a\u0007b"), "ab");
assert.strictEqual(scrubTerminalText("keep\n  \u001b[32mgreen\u001b[0m\n"), "keep\n  green\n");
assert.strictEqual(scrubTerminalText("raw\r\nwin\r\n"), "raw\nwin\n");

const rawRing = createBuffer();
rawRing.append("\u001b[31mRED\u001b[0m\n");
assert.strictEqual(sliceReply(rawRing, 0).output, "RED\n", "replies are rendered by default");
assert.strictEqual(sliceReply(rawRing, 0, true).output, "\u001b[31mRED\u001b[0m\n", "raw: true keeps the untouched stream");

// a tail that renders to nothing is not a tail
const controlOnly = createBuffer();
controlOnly.append("\u001b[?2004h");
const controlReply = sliceReply(controlOnly, 0);
assert.strictEqual(controlReply.output, "", "a control-only delta delivers no output");
assert.strictEqual(controlReply.pending, undefined, "a control-only tail is not reported as pending");

// ---- job-facing shapes ------------------------------------------------------
assert.deepStrictEqual(ptyOutcome({ exitCode: 0, signal: 0 }), { status: "completed", detail: "exit code: 0" });
assert.deepStrictEqual(ptyOutcome({ exitCode: 1, signal: null }), { status: "completed", detail: "exit code: 1" });
assert.deepStrictEqual(ptyOutcome({ exitCode: null, signal: 15 }), { status: "killed", detail: "signal: 15" });
assert.deepStrictEqual(ptyOutcome(undefined), { status: "completed", detail: "exit code: 0" });
assert.deepStrictEqual(ptyOutcome({ exitCode: -1073741510, signal: 0 }, true), { status: "killed", detail: "session terminated" }, "a session we terminated is killed, not a natural exit");

const srcRing = createBuffer(32);
srcRing.append("src-line\n".repeat(20));
const src = sessionSource({ buffer: srcRing });
assert.strictEqual(src.channel, "stdout");
const srcFirst = src.read(0);
assert.strictEqual(srcFirst.text, srcRing.snapshot());
assert.strictEqual(srcFirst.nextOffset, srcRing.end());
assert.strictEqual(srcFirst.lossy, true, "a source starting before the retained text reports the gap");
assert.deepStrictEqual(src.read(srcFirst.nextOffset), { text: "", nextOffset: srcFirst.nextOffset, lossy: false });
assert.deepStrictEqual(src.read(0), srcFirst, "sources are non-consuming: the same offset reads the same text");

// ---- reader cursors ---------------------------------------------------------
const registry = createTerminalRegistry({ effect: () => () => {} });
const session = { id: "s1", buffer: createBuffer(), cursors: new Map() };
assert.strictEqual(registry.deliver(session, "agent-a", { from: 0 }).output, "");
session.buffer.append("a1\n");
const a2 = registry.deliver(session, "agent-a");
assert.strictEqual(a2.output, "a1\n", "the second read carries only what appeared since the first");
assert.strictEqual(a2.elided, undefined, "a reader that already read is never 'elided'");
assert.strictEqual(registry.deliver(session, "agent-b").output, "a1\n", "a second reader gets the stream from its own cursor");
assert.strictEqual(registry.deliver(session, "agent-a").output, "", "one reader's read does not consume another reader's output");

const longSession = { id: "s2", buffer: createBuffer(), cursors: new Map() };
longSession.buffer.append(lines(2000));
const fresh = registry.deliver(longSession, "agent-c");
assert.ok(fresh.elided >= ORIENT_CHARS / 2, "a fresh reader is oriented with the tail window, not the whole ring: " + fresh.elided);
assert.ok(fresh.output.length > 0, "the orientation window carries output");
assert.strictEqual(registry.deliver(longSession, "agent-c").output, "", "after orientation the cursor is current");

const evicted = registry.deliver({ id: "s4", buffer: ring, cursors: new Map() }, "agent-e", { from: 0 });
assert.ok(evicted.elided > 0, "asking for text the ring already dropped reports the gap: " + evicted.elided);

const capSession = { id: "s3", buffer: createBuffer(), cursors: new Map() };
const big = lines(20000);
capSession.buffer.append(big);
let got = "";
let rounds = 0;
for (;;) {
  const reply = registry.deliver(capSession, "agent-d", rounds === 0 ? { from: 0 } : {});
  got += reply.output;
  rounds += 1;
  if (reply.more !== true || rounds >= 50) break;
}
assert.ok(rounds > 3, "the capped reply pages through the burst: " + rounds);
assert.strictEqual(got, big, "the reader cursor advances only past the text it was handed");

// ---- tool-surface helpers ---------------------------------------------------
assert.strictEqual(internals.readerKey({ agent: { id: "session-9" } }), "session-9");
assert.strictEqual(internals.readerKey({}), "shared");
assert.throws(() => internals.validateArgs({ action: "read", sessionId: "s", from: -1 }), /invalid from/);
assert.throws(() => internals.validateArgs({ action: "read", sessionId: "s", from: 1.5 }), /invalid from/);
assert.throws(() => internals.validateArgs({ action: "read", sessionId: "s", from: 1, full: true }), /either from or full/);
assert.throws(() => internals.validateArgs({ action: "list", from: 0 }), /from\/full apply/);
assert.throws(() => internals.validateArgs({ action: "read", sessionId: "s", raw: "yes" }), /invalid raw/);
internals.validateArgs({ action: "read", sessionId: "s", from: 0, raw: true });

const rendered = internals.renderReply({ output: "hi\n", nextOffset: 12, more: true, pending: "PS> " });
assert.ok(rendered.includes("hi"), "output is rendered: " + JSON.stringify(rendered));
assert.ok(rendered.includes("more output waiting"));
assert.ok(rendered.includes("offset 12"));
assert.ok(rendered.includes("tail without newline"));
assert.ok(internals.renderReply({ output: "", nextOffset: 3 }).includes("offset 3"), "an empty reply still reports its offset");

console.log("BUFFER/DELIVERY TESTS PASSED");
