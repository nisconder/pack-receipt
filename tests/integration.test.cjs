const test = require("node:test");
const assert = require("node:assert/strict");

const demo = require("../demo.js");
const archive = require("../archive.js");
const analyzer = require("../analyzer.js");

async function demoPackages() {
  const files = await demo.getDemoFiles();
  return {
    current: await archive.readPackage(files.current),
    previous: await archive.readPackage(files.previous),
  };
}

test("actual demo archives feed the parser and analyzer with their declared package versions", async () => {
  const { current, previous } = await demoPackages();
  const report = analyzer.analyze(current, previous);
  assert.equal(current.name, "@demo/note-kit");
  assert.equal(previous.name, current.name);
  assert.equal(previous.version, "0.7.0");
  assert.equal(current.version, "0.8.0");
  assert.equal(current.warnings.length, 0);
  assert.equal(previous.warnings.length, 0);
  assert.equal(report.hasBaseline, true);
  assert.equal(report.package.previousVersion, "0.7.0");
  assert.ok(report.stats.sizeDelta > 40_000);
  assert.equal(report.growth[0].path, "fixtures/sample-notes.csv");
  const sameSizeChange = report.diff.changed.find((entry) => entry.path === "dist/index.js");
  assert.ok(sameSizeChange);
  assert.equal(sameSizeChange.delta, 0);
  assert.ok(report.diff.removed.some((entry) => entry.path === "dist/legacy.js"));
  assert.ok(report.diff.removed.some((entry) => entry.path === "dist/cli.js"));
  assert.deepEqual(report.findings.filter((entry) => entry.type === "entry-missing").map((entry) => entry.path), ["dist/cli.js"]);
  assert.ok(report.findings.some((entry) => entry.type === "lifecycle-review"));
  assert.ok(report.findings.some((entry) => entry.type === "sensitive-config" && entry.path === ".env"));
  assert.ok(report.findings.some((entry) => entry.type === "source-map" && entry.path === "dist/index.js.map"));
  assert.equal(report.scripts.added[0].name, "preinstall");
});

test("single-package receipt makes no version comparison and does not label lifecycle scripts as newly added", async () => {
  const { current } = await demoPackages();
  const report = analyzer.analyze(current);
  assert.equal(report.hasBaseline, false);
  assert.equal(report.package.previousVersion, null);
  assert.equal(report.stats.previous, null);
  assert.equal(report.stats.sizeDelta, null);
  assert.equal(report.stats.sizeDeltaPercent, null);
  assert.equal(report.diff.changed.length, 0);
  assert.equal(report.diff.removed.length, 0);
  assert.equal(report.diff.added.length, current.entries.length);
  assert.ok(!report.findings.some((entry) => entry.type === "size-growth"));
  assert.ok(report.findings.filter((entry) => entry.type === "lifecycle-review").every((entry) => !entry.title.includes("新增")));
  assert.match(report.markdown, /未提供旧包/);
});

test("demo receipt JSON and Markdown omit archive bytes, manifests and fake configuration values", async () => {
  const { current, previous } = await demoPackages();
  const report = analyzer.analyze(current, previous);
  const exported = { schemaVersion: 1, demo: true, ...report };
  const serialized = JSON.stringify(exported);
  assertNoArchivePayload(exported);
  assert.doesNotMatch(serialized, /FAKE_NOT_A_VALID_TOKEN_FOR_PACK_RECEIPT|FAKE_NOT_A_REAL_PASSWORD/);
  assert.match(serialized, /DEMO_API_TOKEN/);
  assert.match(serialized, /DEMO_PASSWORD/);
  assert.equal(report.markdown, analyzer.toMarkdown(report));
  assert.doesNotMatch(report.markdown, /FAKE_NOT_A_VALID_TOKEN_FOR_PACK_RECEIPT|FAKE_NOT_A_REAL_PASSWORD/);
  assert.match(report.markdown, /dist\/cli\.js/);
  assert.match(report.markdown, /preinstall/);
});

test("untrusted real tar metadata stays data and exported script credentials are redacted", async () => {
  const marker = "__PACK_RECEIPT_SCRIPT_RAN__";
  delete globalThis[marker];
  const hostilePath = "package/assets/<img onerror=packReceiptXss()>.txt";
  const manifest = {
    name: "@demo/untrusted-fixture",
    version: "1.0.0",
    scripts: { preinstall: `node -e "globalThis.${marker}=1" --token FAKE_DO_NOT_EXPORT_THIS_VALUE` },
  };
  const tar = demo.createTar([
    { path: "package/package.json", content: JSON.stringify(manifest) },
    { path: hostilePath, content: "<script>globalThis.__PACK_RECEIPT_SCRIPT_RAN__=1</script>" },
    { path: "package/.env", content: "PASSWORD=FAKE_PRIVATE_CONFIGURATION_VALUE\n" },
    { path: "package/key.pem", content: "-----BEGIN PRIVATE KEY-----\nFAKE_PRIVATE_KEY_FIXTURE_ONLY\n-----END PRIVATE KEY-----\n" },
  ]);
  const parsed = await archive.readPackage(tar);
  const report = analyzer.analyze(parsed);
  assert.equal(globalThis[marker], undefined);
  assert.ok(report.diff.added.some((entry) => entry.path === "assets/<img onerror=packReceiptXss()>.txt"));
  assert.ok(report.findings.some((entry) => entry.type === "private-key"));
  assert.doesNotMatch(JSON.stringify(report), /FAKE_DO_NOT_EXPORT_THIS_VALUE|FAKE_PRIVATE_CONFIGURATION_VALUE|FAKE_PRIVATE_KEY_FIXTURE_ONLY/);
  assertNoArchivePayload(report);
});

function assertNoArchivePayload(value) {
  if (!value || typeof value !== "object") return;
  assert.ok(!(value instanceof ArrayBuffer));
  assert.ok(!ArrayBuffer.isView(value));
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!["bytes", "entries", "manifest", "sourcesContent"].includes(key), `Unexpected archive payload in receipt: ${key}`);
    assertNoArchivePayload(child);
  }
}
