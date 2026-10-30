const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const Printer = require("../printer.js");

function clock() {
  let now = 0;
  let sequence = 0;
  const jobs = new Map();
  return {
    jobs,
    setTimeout(callback, delay) { const id = ++sequence; jobs.set(id, { callback, time: now + delay }); return id; },
    clearTimeout(id) { jobs.delete(id); },
    advance(milliseconds) {
      const target = now + milliseconds;
      for (;;) {
        const next = [...jobs.entries()].filter(([, job]) => job.time <= target).sort((a, b) => a[1].time - b[1].time)[0];
        if (!next) break;
        now = next[1].time;
        jobs.delete(next[0]);
        next[1].callback();
      }
      now = target;
    },
  };
}

function fixture(options = {}) {
  const timer = clock();
  const states = [];
  const controller = Printer.createController({ setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout, onState: (value) => states.push(value), ...options });
  return { timer, states, controller };
}

const detail = (id, overrides = {}) => ({ id, name: "@demo/kit", version: "1.2.3", completedAt: "2026-10-30T10:20:30.000Z", errors: 1, warnings: 2, ...overrides });

test("feeding and stamping control only presentation, with deterministic interaction boundaries", () => {
  const { controller, timer, states } = fixture();
  assert.equal(controller.getState().phase, "idle");
  assert.equal(controller.tear(), false);
  assert.equal(controller.start({ id: 1 }), true);
  assert.equal(controller.getState().phase, "analyzing");
  assert.equal(controller.getState().inert, false);
  assert.equal(controller.complete(detail(1)), true);
  assert.equal(controller.getState().phase, "feeding");
  assert.equal(controller.getState().inert, true);
  assert.equal(controller.getState().canTear, false);
  timer.advance(899);
  assert.equal(controller.getState().phase, "feeding");
  timer.advance(1);
  assert.equal(controller.getState().phase, "stamping");
  assert.equal(controller.getState().inert, true);
  timer.advance(450);
  assert.equal(controller.getState().phase, "ready");
  assert.equal(controller.getState().inert, false);
  assert.equal(controller.getState().canTear, true);
  assert.equal(timer.jobs.size, 0);
  assert.deepEqual(states.map((state) => state.phase), ["idle", "analyzing", "feeding", "stamping", "ready"]);
});

test("tear retains the identity and reprint repeats presentation without starting analysis", () => {
  const { controller, timer, states } = fixture();
  controller.start({ id: 7 });
  controller.complete(detail(7));
  timer.advance(1350);
  const identity = controller.getState().identity;
  assert.equal(controller.tear(), true);
  assert.equal(controller.getState().phase, "tearing");
  assert.equal(controller.tear(), false);
  timer.advance(360);
  assert.equal(controller.getState().phase, "detached");
  assert.equal(controller.getState().inert, false);
  assert.equal(controller.getState().canPrintAgain, true);
  assert.deepEqual(controller.getState().identity, identity);
  assert.match(controller.getState().message, /仍可查看、复制和导出/);
  assert.equal(controller.printAgain(), true);
  assert.equal(controller.getState().phase, "feeding");
  assert.equal(controller.printAgain(), false);
  timer.advance(1350);
  assert.equal(controller.getState().phase, "ready");
  assert.deepEqual(controller.getState().identity, identity);
  assert.equal(states.filter((state) => state.phase === "analyzing").length, 1);
});

test("reduced motion reaches interactive final states immediately without timers", () => {
  const { controller, timer } = fixture({ reducedMotion: true });
  controller.start({ id: 1 });
  controller.complete(detail(1));
  assert.equal(controller.getState().phase, "ready");
  assert.equal(controller.getState().inert, false);
  controller.tear();
  assert.equal(controller.getState().phase, "detached");
  controller.printAgain();
  assert.equal(controller.getState().phase, "ready");
  assert.equal(timer.jobs.size, 0);
});

