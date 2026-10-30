const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const { sortFiles, directoryItems, squarify } = require("../file-tools.js");

function paths(rows) { return rows.map((row) => row.path); }
function file(path, size, type = "file") { return { path, size, type }; }
function near(actual, expected, tolerance = 1e-7) { assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be within ${tolerance} of ${expected}`); }

test("sorts signed deltas numerically rather than by magnitude or formatted strings", () => {
  const rows = [
    { path: "up", delta: 100 }, { path: "down-big", delta: -1000 },
    { path: "same", delta: 0 }, { path: "down-small", delta: -2 }, { path: "up-big", delta: 1000 },
  ];
  assert.deepEqual(paths(sortFiles(rows, { key: "delta", direction: "asc" })), ["down-big", "down-small", "same", "up", "up-big"]);
  assert.deepEqual(paths(sortFiles(rows, { key: "delta", direction: "desc" })), ["up-big", "up", "same", "down-small", "down-big"]);
  assert.deepEqual(paths(rows), ["up", "down-big", "same", "down-small", "up-big"]);
});

test("sorts kinds by the requested added/changed/removed/unchanged order", () => {
  const rows = [
    { path: "keep", kind: "unchanged" }, { path: "gone", kind: "removed" },
    { path: "changed", kind: "changed" }, { path: "new", kind: "added" },
  ];
  assert.deepEqual(paths(sortFiles(rows, { key: "kind", direction: "asc" })), ["new", "changed", "gone", "keep"]);
});

test("keeps stable path tie-breaking and never mutates the input", () => {
  const rows = Object.freeze([Object.freeze({ path: "z", size: 10 }), Object.freeze({ path: "a", size: 10 }), Object.freeze({ path: "m", size: 2 })]);
  const result = sortFiles(rows, { key: "size", direction: "desc" });
  assert.deepEqual(paths(result), ["a", "z", "m"]);
  assert.deepEqual(paths(rows), ["z", "a", "m"]);
  assert.notEqual(result, rows);
  assert.equal(result[0], rows[1]);
  assert.deepEqual(paths(sortFiles(rows, { key: "path", direction: "desc" })), ["z", "m", "a"]);
});

test("groups regular nonempty files by the next directory level and supports drill-down", () => {
  const entries = [file("package.json", 10), file("dist/index.js", 60), file("dist/chunks/a.js", 30), file("src/source.js", 5)];
  assert.deepEqual(directoryItems(entries), [
    { path: "dist/", label: "dist/", size: 90, count: 2, directory: true },
    { path: "package.json", label: "package.json", size: 10, count: 1, directory: false },
    { path: "src/", label: "src/", size: 5, count: 1, directory: true },
  ]);
  assert.deepEqual(directoryItems(entries, "dist/"), [
    { path: "dist/index.js", label: "index.js", size: 60, count: 1, directory: false },
    { path: "dist/chunks/", label: "chunks/", size: 30, count: 1, directory: true },
  ]);
  assert.deepEqual(directoryItems(entries, "dist/chunks/"), [
    { path: "dist/chunks/a.js", label: "a.js", size: 30, count: 1, directory: false },
  ]);
});

test("directory prefixes match component boundaries and flat mode returns actual files", () => {
  const entries = [file("dist/a.js", 3), file("distribution/b.js", 20), file("dist/chunk/c.js", 5), file("dist-extra/d.js", 30)];
  assert.equal(directoryItems(entries, "dist").reduce((sum, row) => sum + row.size, 0), 8);
  assert.deepEqual(directoryItems(entries, "dist/", true), [
    { path: "dist/chunk/c.js", label: "chunk/c.js", size: 5, count: 1, directory: false },
    { path: "dist/a.js", label: "a.js", size: 3, count: 1, directory: false },
  ]);
  assert.deepEqual(directoryItems(entries, "missing/"), []);
});

test("excludes symlinks, hardlinks, special files, directories and zero/invalid sizes from volume", () => {
  const entries = [
    file("real", 8), file("empty", 0), file("link", 100, "symlink"), file("hard", 200, "hardlink"),
    file("dir/", 300, "directory"), file("device", 400, "special"), file("bad", NaN), file("negative", -10), file("infinite", Infinity),
  ];
  assert.deepEqual(directoryItems(entries), [{ path: "real", label: "real", size: 8, count: 1, directory: false }]);
  assert.equal(directoryItems(entries, "", true).length, 1);
});

function verifyLayout(items, width, height) {
  const snapshot = JSON.stringify(items);
  const rectangles = squarify(items, width, height);
  assert.equal(JSON.stringify(items), snapshot, "layout must not mutate source rows");
  const valid = items.filter((item) => Number.isFinite(item.size) && item.size > 0);
  assert.equal(rectangles.length, valid.length);
  const totalWeight = valid.reduce((sum, item) => sum + item.size, 0);
  let totalArea = 0;
  for (const rect of rectangles) {
    for (const key of ["x", "y", "width", "height"]) assert.ok(Number.isFinite(rect[key]), key + " must be finite");
    assert.ok(rect.width >= 0 && rect.height >= 0);
    assert.ok(rect.x >= -1e-8 && rect.y >= -1e-8);
    assert.ok(rect.x + rect.width <= width + 1e-8);
    assert.ok(rect.y + rect.height <= height + 1e-8);
    const area = rect.width * rect.height;
    near(area, width * height * rect.size / totalWeight, width * height * 1e-8);
    totalArea += area;
  }
  near(totalArea, width * height, width * height * 1e-8);
  for (let i = 0; i < rectangles.length; i += 1) {
    for (let j = i + 1; j < rectangles.length; j += 1) {
      const a = rectangles[i]; const b = rectangles[j];
      const overlapWidth = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapHeight = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      assert.ok(overlapWidth <= 1e-8 || overlapHeight <= 1e-8, `${a.path} and ${b.path} must not overlap`);
    }
  }
  return rectangles;
}

test("squarifies equal weights into true squares rather than repeated long strips", () => {
  const rects = verifyLayout([file("a", 1), file("b", 1), file("c", 1), file("d", 1)], 400, 400);
  for (const rect of rects) { near(rect.width, 200); near(rect.height, 200); }
});

test("squarified areas preserve ratios across landscape, portrait and uneven weights", () => {
  const entries = [file("big", 90), file("mid", 5), file("small", 3), file("tiny", 2)];
  verifyLayout(entries, 720, 200);
  verifyLayout(entries, 200, 720);
  verifyLayout(entries, 100, 100);
  verifyLayout(entries, 10000, 2);
});

test("layout guards empty, zero/nonfinite weights and invalid canvas dimensions", () => {
  const items = [file("good", 1), file("zero", 0), file("bad", NaN), file("negative", -2), file("infinite", Infinity)];
  const result = squarify(items, 100, 60);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], { ...items[0], x: 0, y: 0, width: 100, height: 60 });
  assert.deepEqual(squarify([], 100, 60), []);
  for (const [width, height] of [[0, 10], [10, 0], [-1, 10], [Infinity, 1], [1, NaN]]) assert.deepEqual(squarify(items, width, height), []);
});

test("many mixed weights stay in bounds without overlaps or lost area", () => {
  let seed = 123;
  const items = Array.from({ length: 150 }, (_, index) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return file("item-" + index, 1 + seed % 10000);
  });
  verifyLayout(items, 927, 313);
});

test("finite huge weights normalize without overflowing their total", () => {
  const rects = squarify([file("a", 1e308), file("b", 1e308)], 100, 100);
  assert.equal(rects.length, 2);
  for (const rect of rects) near(rect.width * rect.height, 5000);
});

test("exports file tools as a browser UMD global", () => {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(require.resolve("../file-tools.js"), "utf8"), context);
  assert.equal(typeof context.PackFileTools.squarify, "function");
  assert.equal(context.PackFileTools.squarify([{ path: "a", size: 1 }], 10, 10)[0].width, 10);
});
