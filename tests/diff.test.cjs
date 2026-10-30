const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const { diffLines, readTextEntry } = require("../diff.js");

function reconstruct(result, side) {
  return result.rows.filter((row) => side === "before" ? row.type !== "add" : row.type !== "remove").map((row) => row.text + row.eol).join("");
}

function file(path, text, extra = {}) {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  return { path, type: "file", size: bytes.length, bytes, ...extra };
}

test("retains unchanged lines and exact text reconstruction", () => {
  const input = "one\ntwo\nthree\n";
  const result = diffLines(input, input);
  assert.equal(result.added, 0);
  assert.equal(result.removed, 0);
  assert.ok(result.rows.every((row) => row.type === "equal"));
  assert.deepEqual(result.rows.map((row) => [row.oldLine, row.newLine]), [[1, 1], [2, 2], [3, 3]]);
  assert.equal(reconstruct(result, "before"), input);
  assert.equal(reconstruct(result, "after"), input);
  assert.equal(result.countsExact, true);
});

test("finds adjacent replacements and marks them for paired changed styling", () => {
  const before = "start\nold value\nfinish\n";
  const after = "start\nnew value\nextra\nfinish\n";
  const result = diffLines(before, after);
  assert.equal(result.removed, 1);
  assert.equal(result.added, 2);
  assert.ok(result.rows.filter((row) => row.type !== "equal").every((row) => row.changed));
  assert.equal(reconstruct(result, "before"), before);
  assert.equal(reconstruct(result, "after"), after);
  assert.deepEqual(result.rows.at(-1), { type: "equal", text: "finish", eol: "\n", oldLine: 3, newLine: 4 });
});

test("distinguishes empty files, added files, deleted files and actual blank lines", () => {
  assert.deepEqual(diffLines("", "").rows, []);
  assert.equal(diffLines("", "").before.lineCount, 0);
  const add = diffLines("", "first\n\n");
  assert.equal(add.added, 2);
  assert.equal(add.removed, 0);
  assert.equal(reconstruct(add, "after"), "first\n\n");
  assert.deepEqual(add.rows.map((row) => row.oldLine), [null, null]);
  assert.ok(add.rows.every((row) => !row.changed));
  const remove = diffLines("last", "");
  assert.equal(remove.removed, 1);
  assert.equal(remove.rows[0].newLine, null);
  assert.equal(reconstruct(remove, "before"), "last");
});

test("matches repeated lines without losing or inventing source content", () => {
  const before = "a\nsame\nb\nsame\nc\n";
  const after = "same\na\nsame\nc\nsame\n";
  const result = diffLines(before, after);
  assert.equal(reconstruct(result, "before"), before);
  assert.equal(reconstruct(result, "after"), after);
  assert.equal(result.limited, undefined);
});

test("reconstructs both sides across repeated-line and mixed-ending combinations", () => {
  let seed = 1729;
  const random = (max) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  const makeText = () => Array.from({ length: random(18) }, () => ["", "a", "same", "你好", "😀"][random(5)] + ["\n", "\r\n", "\r", ""][random(4)]).join("");
  for (let index = 0; index < 200; index += 1) {
    const before = makeText();
    const after = makeText();
    const result = diffLines(before, after);
    assert.equal(reconstruct(result, "before"), before, "before reconstruction " + index);
    assert.equal(reconstruct(result, "after"), after, "after reconstruction " + index);
    assert.equal(result.countsExact, true);
  }
});

test("preserves CRLF, LF, CR and final-newline differences", () => {
  const result = diffLines("alpha\r\nbeta\r\n", "alpha\nbeta");
  assert.equal(reconstruct(result, "before"), "alpha\r\nbeta\r\n");
  assert.equal(reconstruct(result, "after"), "alpha\nbeta");
  assert.equal(result.removed, 2);
  assert.equal(result.added, 2);
  assert.equal(result.before.lineEnding, "CRLF");
  assert.equal(result.after.lineEnding, "LF");
  assert.equal(result.before.finalNewline, true);
  assert.equal(result.after.finalNewline, false);
  const mixed = diffLines("a\rb\r\nc\n", "a\rb\r\nc\n");
  assert.equal(mixed.before.lineEnding, "mixed");
  assert.equal(mixed.before.lineCount, 3);
  const final = diffLines("value", "value\n");
  assert.equal(final.removed, 1);
  assert.equal(final.added, 1);
});

test("bounded LCS falls back explicitly without pretending a block preview is an exact diff", () => {
  const before = "a\nb\nc\nd\n";
  const after = "d\nc\nb\na\n";
  const result = diffLines(before, after, { maxCells: 4 });
  assert.equal(result.limited, true);
  assert.equal(result.countsExact, false);
  assert.match(result.message, /不是精确/);
  assert.equal(reconstruct(result, "before"), before);
  assert.equal(reconstruct(result, "after"), after);
});

test("large inputs have bounded compute and output row budgets", () => {
  const before = Array.from({ length: 10000 }, (_, index) => "old " + index).join("\n");
  const after = Array.from({ length: 10000 }, (_, index) => "new " + index).join("\n");
  const result = diffLines(before, after);
  assert.equal(result.limited, true);
  assert.equal(result.truncated, true);
  assert.equal(result.countsExact, false);
  assert.ok(result.rows.length <= 3000);
  assert.equal(result.before.lineCount, null);
  assert.equal(result.after.complete, false);
  assert.match(result.message, /预算/);
});

