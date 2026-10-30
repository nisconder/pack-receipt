"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const root = __dirname;
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
const allowed = new Set(["index.html", "styles.css", "enhancements.css", "receipt-skin.css", "printer.css", "printer.js", "receipt-ui.js", "archive.js", "analyzer.js", "demo.js", "diff.js", "file-tools.js", "processor.js", "worker.js", "theme.js", "app.js", "icon.svg"]);
const csp = "default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const server = http.createServer((req, res) => {
  let file;
  try { file = decodeURIComponent(new URL(req.url, "http://localhost").pathname).slice(1) || "index.html"; }
  catch { res.writeHead(400).end(); return; }
  if (!allowed.has(file)) { res.writeHead(404).end("Not found"); return; }
  fs.readFile(path.join(root, file), (error, data) => {
    if (error) { res.writeHead(404).end("Not found"); return; }
    res.writeHead(200, { "Content-Type": types[path.extname(file)], "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": csp });
    res.end(req.method === "HEAD" ? undefined : data);
  });
});
server.listen(0, "127.0.0.1", () => process.stdout.write(`Pack Receipt: http://127.0.0.1:${server.address().port}\n`));
