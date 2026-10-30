const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("../theme.js"), "utf8");

function host(options = {}) {
  const events = [];
  const writes = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  const mediaListeners = new Map();
  let controlsReady = false;
  const control = () => ({
    value: "system", title: "", attributes: {}, listeners: new Map(),
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    setAttribute(key, value) { this.attributes[key] = value; },
  });
  const select = control();
  const toggle = control();
  const root = { dataset: {} };
  const media = { matches: Boolean(options.dark), addEventListener(type, listener) { mediaListeners.set(type, listener); } };
  const document = {
    documentElement: root, readyState: "loading",
    getElementById(id) { return controlsReady ? id === "theme-select" ? select : id === "theme-toggle" ? toggle : null : null; },
    addEventListener(type, listener) { documentListeners.set(type, listener); },
  };
  const window = {
    localStorage: {
      getItem(key) { if (options.storageDenied) throw Error("Storage unavailable"); return key === "pack-receipt.theme" ? options.saved ?? null : null; },
      setItem(key, value) { if (options.storageDenied) throw Error("Storage unavailable"); writes.push([key, value]); },
    },
    matchMedia() { return media; },
    addEventListener(type, listener) { windowListeners.set(type, listener); },
    dispatchEvent(event) { events.push(event); },
  };
  class CustomEvent { constructor(type, options) { this.type = type; this.detail = options.detail; } }
  vm.runInNewContext(source, { window, document, CustomEvent });
  return {
    root, events, writes, select, toggle,
    ready() { controlsReady = true; documentListeners.get("DOMContentLoaded")(); },
    choose(value) { select.value = value; select.listeners.get("change")(); },
    cycle() { toggle.listeners.get("click")(); },
    system(dark) { media.matches = dark; mediaListeners.get("change")(); },
    storage(key, newValue) { windowListeners.get("storage")({ key, newValue }); },
  };
}

test("theme applies a saved preference before controls exist and never writes on startup", () => {
  const app = host({ saved: "dark", dark: false });
  assert.equal(app.root.dataset.theme, "dark");
  assert.equal(app.root.dataset.themePreference, "dark");
  assert.equal(app.writes.length, 0);
  assert.equal(app.events[0].type, "pack-theme-change");
  app.ready();
  assert.equal(app.select.value, "dark");
  assert.match(app.toggle.attributes["aria-label"], /当前：深色/);
});

test("system changes update the resolved theme only while system preference is selected", () => {
  const app = host({ dark: true });
  app.ready();
  assert.equal(app.root.dataset.theme, "dark");
  app.system(false);
  assert.equal(app.root.dataset.theme, "light");
  app.choose("light");
  app.system(true);
  assert.equal(app.root.dataset.theme, "light");
  assert.equal(app.root.dataset.themePreference, "light");
  app.choose("system");
  assert.equal(app.root.dataset.theme, "dark");
  assert.deepEqual(app.writes, [["pack-receipt.theme", "light"], ["pack-receipt.theme", "system"]]);
});

test("the retained theme button cycles system, light, dark and synchronizes the select", () => {
  const app = host();
  app.ready();
  for (const expected of ["light", "dark", "system"]) {
    app.cycle();
    assert.equal(app.root.dataset.themePreference, expected);
    assert.equal(app.select.value, expected);
  }
  assert.ok(app.events.every((event) => event.type === "pack-theme-change" && ["system", "light", "dark"].includes(event.detail.preference)));
});

test("blocked preference storage does not prevent controls from changing the theme", () => {
  const app = host({ storageDenied: true });
  app.ready();
  assert.doesNotThrow(() => app.choose("dark"));
  assert.equal(app.root.dataset.theme, "dark");
  assert.equal(app.root.dataset.themePreference, "dark");
  assert.equal(app.writes.length, 0);
});

test("malformed preferences fall back to system and unrelated storage changes are ignored", () => {
  const app = host({ saved: "unexpected", dark: true });
  app.ready();
  assert.equal(app.root.dataset.themePreference, "system");
  app.storage("unrelated-key", "light");
  assert.equal(app.root.dataset.theme, "dark");
  app.storage("pack-receipt.theme", "light");
  assert.equal(app.root.dataset.theme, "light");
  assert.equal(app.select.value, "light");
  app.storage(null, null);
  assert.equal(app.root.dataset.themePreference, "system");
  assert.equal(app.root.dataset.theme, "dark");
  assert.equal(app.writes.length, 0);
});
