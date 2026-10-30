(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    root.PackPrinter = api;
    if (root.document) {
      if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", () => api.attach(), { once: true });
      else api.attach();
    }
  }
})(typeof globalThis === "object" ? globalThis : this, function (root) {
  "use strict";

  const timings = Object.freeze({ feeding: 900, stamping: 450, tearing: 360 });
  const labels = {
    idle: "等待检查", analyzing: "正在检查", feeding: "正在出纸", stamping: "正在印章",
    ready: "收据可查看", tearing: "正在撕下", detached: "收据已撕下", error: "检查未完成",
  };
  const messages = {
    idle: "选择安装包，或载入问题样本。",
    analyzing: "正在本地检查安装包，完成后打印收据。",
    feeding: "检查已完成，正在出纸。",
    stamping: "正在印上本次检查摘要。",
    ready: "收据已就绪，可查看、复制或导出；撕下后结果仍保留。",
    tearing: "正在撕下收据，结果会保留在页面中。",
    detached: "收据已撕下，检查结果仍可查看、复制和导出。",
    error: "本次检查未完成，请核对文件后重试。",
  };
  const attached = new WeakMap();

  function createController(options) {
    options = options || {};
    const scheduleTimeout = options.setTimeout || ((callback, delay) => setTimeout(callback, delay));
    const cancelTimeout = options.clearTimeout || ((handle) => clearTimeout(handle));
    const now = options.now || (() => new Date());
    let phase = "idle";
    let id = -1;
    let identity = null;
    let errorMessage = "";
    let timer = null;
    let revision = 0;
    let disposed = false;

    function getState() {
      return {
        phase, id: id < 0 ? null : id,
        inert: ["feeding", "stamping", "tearing"].includes(phase),
        canTear: phase === "ready", canPrintAgain: phase === "detached",
        label: labels[phase], message: phase === "error" && errorMessage ? errorMessage : messages[phase],
        led: phase === "error" ? "error" : ["analyzing", "feeding", "stamping", "tearing"].includes(phase) ? "busy" : ["ready", "detached"].includes(phase) ? "ready" : "idle",
        identity: identity ? { ...identity } : null,
      };
    }

    function publish() {
      if (typeof options.onState === "function") {
        try { options.onState(getState()); } catch (_) { /* Visual feedback must not interrupt archive analysis. */ }
      }
    }
    function change(next) { phase = next; publish(); }
    function clearTimer() {
      revision += 1;
      if (timer !== null) cancelTimeout(timer);
      timer = null;
    }
    function schedule(callback, delay, expected, expectedId) {
      if (disposed || phase !== expected || id !== expectedId) return;
      const token = revision;
      timer = scheduleTimeout(() => {
        if (disposed || revision !== token || phase !== expected || id !== expectedId) return;
        timer = null;
        callback();
      }, delay);
    }
    function reduced() {
      try { return typeof options.reducedMotion === "function" ? Boolean(options.reducedMotion()) : Boolean(options.reducedMotion); }
      catch (_) { return false; }
    }
    function hidden() {
      try { return typeof options.isHidden === "function" && Boolean(options.isHidden()); }
      catch (_) { return false; }
    }
    function valid(detail) { return detail && Number.isSafeInteger(detail.id) && detail.id >= 0; }

    function start(detail) {
      if (disposed || !valid(detail) || detail.id <= id) return false;
      clearTimer();
      id = detail.id;
      identity = null;
      errorMessage = "";
      change("analyzing");
      return true;
    }
    function complete(detail) {
      if (disposed || !valid(detail) || detail.id !== id || phase !== "analyzing") return false;
      clearTimer();
      identity = receiptIdentity(detail, now);
      print();
      return true;
    }
    function error(detail) {
      if (disposed || !valid(detail) || detail.id !== id || phase === "idle") return false;
      clearTimer();
      identity = null;
      errorMessage = text(detail.message) || messages.error;
      change("error");
      return true;
    }
    function reset(detail) {
      if (disposed || !valid(detail) || detail.id < id) return false;
      clearTimer();
      id = detail.id;
      identity = null;
      errorMessage = "";
      change("idle");
      return true;
    }
    function print() {
      const expectedId = id;
      if (reduced() || hidden()) { change("ready"); return; }
      change("feeding");
      schedule(() => {
        change("stamping");
        schedule(() => change("ready"), timings.stamping, "stamping", expectedId);
      }, timings.feeding, "feeding", expectedId);
    }
    function tear() {
      if (disposed || phase !== "ready") return false;
      clearTimer();
      if (reduced() || hidden()) { change("detached"); return true; }
      const expectedId = id;
      change("tearing");
      schedule(() => change("detached"), timings.tearing, "tearing", expectedId);
      return true;
    }
    function printAgain() {
      if (disposed || phase !== "detached" || !identity) return false;
      clearTimer();
      print();
      return true;
    }
    function finishPresentation() {
      if (disposed) return;
      if (phase === "feeding" || phase === "stamping") { clearTimer(); change("ready"); }
      else if (phase === "tearing") { clearTimer(); change("detached"); }
    }
    function visibilityChange(isHidden) { if (isHidden) finishPresentation(); }
    function dispose() {
      if (disposed) return;
      clearTimer();
      identity = null;
      errorMessage = "";
      disposed = true;
      change("idle");
    }
    publish();
    return { start, complete, error, reset, tear, printAgain, visibilityChange, finishPresentation, getState, dispose };
  }

  function receiptIdentity(detail, now) {
    let date = new Date(detail.completedAt || now());
    if (!Number.isFinite(date.getTime())) date = new Date(now());
    const errors = count(detail.errors);
    const warnings = count(detail.warnings);
    const two = (number) => String(number).padStart(2, "0");
    const day = `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}`;
    return {
      name: text(detail.name), version: text(detail.version), completedAt: date.toISOString(),
      serial: `PR-${day}-${String(detail.id).padStart(6, "0")}`,
      time: `分析于 ${date.getFullYear()}/${two(date.getMonth() + 1)}/${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())} · 本机时间`,
      stampTitle: errors ? "待修复" : warnings ? "待复核" : "收据已生成",
      stampCaption: errors || warnings ? `${errors} 项需要修复 · ${warnings} 项需要复核` : "检查结果已记录 · 请结合实际安装测试",
      severity: errors ? "error" : warnings ? "warning" : "info", errors, warnings,
    };
  }

  function attach(document, eventTarget) {
    document = document || root.document;
    if (!document || typeof document.getElementById !== "function") return null;
    const wrapper = document.getElementById("receipt-printer");
    const content = document.getElementById("report-content");
    if (!wrapper || !content) return null;
    if (attached.has(wrapper)) return attached.get(wrapper);
    eventTarget = eventTarget || document.defaultView || root;
    if (!eventTarget || typeof eventTarget.addEventListener !== "function") return null;
    const tearButton = document.getElementById("tear-receipt");
    const tearLabel = tearButton && typeof tearButton.querySelector === "function" ? tearButton.querySelector(".tear-label") : null;
    const againButton = document.getElementById("print-again");
    const message = document.getElementById("printer-message");
    const label = wrapper.querySelector(".printer-state-label");
    const led = wrapper.querySelector(".printer-led");
    const serial = wrapper.querySelector(".receipt-serial");
    const time = wrapper.querySelector(".receipt-time");
    const stamp = wrapper.querySelector(".receipt-stamp");
    const stampTitle = wrapper.querySelector(".receipt-stamp .stamp-title");
    const stampCaption = wrapper.querySelector(".receipt-stamp .stamp-caption");
    let tearFocus = null;
    let media = null;
    try { if (typeof eventTarget.matchMedia === "function") media = eventTarget.matchMedia("(prefers-reduced-motion: reduce)"); } catch (_) { /* Optional browser preference. */ }
    const controller = createController({
      reducedMotion: () => Boolean(media && media.matches),
      isHidden: () => document.hidden,
      onState(state) {
        wrapper.dataset.state = state.phase;
        wrapper.setAttribute("aria-busy", String(["analyzing", "feeding", "stamping", "tearing"].includes(state.phase)));
        content.inert = state.inert;
        if (state.inert) content.setAttribute("inert", ""); else content.removeAttribute("inert");
        if (tearButton) {
          tearButton.disabled = !state.canTear;
          tearButton.setAttribute("aria-label", "撕下收据（保留结果）");
          if (tearLabel) tearLabel.textContent = "撕下收据（保留结果）";
        }
        if (againButton) { againButton.disabled = !state.canPrintAgain; againButton.hidden = !state.canPrintAgain; againButton.textContent = "再打印一次（不重新检查）"; }
        if (label) label.textContent = state.label;
        if (message) message.textContent = state.message;
        if (led) { led.dataset.state = state.phase; led.dataset.status = state.led; }
        if (serial) serial.textContent = state.identity ? state.identity.serial : "";
        if (time) {
          time.textContent = state.identity ? state.identity.time : "";
          if (state.identity) time.setAttribute("datetime", state.identity.completedAt); else time.removeAttribute("datetime");
        }
        if (stamp) {
          stamp.dataset.severity = state.identity ? state.identity.severity : "";
          stamp.dataset.state = state.identity ? state.identity.errors ? "error" : state.identity.warnings ? "review" : "clear" : "clear";
        }
        if (stampTitle) stampTitle.textContent = state.identity ? state.identity.stampTitle : "";
        if (stampCaption) stampCaption.textContent = state.identity ? state.identity.stampCaption : "";
        if (["idle", "analyzing", "error"].includes(state.phase)) tearFocus = null;
        if (state.phase === "detached" && tearFocus) {
          const current = document.activeElement;
          const stillOurs = !current || current === tearFocus || current === document.body || current === document.documentElement || (typeof tearFocus.contains === "function" && tearFocus.contains(current));
          tearFocus = null;
          if (stillOurs && againButton && typeof againButton.focus === "function") {
            try { againButton.focus({ preventScroll: true }); } catch (_) { /* Focus is an optional presentation aid. */ }
          }
        }
      },
    });
    const cleanups = [];
    function listen(target, name, callback) {
      if (!target || typeof target.addEventListener !== "function") return;
      target.addEventListener(name, callback);
      cleanups.push(() => target.removeEventListener(name, callback));
    }
    listen(eventTarget, "pack:analysis-start", (event) => controller.start(event.detail));
    listen(eventTarget, "pack:analysis-complete", (event) => controller.complete(event.detail));
    listen(eventTarget, "pack:analysis-error", (event) => controller.error(event.detail));
    listen(eventTarget, "pack:analysis-reset", (event) => controller.reset(event.detail));
    listen(tearButton, "click", () => {
      const current = document.activeElement;
      tearFocus = current && (current === tearButton || (typeof tearButton.contains === "function" && tearButton.contains(current))) ? tearButton : null;
      if (!controller.tear()) tearFocus = null;
    });
    listen(againButton, "click", () => controller.printAgain());
    listen(document, "visibilitychange", () => controller.visibilityChange(document.hidden));
    listen(media, "change", (event) => { if (event.matches) controller.finishPresentation(); });
    const dispose = controller.dispose;
    controller.dispose = () => { cleanups.splice(0).forEach((cleanup) => cleanup()); attached.delete(wrapper); dispose(); };
    attached.set(wrapper, controller);
    return controller;
  }

  function count(value) { return Number.isSafeInteger(value) && value > 0 ? value : 0; }
  function text(value) { return String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 600).trim(); }

  return { createController, attach, timings };
});
