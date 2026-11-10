const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const analyzer = require("../analyzer.js");

function file(path, content = "x", type = "file") {
  const bytes = new TextEncoder().encode(content);
  return { path, type, bytes, size: bytes.length };
}
function archive(manifest = {}, entries = [], version = "1.0.0") {
  return { name: manifest.name || "sample", version, manifest: { name: "sample", version, ...manifest }, entries, compressedSize: 20, totalUnpacked: entries.reduce((n, entry) => n + entry.size, 0), warnings: [] };
}

test("works as both CommonJS and a browser global without runtime dependencies", () => {
  const browser = { TextEncoder, TextDecoder, Uint8Array, ArrayBuffer };
  vm.runInNewContext(fs.readFileSync(require.resolve("../analyzer.js"), "utf8"), browser);
  assert.equal(typeof browser.PackAnalyzer.analyze, "function");
  assert.equal(typeof analyzer.toMarkdown, "function");
  assert.equal(browser.PackAnalyzer.analyze(archive()).stats.current.fileCount, 0);
});

test("detects an absent CLI and exact exports while preserving condition paths", () => {
  const report = analyzer.analyze(archive({
    main: "./dist/index.js", bin: { sample: "bin/sample.js" }, types: "dist/index.d.ts",
    exports: { ".": { import: "./dist/index.mjs", require: "./dist/index.cjs", types: "./dist/index.d.ts" } },
  }, [file("dist/index.js"), file("dist/index.mjs"), file("dist/index.d.ts")]));
  const missing = report.findings.filter((finding) => finding.type === "entry-missing");
  assert.deepEqual(missing.map((finding) => finding.path).sort(), ["bin/sample.js", "dist/index.cjs"]);
  assert.ok(missing.some((finding) => finding.evidence.includes("exports[.][require] → ./dist/index.cjs")));
});

test("does not treat export patterns, blocked entries, or external imports as absent files", () => {
  const report = analyzer.analyze(archive({
    exports: { ".": { node: { import: "./index.mjs", require: "./index.cjs" }, default: "./fallback.js" }, "./features/*": "./dist/*.js", "./blocked": null },
    imports: { "#native": { node: "node:fs", default: "external-package" }, "#local": "./local.js" },
  }, [file("index.mjs"), file("index.cjs"), file("fallback.js"), file("local.js")]));
  assert.equal(report.findings.filter((finding) => finding.type === "entry-missing").length, 0);
  assert.equal(report.findings.filter((finding) => finding.type === "entry-pattern").length, 1);
  assert.equal(report.findings.find((finding) => finding.type === "entry-pattern").severity, "info");
});

test("handles main extension resolution but keeps exports exact and decodes file URL paths", () => {
  const report = analyzer.analyze(archive({ main: "dist/index", module: "lib", types: "types/api", exports: { ".": "./dist/index", "./space": "./file%20name.js?mode=demo" } }, [
    file("dist/index.js"), file("lib/index.js"), file("types/api.d.ts"), file("file name.js"),
  ]));
  assert.deepEqual(report.findings.filter((item) => item.type === "entry-missing").map((item) => item.path), ["dist/index"]);
});

test("a content change with identical byte length is changed rather than unchanged", () => {
  const before = archive({}, [file("index.js", "abc"), file("same.js", "abc"), file("gone.js")], "1.0.0");
  const current = archive({}, [file("index.js", "abd"), file("same.js", "abc"), file("new.js")], "1.0.1");
  const report = analyzer.analyze(current, before);
  assert.deepEqual(report.diff.changed.map((item) => [item.path, item.delta]), [["index.js", 0]]);
  assert.deepEqual(report.diff.added.map((item) => item.path), ["new.js"]);
  assert.deepEqual(report.diff.removed.map((item) => item.path), ["gone.js"]);
  assert.deepEqual(report.diff.unchanged.map((item) => item.path), ["same.js"]);
});

test("counts non-directory links and detects a changed link destination", () => {
  const before = archive({}, [{ path: "folder/", type: "directory", size: 0 }, { path: "cli", type: "symlink", size: 0, linkname: "a.js" }]);
  const current = archive({}, [{ path: "folder/", type: "directory", size: 0 }, { path: "cli", type: "symlink", size: 0, linkname: "b.js" }]);
  const report = analyzer.analyze(current, before);
  assert.equal(report.stats.current.fileCount, 1);
  assert.deepEqual(report.diff.changed.map((item) => item.path), ["cli"]);
});

