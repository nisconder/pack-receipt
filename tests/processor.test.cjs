const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const Processor = require("../processor.js");
const Demo = require("../demo.js");
const Archive = require("../archive.js");
const Analyzer = require("../analyzer.js");

const http = new URL("https://receipt.example/tool/index.html");
const local = new URL("file:///D:/pack-receipt/index.html");
const file = () => new Blob(["fixture"], { type: "application/x-tar" });
const archiveModel = (name = "fixture") => ({ name, version: "1.0.0", manifest: {}, entries: [], compressedSize: 1, totalUnpacked: 0, warnings: [] });

function dependencies() {
  const calls = { reads: 0, analyses: 0 };
  return {
    calls,
    archive: { async readPackage() { calls.reads += 1; return archiveModel(); } },
    analyzer: { analyze(current, previous) { calls.analyses += 1; return { name: current.name, previous: previous && previous.name }; } },
  };
}

function manualWorkerClass() {
  return class MockWorker {
    static instances = [];
    constructor(url, options) { this.url = url; this.options = options; this.terminated = false; this.constructor.instances.push(this); }
    postMessage(value) { this.request = value; }
    terminate() { this.terminated = true; }
    emit(data) { if (this.onmessage) this.onmessage({ data }); }
  };
}

test("file URLs explicitly use the main thread and yield before reading and analyzing", async () => {
  const events = [];
  const Worker = class { constructor() { assert.fail("file:// must never create a Worker"); } };
  const deps = dependencies();
  const processor = Processor.createProcessor({ location: local, Worker, ...deps });
  setTimeout(() => events.push("event-loop"), 0);
  const result = await processor.process({ current: file(), previous: file() }, (progress) => events.push(progress));
  assert.equal(result.mode, "main");
  assert.equal(deps.calls.reads, 2);
  assert.equal(deps.calls.analyses, 1);
  assert.equal(events[0].reason, "FILE_ORIGIN");
  assert.match(events[0].message, /主线程/);
  assert.ok(events.indexOf("event-loop") < events.findIndex((item) => item.stage === "reading-current"));
  assert.deepEqual(events.filter((item) => item.stage).map((item) => item.stage), ["starting", "reading-current", "reading-previous", "analyzing", "done"]);
  assert.ok(events.filter((item) => item.stage).every((item) => item.mode === "main"));
  processor.dispose();
});

test("HTTP processing waits for a same-origin classic worker handshake and returns worker models", async () => {
  const Worker = manualWorkerClass();
  const deps = dependencies();
  const processor = Processor.createProcessor({ location: http, Worker, ...deps });
  const progress = [];
  const currentFile = file();
  const promise = processor.process({ current: currentFile }, (value) => progress.push(value));
  const worker = Worker.instances[0];
  assert.equal(worker.url, "https://receipt.example/tool/worker.js");
  assert.equal(worker.options.type, "classic");
  assert.equal(worker.request, undefined);
  worker.emit({ type: "ready" });
  assert.equal(worker.request.current, currentFile);
  assert.equal(worker.request.previous, null);
  const id = worker.request.id;
  worker.emit({ type: "progress", id, stage: "reading-current" });
  worker.emit({ type: "result", id, current: archiveModel("worker"), previous: null, report: { fixture: true } });
  const result = await promise;
  assert.equal(result.mode, "worker");
  assert.equal(result.current.name, "worker");
  assert.equal(result.report.fixture, true);
  assert.deepEqual(deps.calls, { reads: 0, analyses: 0 });
  assert.equal(worker.terminated, true);
  assert.ok(progress.every((value) => value.mode === "worker"));
});

test("a constructor/CSP failure falls back exactly once instead of losing the task", async () => {
  const Worker = class { constructor() { throw new DOMException("Denied by CSP", "SecurityError"); } };
  const deps = dependencies();
  const processor = Processor.createProcessor({ location: http, Worker, ...deps });
  const progress = [];
  const result = await processor.process({ current: file() }, (value) => progress.push(value));
  assert.equal(result.mode, "main");
  assert.deepEqual(deps.calls, { reads: 1, analyses: 1 });
  assert.ok(progress.some((value) => value.reason === "WORKER_CONSTRUCTION_FAILED" && value.mode === "main"));
});

