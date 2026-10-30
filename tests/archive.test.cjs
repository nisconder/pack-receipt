const test = require("node:test");
const assert = require("node:assert/strict");
const { gzipSync } = require("node:zlib");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const { readPackage, ArchiveError, LIMITS } = require("../archive.js");

const manifest = { name: "@demo/receipt-kit", version: "1.2.3", scripts: { preinstall: "never execute this" } };
const manifestText = JSON.stringify(manifest);

function writeText(buffer, text, offset, length) { Buffer.from(String(text)).copy(buffer, offset, 0, length); }
function writeOctal(buffer, number, offset, length) { writeText(buffer, number.toString(8).padStart(length - 1, "0") + "\0", offset, length); }
function entry(path, content = "", options = {}) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const header = Buffer.alloc(512);
  writeText(header, path, 0, 100);
  writeOctal(header, 0o644, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, options.size ?? body.length, 124, 12);
  writeOctal(header, 0, 136, 12);
  header.fill(32, 148, 156);
  header[156] = (options.type ?? "0").charCodeAt(0);
  writeText(header, options.linkname ?? "", 157, 100);
  writeText(header, options.magic ?? "ustar\0", 257, 6);
  writeText(header, "00", 263, 2);
  if (options.prefix) writeText(header, options.prefix, 345, 155);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  writeText(header, checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512)]);
}
function tar(...entries) { return Buffer.concat([...entries, Buffer.alloc(1024)]); }
function packageTar(...rest) { return tar(entry("package/package.json", manifestText), ...rest); }
function pax(records) {
  return Buffer.concat(Object.entries(records).map(([key, value]) => {
    const tail = `${key}=${value}\n`;
    let size = Buffer.byteLength(tail) + 2;
    for (;;) {
      const record = `${size} ${tail}`;
      if (Buffer.byteLength(record) === size) return Buffer.from(record);
      size = Buffer.byteLength(record);
    }
  }));
}
async function rejectsCode(value, code) {
  await assert.rejects(readPackage(value), (error) => error instanceof ArchiveError && error.code === code && /[\u4e00-\u9fff]/.test(error.message));
}

test("reads a gzip npm-style package without running lifecycle scripts", async () => {
  const archive = packageTar(entry("package/index.js", "console.log('hello')"));
  const compressed = gzipSync(archive);
  const result = await readPackage(compressed, { filename: "receipt-kit-1.2.3.tgz" });
  assert.equal(result.name, manifest.name);
  assert.equal(result.version, manifest.version);
  assert.deepEqual(result.manifest, manifest);
  assert.equal(result.compressedSize, compressed.length);
  assert.equal(result.totalUnpacked, Buffer.byteLength(manifestText) + Buffer.byteLength("console.log('hello')"));
  assert.deepEqual(result.entries.map((item) => item.path), ["package.json", "index.js"]);
  assert.equal(result.entries[1].type, "file");
  assert.ok(result.entries[1].bytes instanceof Uint8Array);
  assert.equal(Buffer.from(result.entries[1].bytes).toString(), "console.log('hello')");
  assert.deepEqual(result.warnings, []);
});

test("reads raw tar through ArrayBuffer and Blob inputs", async () => {
  const bytes = packageTar(entry("package/说明.txt", "你好，软件包"));
  const array = Uint8Array.from(bytes).buffer;
  const result = await readPackage(array);
  assert.equal(result.entries[1].path, "说明.txt");
  assert.equal(new TextDecoder().decode(result.entries[1].bytes), "你好，软件包");
  const blob = await readPackage(new Blob([bytes]));
  assert.equal(blob.compressedSize, bytes.length);
  assert.equal(blob.version, "1.2.3");
});

test("supports USTAR prefixes and common leading ./ directory roots", async () => {
  const bytes = tar(entry("./package/", "", { type: "5" }), entry("package.json", manifestText, { prefix: "package" }), entry("./package/lib/", "", { type: "5" }), entry("./package/lib/main.js", "42"));
  const result = await readPackage(bytes);
  assert.deepEqual(result.entries.map((item) => [item.path, item.type]), [["package.json", "file"], ["lib", "directory"], ["lib/main.js", "file"]]);
});