test("new work, errors and reset cancel all pending motion and clear previous stamp metadata", () => {
  const { controller, timer } = fixture();
  controller.start({ id: 1 });
  controller.complete(detail(1));
  const queued = [...timer.jobs.values()][0].callback;
  controller.start({ id: 2 });
  assert.equal(timer.jobs.size, 0);
  assert.equal(controller.getState().identity, null);
  assert.equal(controller.getState().inert, false);
  queued();
  assert.equal(controller.getState().phase, "analyzing");
  controller.complete(detail(2));
  controller.error({ id: 2, message: "本次安装包未能读取。" });
  assert.equal(controller.getState().phase, "error");
  assert.equal(controller.getState().identity, null);
  assert.equal(controller.getState().inert, false);
  assert.equal(controller.getState().message, "本次安装包未能读取。");
  assert.equal(timer.jobs.size, 0);
  controller.start({ id: 3 });
  controller.complete(detail(3));
  controller.reset({ id: 4 });
  timer.advance(5000);
  assert.equal(controller.getState().phase, "idle");
  assert.equal(controller.getState().identity, null);
  assert.equal(controller.getState().inert, false);
});

test("stale, duplicate and unstarted completions cannot replace the current identity or restart motion", () => {
  const { controller, timer } = fixture();
  assert.equal(controller.complete(detail(1)), false);
  controller.start({ id: 2 });
  assert.equal(controller.complete(detail(1)), false);
  assert.equal(controller.complete(detail(3)), false);
  assert.equal(controller.start({ id: 2 }), false);
  assert.equal(controller.start({ id: "3" }), false);
  controller.complete(detail(2));
  const firstTimer = [...timer.jobs.keys()][0];
  assert.equal(controller.complete(detail(2, { name: "stale" })), false);
  assert.equal([...timer.jobs.keys()][0], firstTimer);
  assert.equal(controller.getState().identity.name, "@demo/kit");
  controller.reset({ id: 4 });
  assert.equal(controller.error({ id: 2, message: "old error" }), false);
  assert.equal(controller.reset({ id: 3 }), false);
  assert.equal(controller.complete(detail(2)), false);
  assert.equal(controller.getState().phase, "idle");
});

test("backgrounding finishes visual timers without inventing an analysis result", () => {
  let hidden = false;
  const { controller, timer } = fixture({ isHidden: () => hidden });
  controller.start({ id: 1 });
  controller.visibilityChange(true);
  assert.equal(controller.getState().phase, "analyzing");
  controller.complete(detail(1));
  controller.visibilityChange(true);
  assert.equal(controller.getState().phase, "ready");
  assert.equal(controller.getState().inert, false);
  assert.equal(timer.jobs.size, 0);
  controller.tear();
  controller.visibilityChange(true);
  assert.equal(controller.getState().phase, "detached");
  assert.equal(timer.jobs.size, 0);
  hidden = true;
  controller.start({ id: 2 });
  controller.complete(detail(2));
  assert.equal(controller.getState().phase, "ready");
  assert.equal(timer.jobs.size, 0);
});

test("identity uses the analysis time and review counts without a security approval claim", () => {
  const { controller } = fixture({ reducedMotion: true, now: () => new Date("2026-10-30T01:00:00.000Z") });
  controller.start({ id: 1 });
  controller.complete(detail(1));
  const identity = controller.getState().identity;
  assert.equal(identity.completedAt, "2026-10-30T10:20:30.000Z");
  assert.match(identity.time, /^分析于 \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} · 本机时间$/);
  assert.doesNotMatch(identity.time, /发布时间|发布于/);
  assert.match(identity.serial, /^PR-\d{8}-000001$/);
  assert.equal(identity.stampTitle, "待修复");
  assert.equal(identity.stampCaption, "1 项需要修复 · 2 项需要复核");
  controller.start({ id: 2 });
  controller.complete(detail(2, { errors: 0, warnings: 3 }));
  assert.equal(controller.getState().identity.stampTitle, "待复核");
  controller.start({ id: 3 });
  controller.complete(detail(3, { errors: 0, warnings: 0, completedAt: "invalid" }));
  assert.equal(controller.getState().identity.completedAt, "2026-10-30T01:00:00.000Z");
  assert.equal(controller.getState().identity.stampTitle, "收据已生成");
  assert.doesNotMatch(controller.getState().identity.stampTitle, /安全|批准|通过/);
});