test("script-load failures fall back once even if a queued native error follows", async () => {
  const Worker = manualWorkerClass();
  const deps = dependencies();
  const processor = Processor.createProcessor({ location: http, Worker, ...deps });
  const promise = processor.process({ current: file() });
  const worker = Worker.instances[0];
  const queuedError = worker.onerror;
  worker.emit({ type: "boot-error", error: { name: "NetworkError", message: "Script load failed" } });
  queuedError({ preventDefault() {} });
  const result = await promise;
  assert.equal(result.mode, "main");
  assert.deepEqual(deps.calls, { reads: 1, analyses: 1 });
  assert.equal(worker.terminated, true);
});

test("a silent worker startup timeout uses the main-thread fallback", async () => {
  const Worker = manualWorkerClass();
  const deps = dependencies();
  const processor = Processor.createProcessor({ location: http, Worker, startupTimeoutMs: 100, ...deps });
  const result = await processor.process({ current: file() });
  assert.equal(result.mode, "main");
  assert.equal(Worker.instances[0].terminated, true);
  assert.deepEqual(deps.calls, { reads: 1, analyses: 1 });
});

test("a real archive error reported by a ready worker rejects without reprocessing on the main thread", async () => {
  const Worker = manualWorkerClass();
  const deps = dependencies();
  const processor = Processor.createProcessor({ location: http, Worker, ...deps });
  const promise = processor.process({ current: file() });
  const worker = Worker.instances[0];
  worker.emit({ type: "ready" });
  worker.emit({ type: "error", id: worker.request.id, error: { name: "ArchiveError", code: "GZIP_INVALID", slot: "current", message: "本次安装包：gzip 文件已损坏。" } });
  await assert.rejects(promise, (error) => error.name === "ArchiveError" && error.code === "GZIP_INVALID" && error.slot === "current");
  assert.deepEqual(deps.calls, { reads: 0, analyses: 0 });
});

test("an unexpected worker crash after processing starts does not duplicate archive analysis", async () => {
  const Worker = manualWorkerClass();
  const deps = dependencies();
  const processor = Processor.createProcessor({ location: http, Worker, ...deps });
  const promise = processor.process({ current: file() });
  const worker = Worker.instances[0];
  worker.emit({ type: "ready" });
  worker.onerror({ preventDefault() {} });
  await assert.rejects(promise, { code: "WORKER_RUNTIME" });
  assert.deepEqual(deps.calls, { reads: 0, analyses: 0 });
});

test("a new task aborts the old worker and ignores its already queued result", async () => {
  const Worker = manualWorkerClass();
  const processor = Processor.createProcessor({ location: http, Worker });
  const first = processor.process({ current: file() });
  const firstRejected = assert.rejects(first, { name: "AbortError" });
  const old = Worker.instances[0];
  old.emit({ type: "ready" });
  const queued = old.onmessage;
  const previousId = old.request.id;
  const second = processor.process({ current: file() });
  const current = Worker.instances[1];
  current.emit({ type: "ready" });
  queued({ data: { type: "result", id: previousId, current: archiveModel("stale"), report: { stale: true } } });
  current.emit({ type: "result", id: current.request.id, current: archiveModel("current"), report: { current: true } });
  assert.equal((await second).current.name, "current");
  await firstRejected;
  assert.equal(old.terminated, true);
});

test("cancel on the main-thread fallback rejects immediately and suppresses late progress/results", async () => {
  let releaseRead;
  let announceRead;
  const beganReading = new Promise((resolve) => { announceRead = resolve; });
  let analyses = 0;
  const processor = Processor.createProcessor({
    location: local,
    archive: { readPackage() { announceRead(); return new Promise((resolve) => { releaseRead = resolve; }); } },
    analyzer: { analyze() { analyses += 1; return {}; } },
  });
  const progress = [];
  const pending = processor.process({ current: file() }, (value) => progress.push(value));
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await beganReading;
  processor.cancel();
  await rejected;
  releaseRead(archiveModel());
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(analyses, 0);
  assert.equal(progress.some((value) => value.stage === "done"), false);
});