test("honors UTF-8 PAX path and decimal size rather than the placeholder header", async () => {
  const longPath = "package/资料/" + "长目录/".repeat(30) + "readme.md";
  const bytes = tar(
    entry("PaxHeader", pax({ path: "package/package.json", size: Buffer.byteLength(manifestText) }), { type: "x" }),
    entry("placeholder", manifestText, { size: 1 }),
    entry("PaxHeader", pax({ path: longPath }), { type: "x" }),
    entry("placeholder", "PAX data"),
  );
  const result = await readPackage(bytes);
  assert.equal(result.entries[1].path, longPath.slice(8));
  assert.equal(new TextDecoder().decode(result.entries[0].bytes), manifestText);
});

test("supports global PAX metadata and clears local PAX after a single file", async () => {
  const bytes = tar(
    entry("Global", pax({ comment: "global metadata", uid: "1000" }), { type: "g" }),
    entry("Local", pax({ path: "package/package.json" }), { type: "x" }),
    entry("placeholder", manifestText),
    entry("package/index.js", "ok"),
  );
  const result = await readPackage(bytes);
  assert.deepEqual(result.entries.map((item) => item.path), ["package.json", "index.js"]);
});

test("supports GNU long names and long link targets without following a link", async () => {
  const longPath = "package/" + "long-directory/".repeat(12) + "file.js";
  const target = "../".repeat(3) + "somewhere/".repeat(15) + "target";
  const bytes = packageTar(
    entry("././@LongLink", longPath + "\0", { type: "L", magic: "ustar " }),
    entry("short", "GNU data", { magic: "ustar " }),
    entry("././@LongLink", target + "\0", { type: "K", magic: "ustar " }),
    entry("package/alias", "", { type: "2", magic: "ustar " }),
  );
  const result = await readPackage(bytes);
  assert.equal(result.entries[1].path, longPath.slice(8));
  assert.equal(result.entries[2].type, "symlink");
  assert.equal(result.entries[2].bytes.length, 0);
  assert.equal(result.entries[2].linkname, target);
  assert.ok(result.warnings.some((warning) => warning.includes("不会跟随")));
  assert.ok(result.warnings.some((warning) => warning.includes("越出")));
});

test("rejects unsafe paths in base headers, PAX and GNU long names", async () => {
  for (const path of ["/etc/passwd", "../escape", "package/../../escape", "C:/escape", "package/file:stream", "package/dir\\file"]) {
    await rejectsCode(packageTar(entry(path, "bad")), "UNSAFE_PATH");
  }
  await rejectsCode(packageTar(entry("Pax", pax({ path: "package/../escape" }), { type: "x" }), entry("placeholder", "bad")), "UNSAFE_PATH");
  await rejectsCode(packageTar(entry("Long", "../../escape\0", { type: "L" }), entry("placeholder", "bad")), "UNSAFE_PATH");
});

test("rejects duplicate normalized paths instead of choosing an attacker-controlled winner", async () => {
  await rejectsCode(packageTar(entry("package/index.js", "first"), entry("./package/index.js", "second")), "DUPLICATE_PATH");
  await rejectsCode(packageTar(entry("package/lib/a.js", "first"), entry("package/lib/./a.js", "second")), "DUPLICATE_PATH");
});

test("treats symlinks and hardlinks only as metadata and rejects a linked manifest", async () => {
  const bytes = packageTar(entry("package/soft", "", { type: "2", linkname: "./index.js" }), entry("package/hard", "", { type: "1", linkname: "package/index.js" }));
  const result = await readPackage(bytes);
  assert.equal(result.entries[1].type, "symlink");
  assert.equal(result.entries[2].type, "hardlink");
  assert.equal(result.entries[2].bytes.byteLength, 0);
  assert.equal(result.totalUnpacked, Buffer.byteLength(manifestText));
  await rejectsCode(tar(entry("package/package.json", "", { type: "2", linkname: "/tmp/package.json" })), "MANIFEST_INVALID");
});

