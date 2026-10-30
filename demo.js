(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PackDemo = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  const encoder = new TextEncoder();
  const demoName = "@demo/note-kit";

  async function getDemoFiles() {
    const entries = getDemoEntries();
    const [current, previous] = await Promise.all([
      archiveFile("note-kit-0.8.0", entries.current),
      archiveFile("note-kit-0.7.0", entries.previous),
    ]);
    return { current, previous };
  }

  function getDemoEntries() {
    const previousManifest = {
      name: demoName,
      version: "0.7.0",
      private: true,
      description: "Fictional package fixture for Pack Receipt; not published.",
      type: "module",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
      bin: { "note-kit": "dist/cli.js" },
      files: ["dist", "README.md", "LICENSE"],
      license: "MIT",
    };
    const currentManifest = {
      ...previousManifest,
      version: "0.8.0",
      files: ["dist", "scripts", "fixtures", ".env", "README.md", "LICENSE"],
      scripts: { preinstall: "node scripts/preinstall.cjs" },
    };
    const license = "MIT License\n\nCopyright (c) 2026 Fictional Pack Receipt Demo\n\nThis text is sample package content, not an actual published dependency.\n";
    const docs = (version) => `# Fictional note-kit ${version}\n\nThis is an offline sample package for Pack Receipt. It is not published.\nAll credentials in this archive are conspicuously fake and unusable.\n`;
    const implementation = (flavor) => [
      `export const flavor = "${flavor}";`,
      "export function formatNote(value) { return String(value).trim(); }",
      "//# sourceMappingURL=index.js.map",
      "",
    ].join("\n");
    const sourceMap = (flavor) => json({
      version: 3,
      file: "index.js",
      sources: ["../src/index.ts"],
      sourcesContent: [`export const flavor = "${flavor}";\nexport function formatNote(value: string) { return value.trim(); }\n`],
      names: [],
      mappings: "AAAA;AACA",
    });
    const file = (path, content, mode = 0o644) => ({ path: `package/${path}`, content, mode });
    const common = [
      file("LICENSE", license),
      file("dist/index.d.ts", "export declare const flavor: string;\nexport declare function formatNote(value: string): string;\n"),
    ];
    const previous = [
      file("package.json", json(previousManifest)),
      file("README.md", docs("0.7.0")),
      ...common,
      file("dist/index.js", implementation("classic")),
      file("dist/index.js.map", sourceMap("classic")),
      file("dist/cli.js", "#!/usr/bin/env node\nconsole.log('Fictional note-kit demo CLI');\n", 0o755),
      file("dist/legacy.js", "export const legacyFormatter = (value) => String(value);\n"),
    ];
    const current = [
      file("package.json", json(currentManifest)),
      file("README.md", docs("0.8.0")),
      ...common,
      // "classic" and "modern!" have the same byte length. A size-only diff
      // misses this implementation change; comparing the bytes catches it.
      file("dist/index.js", implementation("modern!")),
      file("dist/index.js.map", sourceMap("modern!")),
      file(".env", [
        "# OFFLINE DEMO ONLY: every value below is fake and cannot authenticate.",
        "DEMO_API_TOKEN=FAKE_NOT_A_VALID_TOKEN_FOR_PACK_RECEIPT",
        "DEMO_PASSWORD=FAKE_NOT_A_REAL_PASSWORD",
        "",
      ].join("\n")),
      file("scripts/preinstall.cjs", [
        "// Offline fixture. Pack Receipt must inspect this file without executing it.",
        "// This deliberately inert script exists only to demonstrate lifecycle metadata.",
        "console.log('FAKE note-kit preinstall fixture: no work performed');",
        "",
      ].join("\n")),
      file("fixtures/sample-notes.csv", fixtureNotes()),
      // dist/cli.js is intentionally missing even though bin still points at it.
      // dist/legacy.js was deliberately removed in this version as well.
    ];
    return { current, previous };
  }

  function fixtureNotes() {
    const rows = ["id,title,body,reference"];
    for (let index = 1; index <= 480; index += 1) {
      const id = String(index).padStart(4, "0");
      const reference = ((index * 2654435761) >>> 0).toString(16).padStart(8, "0");
      rows.push(`${id},Demo note ${id},Synthetic fixture content for package size comparison; no real user data,FAKE-${reference}`);
    }
    return `${rows.join("\n")}\n`;
  }

  async function archiveFile(baseName, entries) {
    const tar = createTar(entries);
    let bytes = tar;
    let suffix = ".tar";
    let type = "application/x-tar";
    // CompressionStream is built into modern Chrome, Edge, Firefox and Node.
    // If it is absent, a real raw tar remains usable by the local parser.
    if (typeof CompressionStream === "function") {
      const stream = new Blob([tar]).stream().pipeThrough(new CompressionStream("gzip"));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      suffix = ".tgz";
      type = "application/gzip";
    }
    if (typeof File === "function") return new File([bytes], `${baseName}${suffix}`, { type, lastModified: Date.UTC(2026, 0, 1) });
    const blob = new Blob([bytes], { type });
    Object.defineProperties(blob, {
      name: { value: `${baseName}${suffix}`, enumerable: true },
      lastModified: { value: Date.UTC(2026, 0, 1), enumerable: true },
    });
    return blob;
  }

  // Minimal deterministic POSIX ustar writer. Entries are ordinary files,
  // never symlinks or executable commands. It produces actual archive bytes
  // so the demo travels through the same parser as a user-selected package.
  function createTar(entries) {
    const chunks = [];
    let total = 1024;
    for (const entry of entries) {
      const body = typeof entry.content === "string" ? encoder.encode(entry.content) : new Uint8Array(entry.content);
      const header = new Uint8Array(512);
      putText(header, 0, 100, entry.path);
      putOctal(header, 100, 8, entry.mode ?? 0o644);
      putOctal(header, 108, 8, 0);
      putOctal(header, 116, 8, 0);
      putOctal(header, 124, 12, body.byteLength);
      putOctal(header, 136, 12, 1767225600);
      header.fill(32, 148, 156);
      header[156] = 48;
      putText(header, 257, 6, "ustar");
      putText(header, 263, 2, "00");
      putText(header, 265, 32, "demo");
      putText(header, 297, 32, "demo");
      const checksum = header.reduce((sum, value) => sum + value, 0);
      putText(header, 148, 8, checksum.toString(8).padStart(6, "0") + "\0 ");
      const padding = new Uint8Array((512 - body.byteLength % 512) % 512);
      chunks.push(header, body, padding);
      total += 512 + body.byteLength + padding.byteLength;
    }
    const archive = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      archive.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return archive;
  }

  function putText(target, offset, length, value) {
    const bytes = encoder.encode(String(value));
    if (bytes.byteLength > length) throw new Error("Demo archive field is too long.");
    target.set(bytes, offset);
  }

  function putOctal(target, offset, length, value) {
    putText(target, offset, length, Math.floor(value).toString(8).padStart(length - 1, "0") + "\0");
  }

  function json(value) {
    return JSON.stringify(value, null, 2) + "\n";
  }

  return { getDemoFiles, getDemoEntries, createTar };
});