test("preserves special entry metadata instead of treating it as an empty regular file", () => {
  const before = archive({}, [file("index.js", "")]);
  const special = { path: "index.js", type: "special", size: 0, bytes: new Uint8Array() };
  const current = archive({ main: "index.js", exports: "./index.js" }, [special]);
  const report = analyzer.analyze(current, before);
  assert.equal(report.stats.current.fileCount, 1);
  assert.deepEqual(report.diff.changed.map((item) => [item.path, item.type]), [["index.js", "special"]]);
  assert.equal(report.diff.unchanged.length, 0);
  const findings = report.findings.filter((item) => item.path === "index.js");
  assert.ok(findings.every((item) => item.type === "entry-non-regular" && item.severity === "info"));
  assert.ok(findings.every((item) => item.title.includes("非普通文件")));
  assert.ok(findings.every((item) => !item.title.includes("链接")));
  const identicalMetadata = analyzer.analyze(current, archive({}, [{ ...special }]));
  assert.equal(identicalMetadata.diff.unchanged.length, 1);
});

test("missing condition and array targets are path evidence rather than a claim that every runtime fails", () => {
  const report = analyzer.analyze(archive({ exports: { ".": { custom: ["./absent.js", "./present.js"], default: "./present.js" } } }, [file("present.js")]));
  const missing = report.findings.filter((item) => item.type === "entry-missing");
  assert.equal(missing.length, 1);
  assert.ok(missing[0].evidence.includes("exports[.][custom][0] → ./absent.js"));
  assert.match(missing[0].detail, /不模拟条件选择、数组回退或运行时解析/);
  assert.match(missing[0].detail, /不能单独据此断言整个包不可用/);
});

test("separates lifecycle additions, changes and removals without claiming malice", () => {
  const before = archive({ scripts: { install: "node old.js", prepare: "node build.js", test: "node test.js" } });
  const current = archive({ scripts: { install: "node new.js", postinstall: "node setup.js", test: "node test.js" } });
  const report = analyzer.analyze(current, before);
  assert.deepEqual(report.scripts.added.map((item) => item.name), ["postinstall"]);
  assert.deepEqual(report.scripts.changed.map((item) => item.name), ["install"]);
  assert.deepEqual(report.scripts.removed.map((item) => item.name), ["prepare"]);
  assert.deepEqual(report.scripts.unchanged.map((item) => item.name), ["test"]);
  assert.ok(report.findings.filter((item) => item.type === "lifecycle-review").every((item) => item.severity === "warning" && item.detail.includes("本身不代表恶意")));
  assert.equal(report.findings.find((item) => item.type === "lifecycle-removed").severity, "info");
});

test("without a baseline lifecycle review never claims that a script is new", () => {
  const report = analyzer.analyze(archive({ scripts: { postinstall: "node setup.js" } }));
  const review = report.findings.find((item) => item.type === "lifecycle-review");
  assert.doesNotMatch(review.title, /新增/);
  assert.ok(review.evidence.some((text) => text.includes("无法判断是否新增")));
  assert.match(report.markdown, /仅列出当前 scripts/);
});

test("sensitive config and key findings export paths and key names, never secret contents", () => {
  const secret = "do-not-export-this-token";
  const privateKey = "-----BEGIN RSA PRIVATE KEY-----\nsecret-key-data\n-----END RSA PRIVATE KEY-----";
  const report = analyzer.analyze(archive({}, [file(".env", "PASSWORD=" + secret), file(".npmrc", "//registry.npmjs.org/:_authToken=" + secret), file("fixtures/key.pem", privateKey), file("lib/index.js.map", "{}") ]));
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /do-not-export-this-token|secret-key-data/);
  assert.ok(report.findings.some((item) => item.type === "sensitive-config" && item.path === ".env" && item.severity === "warning"));
  assert.ok(report.findings.some((item) => item.type === "private-key" && item.severity === "error"));
  assert.equal(report.findings.find((item) => item.type === "source-map").severity, "info");
  assert.ok(report.findings.some((item) => item.evidence.some((text) => text.includes("PASSWORD"))));
  assert.equal(serialized.includes('"bytes"'), false);
});

test("env and npmrc examples are informational rather than automatically dangerous", () => {
  const report = analyzer.analyze(archive({}, [file(".env.example", "API_KEY=placeholder"), file(".env.production.sample", "PASSWORD=placeholder"), file(".npmrc.template", "registry=https://registry.npmjs.org/")]));
  assert.equal(report.findings.length, 3);
  assert.ok(report.findings.every((finding) => finding.type === "config-example" && finding.severity === "info"));
});

test("reports top growth and warns on mismatched names without suppressing comparison", () => {
  const before = archive({ name: "old-name" }, [file("index.js", "x")]);
  const current = archive({ name: "new-name" }, [file("index.js", "xxxx"), file("extra.js", "xxxxxx")]);
  const report = analyzer.analyze(current, before);
  assert.equal(report.stats.sizeDelta, 9);
  assert.equal(report.stats.sizeDeltaPercent, 900);
  assert.deepEqual(report.growth.map((item) => [item.path, item.delta]), [["extra.js", 6], ["index.js", 3]]);
  assert.equal(report.findings.find((item) => item.type === "package-name-mismatch").severity, "warning");
  assert.equal(report.diff.changed.length, 1);
  assert.match(report.markdown, /软件包发布收据/);
  assert.match(report.markdown, /不等同于全面安全扫描/);
});

