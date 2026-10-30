(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PackFileTools = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const KIND_ORDER = { added: 0, changed: 1, removed: 2, unchanged: 3 };

  function pathOf(item) { return String(item && item.path || ""); }
  function comparePath(left, right) {
    const a = pathOf(left);
    const b = pathOf(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  function number(value) { const result = Number(value); return Number.isFinite(result) ? result : 0; }

  function sortFiles(rows, options) {
    options = options || {};
    const key = ["path", "kind", "size", "delta"].includes(options.key) ? options.key : "path";
    const direction = options.direction === "desc" ? -1 : 1;
    return (Array.isArray(rows) ? rows.slice() : []).sort(function (left, right) {
      let result;
      if (key === "path") result = comparePath(left, right);
      else if (key === "kind") result = (Object.hasOwn(KIND_ORDER, left.kind) ? KIND_ORDER[left.kind] : 4) - (Object.hasOwn(KIND_ORDER, right.kind) ? KIND_ORDER[right.kind] : 4);
      else result = number(left[key]) - number(right[key]);
      return result * direction || comparePath(left, right);
    });
  }

  function directoryItems(entries, prefix, flat) {
    prefix = prefix == null ? "" : String(prefix);
    if (prefix.startsWith("/") || /[\\\u0000-\u001f]/.test(prefix) || prefix.split("/").includes("..")) return [];
    if (prefix && !prefix.endsWith("/")) prefix += "/";
    const groups = new Map();
    const files = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || entry.type !== "file" || !Number.isFinite(entry.size) || entry.size <= 0 || typeof entry.path !== "string" || !entry.path.startsWith(prefix)) continue;
      const relative = entry.path.slice(prefix.length);
      if (!relative) continue;
      if (flat) {
        files.push({ path: entry.path, label: relative, size: entry.size, count: 1, directory: false });
        continue;
      }
      const slash = relative.indexOf("/");
      const directory = slash >= 0;
      const label = directory ? relative.slice(0, slash + 1) : relative;
      const path = prefix + label;
      if (!groups.has(path)) groups.set(path, { path, label, size: 0, count: 0, directory });
      const group = groups.get(path);
      group.size += entry.size;
      group.count += 1;
    }
    return (flat ? files : Array.from(groups.values())).sort(function (left, right) { return right.size - left.size || comparePath(left, right); });
  }

  function squarify(items, width, height) {
    width = Number(width);
    height = Number(height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || !Number.isFinite(width * height)) return [];
    const sorted = (Array.isArray(items) ? items : []).filter(function (item) { return item && Number.isFinite(item.size) && item.size > 0; }).slice().sort(function (left, right) { return right.size - left.size || comparePath(left, right); });
    if (!sorted.length) return [];
    // Scaling by the largest weight prevents overflow when finite weights
    // have a sum larger than Number.MAX_VALUE.
    const largest = sorted[0].size;
    const scaledTotal = sorted.reduce(function (sum, item) { return sum + item.size / largest; }, 0);
    const area = width * height;
    const remaining = sorted.map(function (item) { return { item, area: item.size / largest / scaledTotal * area }; }).filter(function (item) { return item.area > 0 && Number.isFinite(item.area); });
    const box = { x: 0, y: 0, width, height };
    const rectangles = [];
    let cursor = 0;
    let row = [];
    let sum = 0;
    let smallest = Infinity;
    let biggest = 0;

    while (cursor < remaining.length) {
      const candidate = remaining[cursor];
      const nextSum = sum + candidate.area;
      const nextSmallest = Math.min(smallest, candidate.area);
      const nextBiggest = Math.max(biggest, candidate.area);
      const shortSide = Math.min(box.width, box.height);
      if (!row.length || worstAspect(nextSum, nextSmallest, nextBiggest, shortSide) <= worstAspect(sum, smallest, biggest, shortSide)) {
        row.push(candidate);
        sum = nextSum;
        smallest = nextSmallest;
        biggest = nextBiggest;
        cursor += 1;
      } else {
        placeRow(row, sum, box, rectangles, false);
        row = [];
        sum = 0;
        smallest = Infinity;
        biggest = 0;
      }
    }
    if (row.length) placeRow(row, sum, box, rectangles, true);
    return rectangles;
  }

  function worstAspect(sum, smallest, biggest, side) {
    if (!(sum > 0) || !(smallest > 0) || !(side > 0)) return Infinity;
    const strip = sum / side;
    // Equivalent to max(side² * max / sum², sum² / (side² * min)),
    // ordered to avoid intermediate squared-area overflow.
    return Math.max(biggest / strip / strip, strip / smallest * strip);
  }

  function placeRow(row, sum, box, rectangles, lastRow) {
    if (box.width >= box.height) {
      // Stack along the short (vertical) edge, consuming one vertical strip.
      const strip = lastRow ? box.width : Math.min(box.width, sum / box.height);
      let top = box.y;
      for (let index = 0; index < row.length; index += 1) {
        const item = row[index];
        const height = index === row.length - 1 ? box.y + box.height - top : item.area / strip;
        rectangles.push(Object.assign({}, item.item, { x: box.x, y: top, width: Math.max(0, strip), height: Math.max(0, height) }));
        top += height;
      }
      box.x += strip;
      box.width = Math.max(0, box.width - strip);
    } else {
      // Stack along the short (horizontal) edge, consuming a horizontal strip.
      const strip = lastRow ? box.height : Math.min(box.height, sum / box.width);
      let left = box.x;
      for (let index = 0; index < row.length; index += 1) {
        const item = row[index];
        const width = index === row.length - 1 ? box.x + box.width - left : item.area / strip;
        rectangles.push(Object.assign({}, item.item, { x: left, y: box.y, width: Math.max(0, width), height: Math.max(0, strip) }));
        left += width;
      }
      box.y += strip;
      box.height = Math.max(0, box.height - strip);
    }
  }

  return Object.freeze({ sortFiles, directoryItems, squarify });
});
