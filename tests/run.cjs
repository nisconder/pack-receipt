"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const files = fs.readdirSync(__dirname).filter((name) => name.endsWith(".test.cjs")).sort().map((name) => path.join(__dirname, name));
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status === null ? 1 : result.status;