test("row caps are explicit and count only the emitted preview", () => {
  const result = diffLines("a\nb\nc\n", "d\ne\nf\n", { maxRows: 2 });
  assert.equal(result.rows.length, 2);
  assert.equal(result.limited, true);
  assert.equal(result.truncated, true);
  assert.equal(result.removed, 2);
  assert.equal(result.added, 0);
  assert.equal(result.countsExact, false);
});

test("budgets cannot be raised above the hard safety ceiling by caller options", () => {
  const text = "value\n".repeat(5000);
  const result = diffLines(text, text, { maxLines: 1000000, maxRows: 1000000, maxCells: Number.MAX_SAFE_INTEGER, maxChars: Number.MAX_SAFE_INTEGER });
  assert.ok(result.rows.length <= 3000);
  assert.equal(result.limited, true);
  assert.equal(result.truncated, true);
  assert.equal(result.before.previewLines, 3000);
});

test("shared large prefixes and suffixes avoid a quadratic allocation", () => {
  const head = "same\n".repeat(1000);
  const tail = "also same\n".repeat(1000);
  const result = diffLines(head + "old\n" + tail, head + "new\n" + tail, { maxCells: 4 });
  assert.equal(result.limited, undefined);
  assert.equal(result.removed, 1);
  assert.equal(result.added, 1);
});

test("readTextEntry preserves a real empty file and distinguishes metadata-only contents", () => {
  const pkg = { entries: [file("empty.js", ""), { path: "metadata.js", type: "file", size: 100 }, { path: "no-content.js", type: "file", size: 3, bytes: new Uint8Array() }] };
  assert.deepEqual(readTextEntry(pkg, "empty.js"), { kind: "text", text: "", message: "", truncated: false });
  assert.equal(readTextEntry(pkg, "metadata.js").kind, "unavailable");
  assert.equal(readTextEntry(pkg, "no-content.js").kind, "unavailable");
  assert.equal(readTextEntry(pkg, "missing.js").kind, "missing");
  assert.equal(readTextEntry(null, "file").kind, "unavailable");
  assert.equal(readTextEntry(pkg, "metadata.js").text, null);
});

test("readTextEntry truncates UTF-8 without adding replacement characters or splitting a code point", () => {
  const pkg = { entries: [file("unicode.txt", "a你😀好")] };
  const first = readTextEntry(pkg, "unicode.txt", { maxBytes: 3 });
  assert.equal(first.text, "a");
  assert.equal(first.truncated, true);
  const emoji = readTextEntry(pkg, "unicode.txt", { maxBytes: 7 });
  assert.equal(emoji.text, "a你");
  assert.doesNotMatch(emoji.text, /�/);
  assert.equal(readTextEntry(pkg, "unicode.txt", { maxBytes: 8 }).text, "a你😀");
  assert.equal(readTextEntry(pkg, "unicode.txt", { maxBytes: 0 }).text, "");
});

test("readTextEntry handles invalid UTF-8 and binary control bytes without fabricating diff text", () => {
  const pkg = { entries: [file("bad.bin", Uint8Array.of(0xff)), file("incomplete.bin", Uint8Array.of(0xe2)), file("null.bin", Uint8Array.of(65, 0, 66))] };
  for (const path of ["bad.bin", "incomplete.bin", "null.bin"]) {
    const result = readTextEntry(pkg, path);
    assert.equal(result.kind, "binary");
    assert.equal(result.text, null);
    assert.ok(result.message.length > 0);
  }
});

test("readTextEntry preserves a UTF-8 BOM and original line endings", () => {
  const input = "\uFEFFhello\r\nworld\r\n";
  const result = readTextEntry({ entries: [file("bom.txt", input)] }, "bom.txt");
  assert.equal(result.text, input);
});

test("links and special files remain metadata rather than becoming fake text lines", () => {
  const pkg = { entries: [
    { path: "soft", type: "symlink", linkname: "target", bytes: new Uint8Array() },
    { path: "hard", type: "hardlink", linkname: "target", bytes: new Uint8Array() },
    { path: "dir", type: "directory", bytes: new Uint8Array() },
    { path: "device", type: "special", bytes: new Uint8Array() },
  ] };
  for (const path of ["soft", "hard"]) assert.equal(readTextEntry(pkg, path).kind, "link");
  for (const path of ["dir", "device"]) assert.equal(readTextEntry(pkg, path).kind, "special");
  for (const item of pkg.entries) assert.equal(readTextEntry(pkg, item.path).text, null);
});

test("exports the diff helper as a browser UMD global", () => {
  const context = vm.createContext({ TextDecoder, Uint8Array, ArrayBuffer });
  vm.runInContext(readFileSync(require.resolve("../diff.js"), "utf8"), context);
  assert.equal(typeof context.PackDiff.diffLines, "function");
  assert.equal(context.PackDiff.diffLines("before", "after").added, 1);
});