test("rejects a bad tar checksum and truncated payload/end blocks", async () => {
  const corrupt = packageTar();
  corrupt[0] ^= 1;
  await rejectsCode(corrupt, "TAR_CHECKSUM");
  const truncatedBody = packageTar().subarray(0, 512 + 3);
  await rejectsCode(truncatedBody, "TAR_TRUNCATED");
  const noEnd = packageTar().subarray(0, -1024);
  await rejectsCode(noEnd, "TAR_TRUNCATED");
  const halfEnd = packageTar().subarray(0, -512);
  await rejectsCode(halfEnd, "TAR_TRUNCATED");
});

test("rejects concatenated tar content and corrupted gzip streams", async () => {
  await rejectsCode(Buffer.concat([packageTar(), packageTar()]), "TAR_TRAILING_DATA");
  const compressed = gzipSync(packageTar());
  await rejectsCode(compressed.subarray(0, -3), "GZIP_INVALID");
  const invalid = Buffer.from(compressed);
  invalid[invalid.length - 8] ^= 1;
  await rejectsCode(invalid, "GZIP_INVALID");
});

test("rejects malformed PAX lengths, sizes and orphaned extension headers", async () => {
  await rejectsCode(packageTar(entry("Pax", "100 path=package/x\n", { type: "x" })), "PAX_INVALID");
  await rejectsCode(packageTar(entry("Pax", pax({ size: "-10" }), { type: "x" }), entry("package/index.js", "")), "PAX_INVALID");
  await rejectsCode(packageTar(entry("Pax", pax({ path: "package/orphan" }), { type: "x" })), "TAR_TRUNCATED");
});

test("requires a root JSON object manifest with reasonable name and version", async () => {
  await rejectsCode(tar(entry("package/index.js", "ok")), "MANIFEST_MISSING");
  for (const value of ["not json", "null", "[]", '{}', JSON.stringify({ name: "../bad", version: "1.0.0" }), JSON.stringify({ name: "good", version: {} })]) {
    await rejectsCode(tar(entry("package/package.json", value)), "MANIFEST_INVALID");
  }
  await rejectsCode(tar(entry("package/package.json", Buffer.from([0xff]))), "MANIFEST_INVALID");
});

test("enforces input, uncompressed stream and entry-count limits", async () => {
  await rejectsCode(new Uint8Array(LIMITS.inputBytes + 1), "INPUT_LIMIT");
  const bomb = gzipSync(Buffer.alloc(LIMITS.unpackedBytes + 1));
  await rejectsCode(bomb, "UNPACKED_LIMIT");
  const headers = Array.from({ length: LIMITS.entries + 1 }, (_, index) => entry("package/dir" + index, "", { type: "5" }));
  await rejectsCode(tar(...headers), "ENTRY_LIMIT");
});

test("rejects empty/unsupported inputs and oversized manifest metadata", async () => {
  await rejectsCode(new Uint8Array(), "INPUT_EMPTY");
  await rejectsCode("package.tgz", "INPUT_TYPE");
  await rejectsCode({ size: LIMITS.inputBytes + 1, arrayBuffer() { throw new Error("must not read"); } }, "INPUT_LIMIT");
  await rejectsCode(tar(entry("package/package.json", " ".repeat(LIMITS.manifestBytes + 1))), "MANIFEST_LIMIT");
});

test("exports the same parser as a browser UMD global without require", async () => {
  const context = vm.createContext({ TextDecoder, TextEncoder, Uint8Array, ArrayBuffer, ReadableStream, DecompressionStream });
  vm.runInContext(readFileSync(require.resolve("../archive.js"), "utf8"), context);
  assert.equal(typeof context.PackArchive.readPackage, "function");
  const result = await context.PackArchive.readPackage(Uint8Array.from(packageTar()));
  assert.equal(result.name, manifest.name);
  assert.equal(result.version, manifest.version);
});
