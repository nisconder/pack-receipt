(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PackDiff = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULTS = Object.freeze({ maxLines: 3000, maxRows: 3000, maxCells: 1000000, maxChars: 262144 });
  const TEXT_BYTES = 65536;
  const MAX_TEXT_BYTES = 1048576;

  function bounded(value, fallback) {
    return Number.isSafeInteger(value) && value > 0 ? Math.min(value, fallback) : fallback;
  }

  function diffLines(beforeText, afterText, options) {
    options = options || {};
    if (typeof beforeText !== "string" || typeof afterText !== "string") {
      return { rows: [], added: 0, removed: 0, limited: true, truncated: true, countsExact: false, message: "两侧都需要真实文本内容，当前无法生成逐行差异。" };
    }
    const maxLines = bounded(options.maxLines, DEFAULTS.maxLines);
    const maxRows = bounded(options.maxRows, DEFAULTS.maxRows);
    const maxCells = bounded(options.maxCells, DEFAULTS.maxCells);
    const maxChars = bounded(options.maxChars, DEFAULTS.maxChars);
    const oldInput = tokenize(beforeText, maxLines, maxChars);
    const newInput = tokenize(afterText, maxLines, maxChars);
    const before = oldInput.tokens;
    const after = newInput.tokens;
    const messages = [];
    let limited = oldInput.truncated || newInput.truncated;
    let truncated = limited;
    if (limited) messages.push("输入超过文本或行数预算，仅比较可读取的前缀；增删计数不代表完整文件。");

    let prefix = 0;
    while (prefix < before.length && prefix < after.length && same(before[prefix], after[prefix])) prefix += 1;
    let suffix = 0;
    while (suffix < before.length - prefix && suffix < after.length - prefix && same(before[before.length - 1 - suffix], after[after.length - 1 - suffix])) suffix += 1;
    const oldCount = before.length - prefix - suffix;
    const newCount = after.length - prefix - suffix;
    const operations = before.slice(0, prefix).map((token) => ({ type: "equal", token }));

    // The dynamic-programming allocation and work are both bounded. Identical
    // prefixes/suffixes cost only a linear pass, even for large matching files.
    if (oldCount && newCount && (oldCount + 1) * (newCount + 1) > maxCells) {
      limited = true;
      messages.push("差异计算达到预算，变更区以整块删除和新增展示；此预览不是精确的最小逐行匹配。");
      appendReplacement(operations, before.slice(prefix, prefix + oldCount), after.slice(prefix, prefix + newCount));
    } else if (!oldCount || !newCount) {
      appendReplacement(operations, before.slice(prefix, prefix + oldCount), after.slice(prefix, prefix + newCount));
    } else {
      const width = newCount + 1;
      // At most 3000 matching lines; Uint16 is sufficient for every LCS length.
      const lengths = new Uint16Array((oldCount + 1) * width);
      for (let i = oldCount - 1; i >= 0; i -= 1) {
        for (let j = newCount - 1; j >= 0; j -= 1) {
          lengths[i * width + j] = same(before[prefix + i], after[prefix + j])
            ? lengths[(i + 1) * width + j + 1] + 1
            : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
        }
      }
      let i = 0;
      let j = 0;
      while (i < oldCount || j < newCount) {
        if (i < oldCount && j < newCount && same(before[prefix + i], after[prefix + j])) {
          operations.push({ type: "equal", token: before[prefix + i++] });
          j += 1;
        } else if (i < oldCount && (j === newCount || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) {
          operations.push({ type: "remove", token: before[prefix + i++] });
        } else operations.push({ type: "add", token: after[prefix + j++] });
      }
    }
    for (const token of before.slice(before.length - suffix)) operations.push({ type: "equal", token });

    const rows = [];
    let oldLine = 1;
    let newLine = 1;
    for (const operation of operations) {
      if (rows.length >= maxRows) break;
      rows.push({
        type: operation.type,
        text: operation.token.text,
        eol: operation.token.eol,
        oldLine: operation.type === "add" ? null : oldLine++,
        newLine: operation.type === "remove" ? null : newLine++,
      });
    }
    markReplacements(rows);
    if (operations.length > maxRows) {
      limited = true;
      truncated = true;
      messages.push("输出达到 " + maxRows + " 行预算，后续差异已省略；当前增删计数仅覆盖已显示行。");
    }
    return {
      rows,
      added: rows.filter((row) => row.type === "add").length,
      removed: rows.filter((row) => row.type === "remove").length,
      before: oldInput.info,
      after: newInput.info,
      truncated,
      countsExact: !limited,
      ...(limited ? { limited: true, message: messages.join(" ") } : {}),
    };
  }

  function tokenize(text, maxLines, maxChars) {
    let end = Math.min(text.length, maxChars);
    if (end < text.length && end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end -= 1;
    const tokens = [];
    const endings = new Set();
    let cursor = 0;
    while (cursor < end && tokens.length < maxLines) {
      const start = cursor;
      while (cursor < end && text[cursor] !== "\r" && text[cursor] !== "\n") cursor += 1;
      const content = text.slice(start, cursor);
      let eol = "";
      if (cursor < end) {
        if (text[cursor] === "\r" && text[cursor + 1] === "\n") {
          // A CRLF straddling the preview boundary is kept as one ending.
          eol = "\r\n";
          cursor += 2;
        } else eol = text[cursor++];
        endings.add(eol === "\n" ? "LF" : eol === "\r\n" ? "CRLF" : "CR");
      }
      tokens.push({ text: content, eol });
    }
    const truncated = cursor < text.length;
    return {
      tokens,
      truncated,
      info: {
        lineCount: truncated ? null : tokens.length,
        previewLines: tokens.length,
        finalNewline: truncated ? null : tokens.length > 0 && tokens[tokens.length - 1].eol !== "",
        lineEnding: endings.size > 1 ? "mixed" : endings.size ? Array.from(endings)[0] : "none",
        complete: !truncated,
      },
    };
  }

  function same(before, after) { return before.text === after.text && before.eol === after.eol; }

  function appendReplacement(operations, before, after) {
    for (const token of before) operations.push({ type: "remove", token });
    for (const token of after) operations.push({ type: "add", token });
  }

  function markReplacements(rows) {
    let cursor = 0;
    while (cursor < rows.length) {
      if (rows[cursor].type === "equal") { cursor += 1; continue; }
      const start = cursor;
      let hasAdd = false;
      let hasRemove = false;
      while (cursor < rows.length && rows[cursor].type !== "equal") {
        hasAdd = hasAdd || rows[cursor].type === "add";
        hasRemove = hasRemove || rows[cursor].type === "remove";
        cursor += 1;
      }
      if (hasAdd && hasRemove) for (let index = start; index < cursor; index += 1) rows[index].changed = true;
    }
  }

  function readTextEntry(pkg, path, options) {
    options = options || {};
    if (!pkg || !Array.isArray(pkg.entries)) return entryResult("unavailable", null, "软件包的文件内容不可用。", false);
    const entry = pkg.entries.find((item) => item.path === path);
    if (!entry) return entryResult("missing", null, "此版本中没有这个文件。", false);
    if (["symlink", "hardlink", "link"].includes(entry.type)) return entryResult("link", null, "此条目是链接，只展示元数据，不跟随或比较链接目标。", false);
    if (!["file", "regular", "0"].includes(entry.type)) return entryResult("special", null, "此条目不是普通文件，仅展示元数据。", false);
    let bytes;
    if (entry.bytes instanceof Uint8Array) bytes = entry.bytes;
    else if (entry.bytes instanceof ArrayBuffer) bytes = new Uint8Array(entry.bytes);
    else if (ArrayBuffer.isView(entry.bytes)) bytes = new Uint8Array(entry.bytes.buffer, entry.bytes.byteOffset, entry.bytes.byteLength);
    else return entryResult("unavailable", null, "没有读取到此文件的真实字节，无法生成文本差异。", false);
    if (entry.size > 0 && bytes.byteLength === 0) return entryResult("unavailable", null, "只有文件大小等元数据，没有可比较的文件内容。", false);
    const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes >= 0 ? Math.min(options.maxBytes, MAX_TEXT_BYTES) : TEXT_BYTES;
    const end = Math.min(bytes.byteLength, maxBytes);
    const truncated = end < bytes.byteLength || Number.isFinite(entry.size) && entry.size > bytes.byteLength;
    let text;
    try {
      // Streaming decode buffers a partial final code point instead of
      // replacing it with U+FFFD. Do not flush that buffer for a truncated view.
      // ignoreBOM=true preserves an actual BOM as text rather than hiding it.
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, end), { stream: truncated });
    } catch {
      return entryResult("binary", null, "文件包含无效 UTF-8 字节，按二进制内容处理。", truncated);
    }
    if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f]/.test(text)) return entryResult("binary", null, "文件包含二进制控制字节，不生成逐行文本差异。", truncated);
    return entryResult("text", text, truncated ? "文本预览已按 UTF-8 字符边界截断，后续内容未比较。" : "", truncated);
  }

  function entryResult(kind, text, message, truncated) { return { kind, text, message, truncated }; }

  return Object.freeze({ diffLines, readTextEntry });
});