test("dispose releases interaction and prevents queued timers from changing state", () => {
  const { controller, timer } = fixture();
  controller.start({ id: 1 });
  controller.complete(detail(1));
  const queued = [...timer.jobs.values()][0].callback;
  controller.dispose();
  queued();
  assert.equal(controller.getState().phase, "idle");
  assert.equal(controller.getState().inert, false);
  assert.equal(controller.getState().identity, null);
  assert.equal(timer.jobs.size, 0);
  assert.equal(controller.start({ id: 2 }), false);
  assert.equal(controller.complete(detail(1)), false);
});

class NodeTarget extends EventTarget {
  constructor() { super(); this.dataset = {}; this.attributes = new Map(); this.textContent = ""; this.disabled = false; this.hidden = false; this.inert = false; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  removeAttribute(key) { this.attributes.delete(key); }
}

function domFixture() {
  const wrapper = new NodeTarget();
  const content = new NodeTarget();
  const nodes = new Map(["tear-receipt", "print-again", "printer-message"].map((id) => [id, new NodeTarget()]));
  const tearLabel = new NodeTarget();
  nodes.get("tear-receipt").querySelector = (selector) => selector === ".tear-label" ? tearLabel : null;
  nodes.get("tear-receipt").textContent = "保持原有图标和撕纸线";
  const selectors = new Map([".printer-state-label", ".printer-led", ".receipt-serial", ".receipt-time", ".receipt-stamp", ".receipt-stamp .stamp-title", ".receipt-stamp .stamp-caption"].map((selector) => [selector, new NodeTarget()]));
  wrapper.querySelector = (selector) => selectors.get(selector) || null;
  nodes.set("receipt-printer", wrapper);
  nodes.set("report-content", content);
  const media = new NodeTarget();
  media.matches = true;
  const window = new NodeTarget();
  window.matchMedia = () => media;
  const document = new NodeTarget();
  document.hidden = false;
  document.getElementById = (id) => nodes.get(id) || null;
  document.defaultView = window;
  document.body = new NodeTarget();
  document.documentElement = new NodeTarget();
  document.activeElement = document.body;
  const focusCalls = [];
  for (const [id, node] of nodes) node.focus = () => { document.activeElement = node; focusCalls.push(id); };
  return { wrapper, content, nodes, selectors, window, document, media, tearLabel, focusCalls };
}

function send(target, type, detail) {
  const event = new Event(type);
  Object.defineProperty(event, "detail", { value: detail });
  target.dispatchEvent(event);
}

test("DOM attachment reflects truthful printer states, preserves results after tear, and clears stale stamps", () => {
  const dom = domFixture();
  const controller = Printer.attach(dom.document, dom.window);
  assert.equal(Printer.attach(dom.document, dom.window), controller);
  send(dom.window, "pack:analysis-start", { id: 1 });
  send(dom.window, "pack:analysis-complete", detail(1));
  assert.equal(dom.wrapper.dataset.state, "ready");
  assert.equal(dom.content.inert, false);
  assert.equal(dom.nodes.get("tear-receipt").disabled, false);
  assert.match(dom.tearLabel.textContent, /保留结果/);
  assert.equal(dom.nodes.get("tear-receipt").textContent, "保持原有图标和撕纸线");
  assert.equal(dom.selectors.get(".receipt-stamp .stamp-title").textContent, "待修复");
  assert.equal(dom.selectors.get(".receipt-stamp").dataset.state, "error");
  assert.equal(dom.selectors.get(".receipt-time").attributes.get("datetime"), detail(1).completedAt);
  dom.nodes.get("tear-receipt").dispatchEvent(new Event("click"));
  assert.equal(dom.wrapper.dataset.state, "detached");
  assert.equal(dom.nodes.get("print-again").hidden, false);
  assert.equal(dom.content.inert, false);
  dom.nodes.get("print-again").dispatchEvent(new Event("click"));
  assert.equal(dom.wrapper.dataset.state, "ready");
  send(dom.window, "pack:analysis-reset", { id: 2 });
  assert.equal(dom.wrapper.dataset.state, "idle");
  assert.equal(dom.selectors.get(".receipt-stamp .stamp-title").textContent, "");
  assert.equal(dom.selectors.get(".receipt-stamp").dataset.state, "clear");
  assert.equal(dom.selectors.get(".receipt-serial").textContent, "");
  controller.dispose();
  send(dom.window, "pack:analysis-start", { id: 3 });
  assert.equal(dom.wrapper.dataset.state, "idle");
});

test("browser UMD auto-attaches without a required application call", () => {
  const dom = domFixture();
  dom.document.readyState = "interactive";
  const browser = { document: dom.document, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(require.resolve("../printer.js"), "utf8"), browser);
  assert.equal(typeof browser.PackPrinter.createController, "function");
  send(dom.window, "pack:analysis-start", { id: 1 });
  send(dom.window, "pack:analysis-complete", detail(1));
  assert.equal(dom.wrapper.dataset.state, "ready");
  browser.PackPrinter.attach(dom.document, dom.window).dispose();
});

test("stamp appearance maps review counts to the existing error/review/clear skin states", () => {
  const dom = domFixture();
  const controller = Printer.attach(dom.document, dom.window);
  send(dom.window, "pack:analysis-start", { id: 1 });
  send(dom.window, "pack:analysis-complete", detail(1, { errors: 0, warnings: 2 }));
  assert.equal(dom.selectors.get(".receipt-stamp").dataset.state, "review");
  send(dom.window, "pack:analysis-start", { id: 2 });
  send(dom.window, "pack:analysis-complete", detail(2, { errors: 0, warnings: 0 }));
  assert.equal(dom.selectors.get(".receipt-stamp").dataset.state, "clear");
  assert.equal(dom.selectors.get(".receipt-stamp .stamp-title").textContent, "收据已生成");
  controller.dispose();
});

test("only the user-focused tear flow moves focus to print-again; normal completion never steals focus", () => {
  const dom = domFixture();
  const controller = Printer.attach(dom.document, dom.window);
  send(dom.window, "pack:analysis-start", { id: 1 });
  send(dom.window, "pack:analysis-complete", detail(1));
  assert.deepEqual(dom.focusCalls, []);
  assert.equal(dom.document.activeElement, dom.document.body);
  dom.nodes.get("tear-receipt").focus();
  dom.nodes.get("tear-receipt").dispatchEvent(new Event("click"));
  assert.equal(dom.wrapper.dataset.state, "detached");
  assert.equal(dom.document.activeElement, dom.nodes.get("print-again"));
  assert.deepEqual(dom.focusCalls, ["tear-receipt", "print-again"]);
  send(dom.window, "pack:analysis-start", { id: 2 });
  send(dom.window, "pack:analysis-complete", detail(2));
  assert.deepEqual(dom.focusCalls, ["tear-receipt", "print-again"]);
  controller.dispose();
});

test("a focus change during tearing is respected instead of being moved back to the printer", () => {
  const dom = domFixture();
  const controller = Printer.attach(dom.document, dom.window);
  send(dom.window, "pack:analysis-start", { id: 1 });
  send(dom.window, "pack:analysis-complete", detail(1));
  dom.media.matches = false;
  dom.nodes.get("tear-receipt").focus();
  dom.nodes.get("tear-receipt").dispatchEvent(new Event("click"));
  assert.equal(dom.wrapper.dataset.state, "tearing");
  const differentControl = new NodeTarget();
  dom.document.activeElement = differentControl;
  controller.finishPresentation();
  assert.equal(dom.wrapper.dataset.state, "detached");
  assert.equal(dom.document.activeElement, differentControl);
  assert.deepEqual(dom.focusCalls, ["tear-receipt"]);
  controller.dispose();
});
