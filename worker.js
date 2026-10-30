(function (scope) {
  "use strict";

  try {
    // Only these application-owned same-origin scripts are loaded. Package
    // files and lifecycle scripts are data, never Worker/importScripts inputs.
    scope.importScripts("archive.js", "analyzer.js");
    if (!scope.PackArchive || typeof scope.PackArchive.readPackage !== "function" || !scope.PackAnalyzer || typeof scope.PackAnalyzer.analyze !== "function") throw new Error("本地处理脚本未完整加载。");
  } catch (error) {
    scope.postMessage({ type: "boot-error", error: serializeError(error) });
    return;
  }

  let activeId = null;
  scope.onmessage = (event) => {
    const data = event.data;
    if (!data || data.type !== "process") return;
    activeId = data.id;
    processFiles(data).catch((error) => {
      if (activeId === data.id) scope.postMessage({ type: "error", id: data.id, error: serializeError(error) });
    });
  };
  scope.postMessage({ type: "ready" });

  async function processFiles(data) {
    progress(data.id, "reading-current");
    const current = await readSlot(data.current, "current");
    if (activeId !== data.id) return;
    let previous = null;
    if (data.previous) {
      progress(data.id, "reading-previous");
      previous = await readSlot(data.previous, "previous");
      if (activeId !== data.id) return;
    }
    progress(data.id, "analyzing");
    const report = scope.PackAnalyzer.analyze(current, previous);
    if (activeId !== data.id) return;
    const transfer = [];
    const seen = new Set();
    for (const archive of [current, previous]) {
      if (!archive) continue;
      for (const entry of archive.entries) {
        const buffer = entry.bytes && entry.bytes.buffer;
        if (buffer instanceof ArrayBuffer && !seen.has(buffer)) {
          seen.add(buffer);
          transfer.push(buffer);
        }
      }
    }
    // Every entry can be a view into one decompressed tar buffer. Transfer
    // each distinct backing buffer once, preserving offsets and zero-copy views.
    scope.postMessage({ type: "result", id: data.id, current, previous, report }, transfer);
  }

  async function readSlot(file, slot) {
    try { return await scope.PackArchive.readPackage(file); }
    catch (error) {
      const result = new Error((slot === "current" ? "本次安装包：" : "上一版安装包：") + (error && error.message || "无法读取文件。"));
      result.name = error && error.name || "Error";
      if (error && error.code) result.code = error.code;
      result.slot = slot;
      throw result;
    }
  }
  function progress(id, stage) { if (activeId === id) scope.postMessage({ type: "progress", id, stage }); }
  function serializeError(error) { return { name: error && error.name || "Error", message: error && error.message || "无法检查安装包。", ...(error && error.code ? { code: error.code } : {}), ...(error && error.slot ? { slot: error.slot } : {}) }; }
})(self);
