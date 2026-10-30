(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory(root, require("./archive.js"), require("./analyzer.js"));
  else root.PackProcessor = factory(root, root.PackArchive, root.PackAnalyzer);
})(typeof globalThis === "object" ? globalThis : this, function (root, defaultArchive, defaultAnalyzer) {
  "use strict";

  // Capture our own script URL while this classic script is being evaluated.
  // Never use an arbitrary archive field or a user-supplied URL as worker code.
  const scriptURL = root.document && root.document.currentScript ? root.document.currentScript.src : "";
  const messages = {
    starting: "正在准备本地处理…",
    "reading-current": "正在读取本次安装包…",
    "reading-previous": "正在读取上一版安装包…",
    analyzing: "正在核对发布内容与版本差异…",
    done: "本地处理已完成。",
  };

  function createProcessor(options) {
    options = options || {};
    const archive = options.archive || defaultArchive;
    const analyzer = options.analyzer || defaultAnalyzer;
    const WorkerClass = Object.hasOwn(options, "Worker") ? options.Worker : root.Worker;
    const location = options.location || root.location;
    const startupTimeout = Math.max(100, Math.min(10000, Number(options.startupTimeoutMs) || 5000));
    const yieldControl = options.yieldControl || (() => new Promise((resolve) => setTimeout(resolve, 0)));
    let sequence = 0;
    let active = null;
    let disposed = false;

    function processFiles(files, onProgress) {
      cancel();
      if (disposed) return Promise.reject(namedError("InvalidStateError", "处理器已关闭，请重新载入页面。"));
      return new Promise((resolve, reject) => {
        const task = { id: ++sequence, files: files || {}, onProgress, resolve, reject, settled: false, worker: null, timer: null, mode: null, ready: false, sent: false };
        active = task;
        if (!task.files.current) return finish(task, namedError("TypeError", "请选择本次安装包。"));
        let url = null;
        try {
          const protocol = location && location.protocol;
          if ((protocol === "http:" || protocol === "https:") && typeof WorkerClass === "function") {
            const page = new URL(location.href);
            const workerURL = new URL("worker.js", scriptURL || page.href);
            if (workerURL.origin === page.origin && (workerURL.protocol === "http:" || workerURL.protocol === "https:")) url = workerURL.href;
          }
        } catch (_) { /* An unsupported location uses the explicit main-thread path. */ }
        if (!url) return startMain(task, location && location.protocol === "file:" ? "FILE_ORIGIN" : "WORKER_UNAVAILABLE");
        task.mode = "worker";
        notify(task, "starting");
        if (!isActive(task)) return;
        try {
          const worker = new WorkerClass(url, { type: "classic", name: "pack-receipt" });
          task.worker = worker;
          worker.onmessage = (event) => handleMessage(task, event.data);
          worker.onerror = (event) => {
            if (event && typeof event.preventDefault === "function") event.preventDefault();
            if (!isActive(task) || task.mode !== "worker") return;
            if (!task.sent) startMain(task, "WORKER_LOAD_FAILED");
            else finish(task, namedError("Error", "后台处理意外中断，请重新选择文件。", "WORKER_RUNTIME"));
          };
          worker.onmessageerror = () => {
            if (isActive(task) && task.mode === "worker") finish(task, namedError("Error", "无法接收后台处理结果，请重新选择文件。", "WORKER_MESSAGE"));
          };
          task.timer = setTimeout(() => {
            if (isActive(task) && task.mode === "worker" && !task.ready) startMain(task, "WORKER_LOAD_TIMEOUT");
          }, startupTimeout);
        } catch (_) {
          startMain(task, "WORKER_CONSTRUCTION_FAILED");
        }
      });
    }

    function handleMessage(task, data) {
      if (!isActive(task) || task.mode !== "worker" || !data || typeof data !== "object") return;
      if (data.type === "boot-error" && !task.sent) return startMain(task, "WORKER_LOAD_FAILED");
      if (data.type === "ready" && !task.ready) {
        task.ready = true;
        clearTimeout(task.timer);
        task.timer = null;
        try {
          // File/Blob objects use structured clone; they are not transferable.
          task.worker.postMessage({ type: "process", id: task.id, current: task.files.current, previous: task.files.previous || null });
          task.sent = true;
        } catch (_) { startMain(task, "WORKER_INPUT_UNSUPPORTED"); }
        return;
      }
      if (data.id !== task.id) return;
      if (data.type === "progress" && Object.hasOwn(messages, data.stage)) return notify(task, data.stage);
      if (data.type === "error") {
        const error = namedError(data.error && data.error.name || "Error", data.error && data.error.message || "无法检查安装包。", data.error && data.error.code);
        if (data.error && data.error.slot) error.slot = data.error.slot;
        return finish(task, error);
      }
      if (data.type === "result") {
        if (!data.current || !data.report) return finish(task, namedError("Error", "后台处理返回了不完整的结果。", "WORKER_RESULT"));
        notify(task, "done");
        finish(task, null, { current: data.current, previous: data.previous || null, report: data.report, mode: "worker" });
      }
    }

    function startMain(task, reason) {
      if (!isActive(task) || task.mode === "main") return;
      stopWorker(task);
      task.mode = "main";
      notify(task, "starting", reason === "FILE_ORIGIN" ? "直接打开本地文件：使用主线程处理，阶段之间会让出界面。" : "后台处理不可用：改用主线程本地处理，阶段之间会让出界面。", reason);
      runMain(task).catch((error) => finish(task, error));
    }

    async function runMain(task) {
      if (!archive || typeof archive.readPackage !== "function" || !analyzer || typeof analyzer.analyze !== "function") throw namedError("Error", "本地处理脚本未完整加载，请重新打开页面。", "PROCESSOR_DEPENDENCY");
      await pause(task);
      notify(task, "reading-current");
      await pause(task);
      const current = await readSlot(task, task.files.current, "current");
      await pause(task);
      let previous = null;
      if (task.files.previous) {
        notify(task, "reading-previous");
        await pause(task);
        previous = await readSlot(task, task.files.previous, "previous");
        await pause(task);
      }
      notify(task, "analyzing");
      await pause(task);
      const report = analyzer.analyze(current, previous);
      await pause(task);
      notify(task, "done");
      finish(task, null, { current, previous, report, mode: "main" });
    }

    async function readSlot(task, file, slot) {
      try {
        const result = await archive.readPackage(file);
        if (!isActive(task)) throw abortError();
        return result;
      } catch (error) {
        if (error && error.name === "AbortError") throw error;
        const result = namedError(error && error.name || "Error", (slot === "current" ? "本次安装包：" : "上一版安装包：") + (error && error.message || "无法读取文件。"), error && error.code);
        result.slot = slot;
        throw result;
      }
    }

    async function pause(task) {
      await yieldControl();
      if (!isActive(task)) throw abortError();
    }

    function notify(task, stage, message, reason) {
      if (!isActive(task) || typeof task.onProgress !== "function") return;
      try { task.onProgress({ stage, message: message || messages[stage], mode: task.mode, ...(reason ? { reason } : {}) }); }
      catch (_) { /* A rendering callback cannot invalidate archive analysis. */ }
    }

    function isActive(task) { return active === task && !task.settled; }
    function stopWorker(task) {
      clearTimeout(task.timer);
      task.timer = null;
      if (task.worker) {
        task.worker.onmessage = null;
        task.worker.onerror = null;
        task.worker.onmessageerror = null;
        try { task.worker.terminate(); } catch (_) { /* Already stopped. */ }
        task.worker = null;
      }
    }
    function finish(task, error, result) {
      if (!isActive(task)) return;
      task.settled = true;
      stopWorker(task);
      active = null;
      if (error) task.reject(error); else task.resolve(result);
    }
    function cancel() { if (active) finish(active, abortError()); }
    function dispose() { cancel(); disposed = true; }
    return { process: processFiles, cancel, dispose };
  }

  function namedError(name, message, code) {
    const error = new Error(message);
    error.name = name;
    if (code) error.code = code;
    return error;
  }
  function abortError() { return namedError("AbortError", "处理已取消。"); }

  return { createProcessor };
});