test("exported lifecycle commands redact common literal credentials", () => {
  const report = analyzer.analyze(archive({ scripts: { install: 'node setup.js --token do-not-share API_KEY=also-private --password="private pass"' } }));
  assert.doesNotMatch(JSON.stringify(report), /do-not-share|also-private|private pass/);
  assert.match(report.scripts.added[0].after, /已省略/);
});

test("generated Markdown cannot leak an unterminated private key in script metadata", () => {
  const report = analyzer.analyze(archive({ scripts: { prepare: "echo -----BEGIN PRIVATE KEY----- partial-private-material" } }));
  assert.doesNotMatch(JSON.stringify(report), /partial-private-material/);
  assert.match(report.scripts.added[0].after, /私钥内容已省略/);
});

test("script credentials are redacted before long metadata is truncated", () => {
  const credential = "x".repeat(3950) + " FAKE_PRIVATE_TAIL " + "z".repeat(100);
  const report = analyzer.analyze(archive({ scripts: {
    install: 'node setup.js --token="' + credential + '" --verbose',
    postinstall: "node setup.js --password '" + credential + "' --verbose",
    prepare: "curl https://demo:" + "p".repeat(4100) + "@example.invalid/",
  } }));
  assert.doesNotMatch(JSON.stringify(report), /FAKE_PRIVATE_TAIL|x{20}|p{20}|z{20}/);
  assert.equal(report.scripts.added.find((item) => item.name === "install").after, "node setup.js --token=[已省略] --verbose");
  assert.equal(report.scripts.added.find((item) => item.name === "postinstall").after, "node setup.js --password [已省略] --verbose");
  assert.equal(report.scripts.added.find((item) => item.name === "prepare").after, "curl https://[已省略]@example.invalid/");
});

test("quoted script credentials include escaped quotes and unterminated values", () => {
  const commands = [
    'node setup.js --token="fake\\" FAKE_PRIVATE_TAIL" --verbose',
    "node setup.js --password 'fake\\' FAKE_PRIVATE_TAIL' --verbose",
    'node setup.js API_KEY="fake FAKE_PRIVATE_TAIL',
    'node setup.js --secret "fake FAKE_PRIVATE_TAIL\\',
  ];
  for (const command of commands) {
    const report = analyzer.analyze(archive({ scripts: { install: command } }));
    assert.doesNotMatch(JSON.stringify(report), /fake|FAKE_PRIVATE_TAIL/);
    assert.match(report.scripts.added[0].after, /已省略/);
  }
});

test("control characters are normalized before script credential matching", () => {
  for (const separator of ["\u0000", "\u001b", "\u0085"]) {
    const report = analyzer.analyze(archive({ scripts: { install: "node app.js --token" + separator + "FAKE_PRIVATE_VALUE --verbose" } }));
    assert.doesNotMatch(JSON.stringify(report), /FAKE_PRIVATE_VALUE/);
    assert.equal(report.scripts.added[0].after, "node app.js --token [已省略] --verbose");
  }
});

test("full credential-name boundaries retain common assignments and long identifiers", () => {
  for (const argument of [
    "--token FAKE_PRIVATE_VALUE", "API_KEY=FAKE_PRIVATE_VALUE",
    "npm_config_registry_token=FAKE_PRIVATE_VALUE", "--client.secret=FAKE_PRIVATE_VALUE",
    "--client-secret FAKE_PRIVATE_VALUE", ".npm._auth=FAKE_PRIVATE_VALUE",
    "https://demo:FAKE_PRIVATE_VALUE@example.invalid/",
    "x.".repeat(1000) + "API_KEY=FAKE_PRIVATE_VALUE",
  ]) {
    const report = analyzer.analyze(archive({ scripts: { install: "node app.js " + argument + " --verbose" } }));
    assert.doesNotMatch(JSON.stringify(report), /FAKE_PRIVATE_VALUE/);
    assert.match(report.scripts.added[0].after, /已省略/);
    assert.match(report.scripts.added[0].after, /--verbose$/);
  }
  for (const text of ["x.".repeat(32768), "x-".repeat(32768), "token.".repeat(10923), "--" + "token.".repeat(10923)]) {
    const report = analyzer.analyze(archive({ scripts: { install: text } }));
    assert.equal(report.scripts.added[0].after, text.slice(0, 4000));
  }
});

test("ordinary arguments do not consume later or nested credential options", () => {
  for (const command of [
    "node app.js --ordinary --token FAKE_PRIVATE_VALUE",
    'WRAPPER="API_KEY=FAKE_PRIVATE_VALUE" node app.js',
    "node app.js --ordinary=value --password=FAKE_PRIVATE_VALUE",
  ]) {
    const report = analyzer.analyze(archive({ scripts: { install: command } }));
    assert.doesNotMatch(JSON.stringify(report), /FAKE_PRIVATE_VALUE/);
    assert.match(report.scripts.added[0].after, /已省略/);
  }
});
