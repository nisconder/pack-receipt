(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PackAnalyzer = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var LIFECYCLE = new Set(["preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly", "prepack", "postpack"]);
  var INSTALL = new Set(["preinstall", "install", "postinstall"]);
  var SEVERITY = { error: 0, warning: 1, info: 2 };

  function analyze(current, previous) {
    if (!current || !Array.isArray(current.entries)) throw new TypeError("当前包缺少文件条目。");
    previous = previous || null;
    if (previous && !Array.isArray(previous.entries)) throw new TypeError("对照包缺少文件条目。");
    var currentFiles = fileMap(current.entries);
    var previousFiles = previous ? fileMap(previous.entries) : new Map();
    var report = {
      package: {
        name: clean(current.name || (current.manifest || {}).name || "未命名包"),
        version: clean(current.version || (current.manifest || {}).version || "未知版本"),
        previousName: previous ? clean(previous.name || (previous.manifest || {}).name || "未命名包") : null,
        previousVersion: previous ? clean(previous.version || (previous.manifest || {}).version || "未知版本") : null,
      },
      hasBaseline: Boolean(previous),
      stats: { current: stats(current, currentFiles), previous: previous ? stats(previous, previousFiles) : null, sizeDelta: null, sizeDeltaPercent: null },
      diff: { added: [], removed: [], changed: [], unchanged: [] },
      findings: [],
      scripts: { added: [], removed: [], changed: [], unchanged: [] },
      growth: [],
      limitations: "仅检查发布包内的文件、入口引用及版本差异；不执行包代码，不保证运行正确，也不等同于全面安全扫描。",
    };
    if (previous) {
      report.stats.sizeDelta = report.stats.current.unpackedSize - report.stats.previous.unpackedSize;
      if (report.stats.previous.unpackedSize > 0) report.stats.sizeDeltaPercent = Math.round(report.stats.sizeDelta / report.stats.previous.unpackedSize * 1000) / 10;
      if (report.package.name !== report.package.previousName) finding(report, "warning", "package-name-mismatch", "package.json", "正在比较不同包名", "文件差异仍会展示，请先确认是否选错对照包。", [report.package.previousName + " → " + report.package.name]);
    }
    var paths = new Set(Array.from(currentFiles.keys()).concat(Array.from(previousFiles.keys())));
    Array.from(paths).sort().forEach(function (path) {
      var now = currentFiles.get(path);
      var before = previousFiles.get(path);
      var item = { path: path, size: now ? entrySize(now) : 0, previousSize: before ? entrySize(before) : 0, delta: (now ? entrySize(now) : 0) - (before ? entrySize(before) : 0), type: now ? typeOf(now) : typeOf(before) };
      if (!before) report.diff.added.push(item);
      else if (!now) report.diff.removed.push(item);
      else if (sameEntry(now, before)) report.diff.unchanged.push(item);
      else report.diff.changed.push(item);
    });
    if (previous) {
      report.growth = report.diff.added.concat(report.diff.changed).filter(function (item) { return item.delta > 0; }).sort(function (a, b) { return b.delta - a.delta || a.path.localeCompare(b.path); }).slice(0, 10);
      if (report.stats.sizeDelta > 0) finding(report, "info", "size-growth", null, "解包体积增加", "体积变化本身不代表问题，先核对增长最大的文件是否属于预期产物。", ["增加 " + bytesLabel(report.stats.sizeDelta), report.stats.sizeDeltaPercent === null ? "旧包体积为零，无法计算增长比例。" : "增长 " + report.stats.sizeDeltaPercent + "%"].concat(report.growth.slice(0, 3).map(function (item) { return item.path + "：+" + bytesLabel(item.delta); })));
    }
    checkEntries(current.manifest || {}, currentFiles, report);
    checkFiles(currentFiles, report);
    compareScripts(current.manifest || {}, previous ? previous.manifest || {} : null, report);
    (current.warnings || []).forEach(function (warning) {
      var text = typeof warning === "string" ? warning : warning && (warning.message || warning.detail || warning.title);
      finding(report, "warning", "archive-warning", warning && typeof warning === "object" ? clean(warning.path || "") || null : null, "归档读取提示", text ? redact(text) : "归档读取器报告了一项需要核对的情况。", []);
    });
    report.findings.sort(function (a, b) { return SEVERITY[a.severity] - SEVERITY[b.severity] || (a.path || "").localeCompare(b.path || "") || a.type.localeCompare(b.type); });
    report.markdown = toMarkdown(report);
    return report;
  }

  function checkEntries(manifest, files, report) {
    ["main", "module", "types", "typings"].forEach(function (name) {
      if (typeof manifest[name] === "string") checkTarget(manifest[name], name, name, files, report);
    });
    if (typeof manifest.bin === "string") checkTarget(manifest.bin, "bin", "bin", files, report);
    else if (manifest.bin && typeof manifest.bin === "object" && !Array.isArray(manifest.bin)) Object.keys(manifest.bin).forEach(function (name) {
      if (typeof manifest.bin[name] === "string") checkTarget(manifest.bin[name], "bin[" + name + "]", "bin", files, report);
    });
    if (manifest.exports !== undefined) walkTargets(manifest.exports, "exports", "exports", files, report);
    if (manifest.imports && typeof manifest.imports === "object") walkTargets(manifest.imports, "imports", "imports", files, report);
  }

  function walkTargets(value, label, kind, files, report) {
    if (value === null) return; // Null intentionally blocks an export/import.
    if (typeof value === "string") return checkTarget(value, label, kind, files, report);
    if (Array.isArray(value)) value.forEach(function (item, index) { walkTargets(item, label + "[" + index + "]", kind, files, report); });
    else if (value && typeof value === "object") Object.keys(value).forEach(function (key) { walkTargets(value[key], label + "[" + key + "]", kind, files, report); });
  }

  function checkTarget(target, label, kind, files, report) {
    if (target.indexOf("*") >= 0) {
      finding(report, "info", "entry-pattern", "package.json", "入口包含通配映射", "通配目标依赖具体导入路径，本次不把模式字符串当作缺失文件。", [label + " → " + clean(target)]);
      return;
    }
    if (kind === "imports" && target.slice(0, 2) !== "./") return; // External package and built-in imports are valid.
    if (kind === "exports" && target.slice(0, 2) !== "./") {
      finding(report, "warning", "entry-target-unverified", "package.json", "exports 目标需要核对", "该目标不是以 ./ 开始的包内文件引用，无法按精确文件检查；不据此断言某个文件缺失。", [label + " → " + clean(target)]);
      return;
    }
    var path = target;
    if (kind === "exports" || kind === "imports") {
      path = path.split(/[?#]/, 1)[0];
      try { path = decodeURIComponent(path); } catch (_) {
        finding(report, "warning", "entry-target-unverified", "package.json", "入口路径编码无法验证", "此目标不是可解析的文件 URL 路径。", [label]);
        return;
      }
    }
    path = normalizePath(path);
    if (!path || path === ".." || path.slice(0, 3) === "../" || path.indexOf("/../") >= 0 || /^[a-zA-Z]:|^[\\/]/.test(path)) {
      finding(report, "warning", "entry-outside-package", "package.json", "入口未限定在包内", "入口包含绝对路径或越出包目录的路径，需要手工核对。", [label + " → " + clean(target)]);
      return;
    }
    var candidates = [path];
    if (kind === "main" || kind === "module") candidates = candidates.concat([path + ".js", path + ".json", path + ".node", path + "/index.js", path + "/index.json", path + "/index.node"]);
    if (kind === "types" || kind === "typings") candidates = candidates.concat([path + ".d.ts", path + ".d.mts", path + ".d.cts", path + "/index.d.ts"]);
    var existing = candidates.find(function (candidate) { return files.has(candidate); });
    if (!existing) {
      finding(report, "error", "entry-missing", path, "声明的入口目标未打包", label + " 指向的目标在归档中不存在。此处仅核对声明路径，不模拟条件选择、数组回退或运行时解析，不能单独据此断言整个包不可用。", [label + " → " + clean(target)]);
    } else if (["symlink", "hardlink"].indexOf(typeOf(files.get(existing))) >= 0) {
      finding(report, "info", "entry-link", existing, "入口由归档链接提供", "已找到链接条目，但本次不跟随链接验证运行时解析结果。", [label + " → " + clean(target)]);
    } else if (typeOf(files.get(existing)) !== "file") {
      finding(report, "info", "entry-non-regular", existing, "非普通文件入口需核对", "该入口对应特殊文件元数据，不能按普通文件确认运行时解析结果。", [label + " → " + clean(target), "条目类型：" + typeOf(files.get(existing))]);
    }
  }

  function checkFiles(files, report) {
    files.forEach(function (entry, path) {
      var base = path.split("/").pop();
      var bytes = toBytes(entry.bytes);
      var text = typeOf(entry) === "file" && bytes ? decode(bytes) : "";
      var privateKey = text.match(/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/);
      if (privateKey) finding(report, "error", "private-key", path, "归档包含私钥标记", "请确认是否误打包真实私钥；收据不会回显密钥内容。测试夹具也需要人工确认。", [privateKey[0], "匹配内容已省略。"]);
      else if (/^id_(?:rsa|dsa|ecdsa|ed25519)$/i.test(base)) finding(report, "warning", "private-key-name", path, "文件名类似私钥", "仅根据文件名提示，尚未证明其中包含真实私钥。", [path]);
      if (/^\.env(?:\.|$)/i.test(base) || /^\.npmrc(?:\.|$)/i.test(base)) {
        var example = /(?:^|\.)(?:example|sample|template|dist|defaults)(?:\.|$)/i.test(base);
        var evidence = ["仅展示文件路径及配置键名，不导出配置值。"];
        var keys = configKeys(text);
        if (keys.length) evidence.push("配置键：" + keys.join("、"));
        finding(report, example ? "info" : "warning", example ? "config-example" : "sensitive-config", path, example ? "配置示例也会随包发布" : "归档包含环境或 npm 配置", example ? "示例文件通常属于预期内容，请确认使用的是占位值。" : "这类文件可能包含凭据或私有环境配置，请核对是否需要随包发布。", evidence);
      }
      if (/\.map$/i.test(base)) finding(report, "info", "source-map", path, "发布包包含 source map", "源码映射可能是有意发布的调试产物；存在 map 文件本身不代表漏洞。", [path]);
    });
  }

  function compareScripts(manifest, previousManifest, report) {
    var now = manifest.scripts && typeof manifest.scripts === "object" ? manifest.scripts : {};
    var before = previousManifest && previousManifest.scripts && typeof previousManifest.scripts === "object" ? previousManifest.scripts : {};
    Array.from(new Set(Object.keys(now).concat(Object.keys(before)))).sort().forEach(function (name) {
      var rawAfter = typeof now[name] === "string" ? now[name] : null;
      var rawBefore = typeof before[name] === "string" ? before[name] : null;
      if (rawAfter === null && rawBefore === null) return;
      var item = { name: clean(name), before: rawBefore === null ? null : redact(rawBefore), after: rawAfter === null ? null : redact(rawAfter) };
      var status = rawBefore === null ? "added" : rawAfter === null ? "removed" : rawBefore !== rawAfter ? "changed" : "unchanged";
      report.scripts[status].push(item);
      if (!LIFECYCLE.has(name)) return;
      var lifecycle = INSTALL.has(name) ? "安装生命周期" : "构建或发布生命周期";
      if (status === "removed") finding(report, "info", "lifecycle-removed", "package.json", "生命周期脚本已删除", name + " 已从新包 scripts 中移除。", [name]);
      else if (status === "added" || status === "changed" || !previousManifest) finding(report, "warning", "lifecycle-review", "package.json", !previousManifest ? "包内生命周期脚本待复核" : status === "added" ? "新增生命周期脚本待复核" : "生命周期脚本发生变化", name + " 属于" + lifecycle + "。脚本存在或变更本身不代表恶意；本工具不会执行它。", ["scripts." + name, previousManifest ? "变化类型：" + status : "未提供对照包，无法判断是否新增。"]);
    });
  }

  function toMarkdown(report) {
    var lines = ["# 软件包发布收据", "", "- 当前包：" + inline(report.package.name + "@" + report.package.version), "- 对照包：" + (report.hasBaseline ? inline(report.package.previousName + "@" + report.package.previousVersion) : "未提供，仅检查当前发布内容"), "", "## 发布内容", "", "| 指标 | 当前 | 对照 |", "| --- | ---: | ---: |", "| 文件/链接条目 | " + report.stats.current.fileCount + " | " + (report.stats.previous ? report.stats.previous.fileCount : "—") + " |", "| 解包体积 | " + bytesLabel(report.stats.current.unpackedSize) + " | " + (report.stats.previous ? bytesLabel(report.stats.previous.unpackedSize) : "—") + " |", "| 压缩体积 | " + bytesLabel(report.stats.current.compressedSize) + " | " + (report.stats.previous ? bytesLabel(report.stats.previous.compressedSize) : "—") + " |", ""];
    if (report.hasBaseline) lines.push("解包体积变化：" + signedBytes(report.stats.sizeDelta) + (report.stats.sizeDeltaPercent === null ? "" : "（" + (report.stats.sizeDeltaPercent >= 0 ? "+" : "") + report.stats.sizeDeltaPercent + "%）") + "。", "");
    lines.push("## 需要核对的内容", "");
    if (!report.findings.length) lines.push("本次检查未产生提示。此结果不构成安全或运行正确性保证。", "");
    report.findings.forEach(function (item) {
      lines.push("### " + ({ error: "错误", warning: "复核", info: "信息" }[item.severity]) + " · " + escapeMarkdown(item.title), "", escapeMarkdown(item.detail), "");
      if (item.path) lines.push("路径：" + inline(item.path), "");
      item.evidence.forEach(function (value) { lines.push("- " + escapeMarkdown(value)); });
      lines.push("");
    });
    lines.push("## 文件差异", "");
    if (!report.hasBaseline) lines.push("未提供旧包，以下为当前发布文件，不表示它们是新版本新增文件。", "");
    [["added", report.hasBaseline ? "新增" : "当前文件"], ["removed", "删除"], ["changed", "内容或类型变化"], ["unchanged", "未变更"]].forEach(function (pair) {
      lines.push("### " + pair[1] + "（" + report.diff[pair[0]].length + "）", "");
      report.diff[pair[0]].forEach(function (file) { lines.push("- " + inline(file.path) + " · " + bytesLabel(file.size) + (report.hasBaseline ? " · " + signedBytes(file.delta) : "")); });
      lines.push("");
    });
    lines.push("## scripts 变化", "");
    var scripts = [].concat(report.scripts.added, report.scripts.removed, report.scripts.changed);
    if (!scripts.length) lines.push("未观察到 scripts 变化。", "");
    if (!report.hasBaseline && scripts.length) lines.push("未提供旧包，以下仅列出当前 scripts。", "");
    scripts.forEach(function (item) {
      lines.push("- " + inline(item.name), "  - 对照：" + (item.before === null ? "—" : inline(item.before)), "  - 当前：" + (item.after === null ? "—" : inline(item.after)));
    });
    lines.push("", "## 检查边界", "", report.limitations, "", "收据不包含归档文件字节、配置值或私钥内容。分享前仍应核对文件名和脚本中的个人信息。", "");
    return lines.join("\n");
  }

  function fileMap(entries) {
    var files = new Map();
    entries.forEach(function (entry) { if (entry && typeOf(entry) !== "directory") files.set(normalizePath(entry.path || ""), entry); });
    return files;
  }

  function typeOf(entry) {
    var type = entry && entry.type;
    if (type === "directory" || type === "dir" || type === "5") return "directory";
    if (type === "symlink" || type === "2") return "symlink";
    if (type === "hardlink" || type === "1") return "hardlink";
    if (type === undefined || type === null || type === "" || type === "file" || type === "0" || type === "7") return "file";
    return clean(type) || "special";
  }

  function entrySize(entry) {
    var supplied = Number(entry.size);
    return Number.isFinite(supplied) && supplied >= 0 ? supplied : (toBytes(entry.bytes) || []).length;
  }

  function stats(archive, files) {
    var total = Number(archive.totalUnpacked);
    var compressed = Number(archive.compressedSize);
    return { fileCount: archive.entries.filter(function (entry) { return entry && typeOf(entry) !== "directory"; }).length, unpackedSize: Number.isFinite(total) && total >= 0 ? total : Array.from(files.values()).reduce(function (sum, entry) { return sum + entrySize(entry); }, 0), compressedSize: Number.isFinite(compressed) && compressed >= 0 ? compressed : 0 };
  }

  function sameEntry(a, b) {
    if (typeOf(a) !== typeOf(b) || entrySize(a) !== entrySize(b) || (a.linkname || "") !== (b.linkname || "")) return false;
    if (typeOf(a) !== "file") return true;
    var left = toBytes(a.bytes);
    var right = toBytes(b.bytes);
    if (!left || !right) return false;
    if (left.length !== right.length) return false;
    for (var i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false;
    return true;
  }

  function toBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) return new Uint8Array(value);
    if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (Array.isArray(value)) return Uint8Array.from(value);
    if (typeof value === "string") return new TextEncoder().encode(value);
    return null;
  }

  function decode(bytes) { return new TextDecoder("utf-8", { fatal: false }).decode(bytes); }
  function normalizePath(value) { return String(value).replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/\/$/, ""); }
  function clean(value) { return String(value || "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 4000).trim(); }
  function redact(value) {
    // Redact complete values before the display limit can cut off their closing
    // quote or URL delimiter and leave a credential fragment in the receipt.
    // Match names only at a full identifier boundary, so dotted or hyphenated
    // names do not retry the same long suffix at every punctuation character.
    // Keep keyword detection in a separate lookahead: matching the identifier
    // must not retry every keyword occurrence when a value delimiter is absent.
    return clean(String(value).replace(/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g, "[私钥内容已省略]")
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[已省略]@")
      .replace(/(?<![\w.-])((?=[\w.-]*(?:password|passwd|token|secret|api[-_]?key|_auth))[\w.-]+\s*(?:=|:)\s*)(?:"(?:\\[\s\S]?|[^"\\])*(?:"|$)|'(?:\\[\s\S]?|[^'\\])*(?:'|$)|[^\s;&]+)/gi, "$1[已省略]")
      .replace(/(?<![\w.-])(--?(?=[\w.-]*(?:password|passwd|token|secret|api[-_]?key))[\w.-]+\s+)(?:"(?:\\[\s\S]?|[^"\\])*(?:"|$)|'(?:\\[\s\S]?|[^'\\])*(?:'|$)|\S+)/gi, "$1[已省略]"));
  }
  function configKeys(text) {
    var keys = [];
    var expression = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=/gm;
    var match;
    while ((match = expression.exec(text)) && keys.length < 8) keys.push(match[1]);
    if (/(?:^|:)_authToken\s*=/im.test(text)) keys.push("_authToken");
    return Array.from(new Set(keys));
  }
  function finding(report, severity, type, path, title, detail, evidence) {
    report.findings.push({ id: type + ":" + report.findings.length, severity: severity, type: type, path: path, title: title, detail: detail, evidence: evidence || [] });
  }
  function bytesLabel(value) { return Number(value).toLocaleString("en-US") + " B"; }
  function signedBytes(value) { return (value >= 0 ? "+" : "−") + bytesLabel(Math.abs(value)); }
  function inline(value) {
    var text = clean(value);
    var runs = text.match(/`+/g) || [];
    var fence = "`".repeat(runs.reduce(function (max, run) { return Math.max(max, run.length); }, 0) + 1);
    return fence + " " + text + " " + fence;
  }
  function escapeMarkdown(value) { return clean(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\\`*_\[\]#|]/g, "\\$&"); }

  return { analyze: analyze, toMarkdown: toMarkdown };
});