test("dispose cancels active work and prevents new work", async () => {
  const Worker = manualWorkerClass();
  const processor = Processor.createProcessor({ location: http, Worker });
  const pending = processor.process({ current: file() });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  processor.dispose();
  await rejected;
  assert.equal(Worker.instances[0].terminated, true);
  await assert.rejects(processor.process({ current: file() }), { name: "InvalidStateError" });
});

test("the main fallback processes real local demo archives through the real parser and analyzer", async () => {
  const files = await Demo.getDemoFiles();
  const processor = Processor.createProcessor({ location: local });
  const result = await processor.process(files);
  assert.equal(result.mode, "main");
  assert.equal(result.current.version, "0.8.0");
  assert.equal(result.previous.version, "0.7.0");
  assert.ok(result.report.findings.some((value) => value.type === "entry-missing" && value.path === "dist/cli.js"));
  assert.ok(result.report.diff.changed.some((value) => value.path === "dist/index.js" && value.delta === 0));
  processor.dispose();
});

function workerHarness(archive = Archive, analyzer = Analyzer) {
  const messages = [];
  let complete;
  const finished = new Promise((resolve) => { complete = resolve; });
  const scope = {
    importScripts(...paths) {
      assert.deepEqual(paths, ["archive.js", "analyzer.js"]);
      this.PackArchive = archive;
      this.PackAnalyzer = analyzer;
    },
    postMessage(message, transfer) {
      if (message.type === "result") {
        assert.equal(new Set(transfer).size, transfer.length);
        const cloned = structuredClone(message, { transfer });
        messages.push({ message: cloned, buffers: transfer.length });
        complete(cloned);
      } else {
        messages.push({ message });
        if (message.type === "error") complete(message);
      }
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../worker.js"), "utf8"), { self: scope, ArrayBuffer, Uint8Array });
  return { scope, messages, finished };
}

test("the actual worker transfers each shared tar backing buffer only once", async () => {
  const files = await Demo.getDemoFiles();
  const worker = workerHarness();
  assert.equal(worker.messages[0].message.type, "ready");
  worker.scope.onmessage({ data: { type: "process", id: 7, ...files } });
  const result = await worker.finished;
  assert.equal(result.type, "result");
  assert.equal(result.id, 7);
  assert.equal(worker.messages.at(-1).buffers, 2);
  assert.ok(result.current.entries.every((entry) => entry.bytes.buffer === result.current.entries[0].bytes.buffer));
  assert.ok(result.current.entries.some((entry) => entry.path === "package.json" && entry.bytes.byteLength > 0));
  assert.ok(result.report.findings.some((finding) => finding.type === "sensitive-config"));
});

test("the actual worker reports a malformed archive once rather than failing its script load", async () => {
  let reads = 0;
  const worker = workerHarness({ async readPackage(input) { reads += 1; return Archive.readPackage(input); } });
  worker.scope.onmessage({ data: { type: "process", id: 3, current: new Blob([]), previous: null } });
  const result = await worker.finished;
  assert.equal(result.type, "error");
  assert.equal(result.error.name, "ArchiveError");
  assert.equal(result.error.code, "INPUT_EMPTY");
  assert.equal(result.error.slot, "current");
  assert.equal(reads, 1);
  assert.equal(worker.messages.filter((item) => item.message.type === "boot-error").length, 0);
});

test("the browser UMD processor rejects a cross-origin script location and keeps processing local", async () => {
  const deps = dependencies();
  let workers = 0;
  const browser = {
    PackArchive: deps.archive,
    PackAnalyzer: deps.analyzer,
    document: { currentScript: { src: "https://unrelated.example/processor.js" } },
    location: http,
    Worker: class { constructor() { workers += 1; } },
    URL, setTimeout, clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../processor.js"), "utf8"), browser);
  const result = await browser.PackProcessor.createProcessor().process({ current: file() });
  assert.equal(result.mode, "main");
  assert.equal(workers, 0);
  assert.deepEqual(deps.calls, { reads: 1, analyses: 1 });
});
