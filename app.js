(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const state = { files: { current: null, previous: null }, packages: {}, report: null, demo: false, generation: 0, tab: "findings", fileLimit: 200, sort: { key: "kind", direction: "asc" }, mapPath: "", diffView: "split", inspection: null };
  const severityNames = { error: "需要修复", warning: "需要复核", info: "信息提示" };
  const kindNames = { added: "新增", changed: "修改", removed: "删除", unchanged: "未变" };
  const processor = PackProcessor.createProcessor();
  const feedbackTimers = new WeakMap();
  let allRows = [];

  function announce(type, detail) {
    window.dispatchEvent(new CustomEvent(`pack:analysis-${type}`, { detail }));
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function size(value) {
    if (!Number.isFinite(value)) return "—";
    const abs = Math.abs(value);
    if (abs < 1024) return `${Math.round(abs).toLocaleString("zh-CN")} B`;
    if (abs < 1024 ** 2) return `${(abs / 1024).toFixed(abs < 10240 ? 1 : 0)} KiB`;
    return `${(abs / 1024 ** 2).toFixed(1)} MiB`;
  }

  function deltaSize(value) { return value === 0 ? "0 B" : `${value > 0 ? "+" : "−"}${size(value)}`; }

  function status(message, error = false) {
    $("status").textContent = message;
    $("status").classList.toggle("error", error);
  }

  function busy(value) {
    $("receipt").setAttribute("aria-busy", String(value));
    $("load-demo").disabled = value;
    $("export-markdown").disabled = value || !state.report;
    $("export-json").disabled = value || !state.report;
    $("copy-markdown").disabled = value || !state.report;
    $("copy-summary").disabled = value || !state.report;
  }

  function updateSlots() {
    for (const slot of ["current", "previous"]) {
      const file = state.files[slot];
      $(`${slot}-name`).textContent = file ? file.name : slot === "current" ? "拖入本次安装包" : "拖入上一版安装包";
      $(`${slot}-detail`).textContent = file ? `${size(file.size)} · 点击可替换` : slot === "current" ? "或点击选择文件" : "用于比较文件和脚本的变化";
    }
  }

  function clearReport() {
    if ($("file-dialog").open) $("file-dialog").close();
    if ($("copy-dialog").open) $("copy-dialog").close();
    state.inspection = null;
    state.report = null;
    state.packages = {};
    allRows = [];
    $("report-content").hidden = true;
    $("empty-state").hidden = false;
  }

  async function processFiles() {
    const generation = ++state.generation;
    clearReport();
    updateSlots();
    if (!state.files.current) {
      processor.cancel();
      announce("reset", { id: generation });
      busy(false);
      status(state.files.previous ? "上一版已就绪，请再选择本次安装包。" : "选择本次安装包，或载入问题样本。", false);
      return;
    }
    busy(true);
    announce("start", { id: generation });
    status("正在读取文件并检查安装包…");
    try {
      const result = await processor.process({ current: state.files.current, previous: state.files.previous }, (progress) => {
        if (generation === state.generation) status(progress.message);
      });
      const { current, previous, report, mode } = result;
      if (generation !== state.generation) return;
      state.packages = { current, previous };
      state.report = report;
      $("receipt").dataset.processingMode = mode;
      state.fileLimit = 200;
      state.mapPath = "";
      state.sort = { key: previous ? "kind" : "path", direction: "asc" };
      $("file-search").value = "";
      $("file-filter").value = "all";
      $("severity-filter").value = "all";
      renderReport();
      announce("complete", {
        id: generation,
        name: report.package.name,
        version: report.package.version,
        errors: report.findings.filter((finding) => finding.severity === "error").length,
        warnings: report.findings.filter((finding) => finding.severity === "warning").length,
        completedAt: new Date().toISOString(),
      });
      status(state.demo ? "当前为虚构演示包。选择你自己的文件即可替换。" : previous ? "已完成两版比较。文件未上传，包内脚本未执行。" : "已完成本次包检查。添加上一版可查看变化。");
    } catch (error) {
      if (generation !== state.generation) return;
      if (error.name === "AbortError") return;
      clearReport();
      status(error.message || "无法读取文件，请选择 npm pack 生成的安装包。", true);
      announce("error", { id: generation, message: error.message || "无法读取安装包。" });
    } finally {
      if (generation === state.generation) busy(false);
    }
  }

  async function loadDemo() {
    const generation = ++state.generation;
    processor.cancel();
    busy(true);
    announce("start", { id: generation });
    status("正在生成两版本地演示包…");
    try {
      const files = await PackDemo.getDemoFiles();
      if (generation !== state.generation) return;
      state.files = files;
      state.demo = true;
      await processFiles();
    } catch (error) {
      if (generation !== state.generation) return;
      clearReport();
      status(`无法生成样本：${error.message}`, true);
      announce("error", { id: generation, message: "无法生成样本。" });
      busy(false);
    }
  }

  function chooseFile(slot, file) {
    if (!file) return;
    if (state.demo) {
      state.files = { current: null, previous: null };
      state.demo = false;
    }
    state.files[slot] = file;
    processFiles();
  }

  function renderReport() {
    const report = state.report;
    $("empty-state").hidden = true;
    $("report-content").hidden = false;
    $("demo-tag").hidden = !state.demo;
    $("package-name").textContent = report.package.name;
    $("package-version").textContent = report.stats.previous
      ? `${report.package.previousVersion} → ${report.package.version}`
      : `${report.package.version} · 单包检查，未提供上一版`;

    const errors = report.findings.filter((finding) => finding.severity === "error").length;
    const warnings = report.findings.filter((finding) => finding.severity === "warning").length;
    const summary = $("summary");
    summary.className = `receipt-summary${errors ? "" : warnings ? " review" : " clear"}`;
    summary.replaceChildren(
      element("strong", "", errors ? `${errors} 项需要修复` : warnings ? `${warnings} 项需要复核` : "未发现需要修复或复核的项目"),
      document.createTextNode(errors && warnings ? `，另有 ${warnings} 项需要复核。` : "。"),
      element("span", "summary-secondary", "下面列出具体文件和原因。未发现问题不代表软件包安全或一定能运行。"),
    );

    const stats = $("stats");
    stats.replaceChildren();
    const { current, previous, sizeDelta, sizeDeltaPercent } = report.stats;
    const items = [
      ["解包后体积", size(current.unpackedSize), "包内文件内容合计"],
      ["安装包大小", size(current.compressedSize), "实际导入文件大小"],
      ["文件条目", String(current.fileCount), "不含文件夹"],
      ["较上一版", previous ? deltaSize(sizeDelta) : "—", previous ? (Number.isFinite(sizeDeltaPercent) ? `${sizeDeltaPercent > 0 ? "+" : ""}${sizeDeltaPercent.toFixed(1)}% · 解包后` : "上一版为零字节") : "添加上一版后比较"],
    ];
    for (const [label, value, caption] of items) {
      const group = element("div");
      const data = element("dd", "", value);
      data.append(element("small", "", caption));
      group.append(element("dt", "", label), data);
      stats.append(group);
    }

    $("findings-count").textContent = String(report.findings.length);
    allRows = Object.entries(report.diff).flatMap(([kind, rows]) => rows.map((row) => ({ ...row, kind })));
    $("files-count").textContent = String(allRows.length);
    $("scripts-count").textContent = String(Object.values(report.scripts).reduce((count, rows) => count + rows.length, 0));
    $("file-filter").querySelector('[value="added"]').textContent = previous ? "新增" : "当前文件";
    renderFindings();
    renderFiles();
    renderScripts();
    selectTab(state.tab);
    renderTreemap();
    renderGrowth();
  }

  function renderFindings() {
    if (!state.report) return;
    const filter = $("severity-filter").value;
    const findings = state.report.findings.filter((finding) => filter === "all" || finding.severity === filter);
    const holder = $("findings");
    holder.replaceChildren();
    if (!findings.length) {
      holder.append(element("p", "quiet-empty", filter === "all" ? "这些规则未发现问题。仍建议在干净环境中实际安装和运行。" : "没有这一类结果。"));
      return;
    }
    for (const finding of findings) {
      const item = element("article", `finding ${finding.severity}`);
      const icon = element("span", "finding-icon", finding.severity === "info" ? "i" : "!");
      icon.setAttribute("aria-hidden", "true");
      const body = element("div");
      const heading = element("h4", "finding-title");
      heading.append(element("span", "", finding.title), element("span", "severity-word", severityNames[finding.severity] || finding.severity));
      body.append(heading);
      if (finding.path) body.append(element("code", "finding-path", finding.path));
      if (finding.detail) body.append(element("p", "finding-detail", finding.detail));
      if (finding.evidence && finding.evidence.length) {
        const details = element("details");
        details.append(element("summary", "", "查看依据"));
        const list = element("ul");
        for (const line of finding.evidence) list.append(element("li", "", line));
        details.append(list);
        body.append(details);
      }
      item.append(icon, body);
      holder.append(item);
    }
  }

  function renderFiles() {
    if (!state.report) return;
    const filter = $("file-filter").value;
    const search = $("file-search").value.trim().toLocaleLowerCase();
    const rows = PackFileTools.sortFiles(allRows.filter((row) => (filter === "all" || filter === row.kind) && (!search || row.path.toLocaleLowerCase().includes(search))), state.sort);
    const holder = $("file-rows");
    holder.replaceChildren();
    const hasBaseline = Boolean(state.report.stats.previous);
    for (const button of document.querySelectorAll("button.sort-button")) {
      const active = button.dataset.sort === state.sort.key;
      const direction = state.sort.direction;
      const th = button.closest("th");
      if (active) th.setAttribute("aria-sort", direction === "asc" ? "ascending" : "descending");
      else th.removeAttribute("aria-sort");
      button.querySelector("span").textContent = active ? direction === "asc" ? "↑" : "↓" : "↕";
      button.disabled = !hasBaseline && ["kind", "delta"].includes(button.dataset.sort);
    }
    $("file-result-count").textContent = `${rows.length.toLocaleString("zh-CN")} 个文件${hasBaseline ? " · 点击路径查看两版内容" : " · 未提供上一版，列出本次文件"}`;
    if (!rows.length) {
      const tr = element("tr");
      const td = element("td", "quiet-empty", "没有匹配的文件。");
      td.colSpan = 4;
      tr.append(td);
      holder.append(tr);
    }
    for (const row of rows.slice(0, state.fileLimit)) {
      const tr = element("tr");
      const pathCell = element("td");
      const pathGroup = element("div", "path-cell");
      const button = element("button", "file-link", row.path);
      button.type = "button";
      button.addEventListener("click", () => inspectFile(row.path));
      const copy = element("button", "copy-path", "⧉");
      copy.type = "button";
      copy.setAttribute("aria-label", `复制文件路径：${row.path}`);
      copy.title = "复制文件路径";
      copy.addEventListener("click", () => copyText(row.path, copy));
      pathGroup.append(button, copy);
      pathCell.append(pathGroup);
      const kind = element("td");
      kind.append(element("span", `diff-kind ${hasBaseline ? row.kind : ""}`, hasBaseline ? kindNames[row.kind] : "当前文件"));
      const value = element("td", "", row.kind === "removed" ? "—" : size(row.size));
      const delta = element("td", row.delta > 0 ? "delta-positive" : row.delta < 0 ? "delta-negative" : "muted", hasBaseline ? deltaSize(row.delta) : "—");
      tr.append(pathCell, kind, value, delta);
      holder.append(tr);
    }
    $("more-files").hidden = rows.length <= state.fileLimit;
    $("more-files").textContent = `显示更多文件（已显示 ${Math.min(state.fileLimit, rows.length)} / ${rows.length}）`;
  }

  function renderScripts() {
    const holder = $("scripts");
    holder.replaceChildren();
    const scripts = state.report.scripts;
    let count = 0;
    for (const kind of ["added", "changed", "removed", "unchanged"]) {
      for (const script of scripts[kind]) {
        count++;
        const item = element("article", "script-item");
        const heading = element("h3", "script-heading");
        heading.append(element("span", "", script.name), element("span", `diff-kind ${state.report.stats.previous ? kind : ""}`, state.report.stats.previous ? kindNames[kind] : "本次包内"));
        item.append(heading);
        if (script.before !== null && script.before !== undefined && kind !== "unchanged") {
          item.append(element("p", "script-caption", "上一版"), element("pre", "", String(script.before)));
        }
        if (script.after !== null && script.after !== undefined) {
          item.append(element("p", "script-caption", "本次发布"), element("pre", "", String(script.after)));
        }
        holder.append(item);
      }
    }
    if (!count) holder.append(element("p", "quiet-empty", "package.json 中没有 scripts。"));
  }

  function selectTab(tab, focus = false) {
    state.tab = tab;
    for (const button of document.querySelectorAll(".report-tab")) {
      const selected = button.dataset.tab === tab;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      $(`${button.dataset.tab}-panel`).hidden = !selected;
    }
    if (tab === "findings" && state.report) renderTreemap();
    if (focus) $(`${tab}-tab`).focus();
  }

  function renderGrowth() {
    const holder = $("growth");
    holder.replaceChildren();
    if (!state.report.stats.previous) return;
    const growth = state.report.growth.filter((row) => row.delta > 0).slice(0, 3);
    for (const file of growth) {
      const row = element("div", "growth-item");
      row.append(element("span", "", file.path), element("span", "", deltaSize(file.delta)));
      holder.append(row);
    }
    if (!growth.length) holder.append(element("p", "quiet-empty", "本次没有文件体积增长。"));
  }

  function svgNode(tag, attributes, text) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attributes || {})) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderTreemap() {
    if (!state.report) return;
    const holder = $("treemap");
    if (holder.clientWidth === 0) return;
    holder.replaceChildren();
    const flat = $("treemap-mode").value === "files";
    const prefix = flat ? "" : state.mapPath;
    const files = PackFileTools.directoryItems(state.packages.current.entries, prefix, flat);
    const breadcrumb = $("treemap-breadcrumb");
    breadcrumb.replaceChildren();
    const crumb = (label, path) => {
      const button = element("button", "text-button", label);
      button.type = "button";
      button.addEventListener("click", () => { state.mapPath = path; renderTreemap(); });
      breadcrumb.append(button);
    };
    crumb("整个包", "");
    let cumulative = "";
    for (const segment of prefix.split("/").filter(Boolean)) {
      cumulative += segment + "/";
      breadcrumb.append(element("span", "", "/"));
      crumb(segment, cumulative);
    }
    $("size-caption").textContent = "面积对应解包后字节数";
    const legend = $("treemap-legend");
    legend.replaceChildren();
    if (!files.length) { holder.append(element("p", "quiet-empty", "这个目录没有非空普通文件。")); return; }
    const blocks = files.slice(0, 23);
    if (files.length > 23) blocks.push({ path: "", label: `其余 ${files.length - 23} 项`, size: files.slice(23).reduce((sum, file) => sum + file.size, 0), other: true });
    const width = Math.max(holder.clientWidth, 240);
    const height = holder.clientHeight || 188;
    const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, role: "group", "aria-label": "文件体积图：目录可下钻，文件可预览；小矩形也可从下方列表访问" });
    for (const [index, item] of PackFileTools.squarify(blocks, width, height).entries()) {
      const { x, y, width: w, height: h } = item;
      const action = () => {
        if (item.other) { selectTab("files"); $("file-search").value = prefix; $("file-filter").value = "all"; renderFiles(); $("file-search").focus(); }
        else if (item.directory) { state.mapPath = item.path; renderTreemap(); }
        else inspectFile(item.path);
      };
      const label = `${item.label}，${size(item.size)}，${item.other ? "查看文件清单" : item.directory ? "打开目录" : "查看内容"}`;
      const group = svgNode("g", { role: "button", tabindex: "0", "aria-label": label });
      group.append(svgNode("title", {}, label));
      group.append(svgNode("rect", { x, y, width: Math.max(0, w), height: Math.max(0, h), fill: `var(--map-${index % 10 + 1})` }));
      if (w > 65 && h > 38) {
        const maxChars = Math.max(3, Math.floor((w - 20) / 7));
        group.append(svgNode("text", { x: x + 10, y: y + 22 }, item.label.length > maxChars ? item.label.slice(0, maxChars - 1) + "…" : item.label));
        if (h > 55) group.append(svgNode("text", { x: x + 10, y: y + 40, class: "map-size" }, size(item.size)));
      }
      group.addEventListener("click", action);
      group.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); action(); } });
      svg.append(group);
      const legendButton = element("button", "text-button", `${item.label} · ${size(item.size)}`);
      legendButton.type = "button";
      legendButton.title = label;
      legendButton.addEventListener("click", action);
      legend.append(legendButton);
    }
    holder.append(svg);
  }

  function inspectFile(path) {
    if (!state.report) return;
    $("file-dialog-title").textContent = path;
    const before = PackDiff.readTextEntry(state.packages.previous, path);
    const after = PackDiff.readTextEntry(state.packages.current, path);
    const comparable = [before, after].every((entry) => ["text", "missing"].includes(entry.kind));
    const single = !state.packages.previous && after.kind === "text";
    state.inspection = { before, after, single, comparable: comparable || single };
    if (comparable || single) state.inspection.diff = PackDiff.diffLines(single ? after.text : before.text || "", after.text || "");
    renderInspection();
    $("file-dialog").showModal();
  }

  function contextualRows(rows) {
    if (!$("diff-changes-only").checked || !rows.some((row) => row.type !== "equal")) return rows;
    const visible = new Set();
    for (let i = 0; i < rows.length; i++) if (rows[i].type !== "equal") {
      for (let j = Math.max(0, i - 3); j < Math.min(rows.length, i + 4); j++) visible.add(j);
    }
    const result = [];
    let omitted = 0;
    for (let i = 0; i < rows.length; i++) {
      if (!visible.has(i)) omitted++;
      else { if (omitted) result.push({ type: "gap", count: omitted }); omitted = 0; result.push(rows[i]); }
    }
    if (omitted) result.push({ type: "gap", count: omitted });
    return result;
  }

  function renderInspection() {
    const inspection = state.inspection;
    if (!inspection) return;
    const { before, after, comparable, single, diff } = inspection;
    const notices = [];
    $("metadata-preview").hidden = comparable;
    $("diff-output").hidden = !comparable;
    $("diff-toolbar").hidden = !comparable;
    if (!comparable) {
      $("previous-preview").textContent = before.kind === "text" ? before.text || "（空文件）" : before.message;
      $("current-preview").textContent = after.kind === "text" ? after.text || "（空文件）" : after.message;
      $("diff-notice").textContent = "此文件无法作双侧文本对比，以下仅展示可读取的内容或元数据。";
      return;
    }
    if (single) notices.push("未提供上一版，以下显示本次文件内容，不作为新增行统计。");
    else {
      if (before.kind === "missing") notices.push("上一版没有此文件。");
      if (after.kind === "missing") notices.push("本次包没有此文件。");
    }
    if (before.truncated || after.truncated) notices.push("文件超过 64 KiB，只比较文本前缀；计数不是完整文件的变化数量。");
    if (diff.message) notices.push(diff.message);
    const endingName = (info) => info?.complete === false ? `${info.lineEnding}（预览）` : info?.lineEnding || "none";
    const finalNewline = (info) => info?.finalNewline === null ? "未知（预览已截断）" : info?.finalNewline ? "有" : "无";
    const beforeInfo = diff.before && { ...diff.before, complete: !before.truncated && diff.before.complete, finalNewline: before.truncated ? null : diff.before.finalNewline };
    const afterInfo = diff.after && { ...diff.after, complete: !after.truncated && diff.after.complete, finalNewline: after.truncated ? null : diff.after.finalNewline };
    if (beforeInfo && afterInfo && !single) notices.push(`换行：${endingName(beforeInfo)} → ${endingName(afterInfo)}；末尾换行：${finalNewline(beforeInfo)} → ${finalNewline(afterInfo)}。`);
    $("diff-notice").textContent = notices.join(" ");
    $("diff-summary").textContent = single ? "本次文本预览" : `${before.truncated || after.truncated || !diff.countsExact ? "预览 " : ""}+${diff.added} / −${diff.removed}`;
    const view = single ? "unified" : state.diffView;
    for (const button of document.querySelectorAll("[data-diff-view]")) { button.disabled = single; button.setAttribute("aria-pressed", String(button.dataset.diffView === view)); }
    $("diff-changes-only").disabled = single;
    const table = element("table", `diff-table ${view}`);
    const head = element("thead");
    const header = element("tr");
    for (const label of view === "split" ? ["旧行", "", "上一版", "新行", "", "本次发布"] : [single ? "" : "旧行", "新行", "", "文本内容"]) {
      const th = element("th", "", label); th.scope = "col"; header.append(th);
    }
    head.append(header);
    const body = element("tbody");
    const rows = single ? diff.rows : contextualRows(diff.rows);
    const eolChanged = !single && diff.before && (diff.before.lineEnding !== diff.after.lineEnding || diff.before.finalNewline !== diff.after.finalNewline || diff.rows.some((row) => row.changed));
    const content = (row, className = "") => {
      const cell = element("td", `diff-text diff-cell ${className}`, row ? row.text : "");
      if (row && eolChanged && row.type !== "equal") cell.append(element("span", "eol-marker", ` ⟪${row.eol === "\r\n" ? "CRLF" : row.eol === "\n" ? "LF" : row.eol === "\r" ? "CR" : "无换行"}⟫`));
      return cell;
    };
    const gap = (row) => { const tr = element("tr", "diff-gap"); const td = element("td", "", `省略 ${row.count} 行相同内容`); td.colSpan = view === "split" ? 6 : 4; tr.append(td); body.append(tr); };
    if (view === "unified") {
      for (const row of rows) {
        if (row.type === "gap") { gap(row); continue; }
        const kind = single ? "equal" : row.type;
        const tr = element("tr", `diff-line ${kind}${row.changed ? " changed" : ""}`);
        tr.append(element("td", "diff-number", single ? "" : row.oldLine ?? ""), element("td", "diff-number", row.newLine ?? ""), element("td", "diff-sign", kind === "add" ? "+" : kind === "remove" ? "−" : ""), content(row));
        body.append(tr);
      }
    } else {
      const splitRow = (left, right) => {
        const paired = left && right && left.type !== "equal";
        const kind = paired ? "changed" : left?.type === "equal" ? "equal" : left ? "remove" : "add";
        const tr = element("tr", `diff-line ${kind}`);
        for (const [row, old] of [[left, true], [right, false]]) {
          const cls = row ? paired ? "changed" : row.type : "empty";
          tr.append(element("td", `diff-number diff-cell ${cls}`, row ? old ? row.oldLine ?? "" : row.newLine ?? "" : ""), element("td", `diff-sign diff-cell ${cls}`, row && row.type !== "equal" ? old ? "−" : "+" : ""), content(row, cls));
        }
        body.append(tr);
      };
      for (let i = 0; i < rows.length;) {
        const row = rows[i];
        if (row.type === "gap") { gap(row); i++; }
        else if (row.type === "equal") { splitRow(row, row); i++; }
        else {
          const removed = [], added = [];
          while (i < rows.length && !["equal", "gap"].includes(rows[i].type)) { (rows[i].type === "remove" ? removed : added).push(rows[i++]); }
          for (let j = 0; j < Math.max(removed.length, added.length); j++) splitRow(removed[j], added[j]);
        }
      }
    }
    table.append(head, body);
    $("diff-output").replaceChildren(rows.length ? table : element("p", "quiet-empty", "（空文件，没有可显示的文本行。）"));
  }

  function markdownText() {
    return (state.demo ? "> 内置演示数据，非真实发布包。\n\n" : "") + state.report.markdown;
  }

  function summaryText() {
    const report = state.report;
    const counts = { error: 0, warning: 0, info: 0 };
    for (const finding of report.findings) counts[finding.severity]++;
    return [state.demo ? "【内置演示数据】" : "软件包发布摘要", `${report.package.name}@${report.package.version}`, report.hasBaseline ? `对照：${report.package.previousVersion}；解包体积变化 ${deltaSize(report.stats.sizeDelta)}` : "单包检查，未提供上一版", `本次：${report.stats.current.fileCount} 个文件条目，解包后 ${size(report.stats.current.unpackedSize)}`, `需要修复 ${counts.error} 项 · 需要复核 ${counts.warning} 项 · 信息 ${counts.info} 项`, "仅检查包内内容与声明，不构成安全或运行保证。"].join("\n");
  }

  async function copyText(text, button) {
    const active = document.activeElement;
    let copied = false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch (_) { /* Keep file:// and restricted clipboard contexts usable. */ }
    if (!copied) {
      const staging = element("textarea");
      staging.value = text;
      staging.readOnly = true;
      staging.style.cssText = "position:fixed;left:-10000px;top:0;opacity:0";
      document.body.append(staging);
      staging.select();
      try { copied = document.execCommand("copy"); } catch (_) { copied = false; }
      staging.remove();
      if (active?.isConnected) active.focus({ preventScroll: true });
    }
    if (!copied) {
      $("copy-content").value = text;
      if (!$("copy-dialog").open) $("copy-dialog").showModal();
      $("copy-content").focus();
      $("copy-content").select();
      status("请在复制窗口中按 Ctrl+C 或 ⌘C。没有写入剪贴板。");
      return;
    }
    const label = button.querySelector("span") || button;
    if (feedbackTimers.has(button)) clearTimeout(feedbackTimers.get(button).timer);
    const previous = feedbackTimers.get(button)?.text || label.textContent;
    label.textContent = button.classList.contains("copy-path") ? "✓" : "✓ 已复制";
    feedbackTimers.set(button, { text: previous, timer: setTimeout(() => { if (button.isConnected) label.textContent = previous; feedbackTimers.delete(button); }, 1500) });
    status("已复制到剪贴板。");
  }

  function download(text, mime, suffix) {
    if (!state.report) return;
    const packageName = state.report.package.name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+/, "") || "package";
    const version = String(state.report.package.version).replace(/[^a-zA-Z0-9._-]+/g, "-");
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const anchor = element("a");
    anchor.href = url;
    anchor.download = `${packageName}-${version}-receipt${state.demo ? "-demo" : ""}.${suffix}`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status(`已导出${state.demo ? "演示" : "发布"}收据。`);
  }

  // Retain the existing header icons and search markup while adding accessible controls.
  const summaryButton = element("button", "button small", "复制摘要");
  summaryButton.id = "copy-summary";
  summaryButton.type = "button";
  $("copy-markdown").after(summaryButton);
  $("files-panel").setAttribute("role", "tabpanel");
  $("files-panel").setAttribute("aria-labelledby", "files-tab");
  $("files-panel").tabIndex = 0;
  $("file-search").setAttribute("aria-keyshortcuts", "/");
  for (const th of document.querySelectorAll(".file-table th[data-sort]")) {
    const text = th.firstChild.textContent.trim();
    const button = element("button", "sort-button");
    button.type = "button";
    button.dataset.sort = th.dataset.sort;
    button.append(document.createTextNode(text + " "), element("span", "sort-badge", "↕"));
    button.querySelector("span").setAttribute("aria-hidden", "true");
    button.addEventListener("click", () => {
      const key = button.dataset.sort;
      state.sort = { key, direction: state.sort.key === key ? state.sort.direction === "asc" ? "desc" : "asc" : ["size", "delta"].includes(key) ? "desc" : "asc" };
      state.fileLimit = 200;
      renderFiles();
    });
    th.replaceChildren(button);
    th.scope = "col";
  }

  function hideDropOverlay() {
    $("drop-overlay").hidden = true;
    for (const target of document.querySelectorAll(".overlay-drop-target")) target.classList.remove("is-over");
  }

  function fileDrag(event) { return [...(event.dataTransfer?.types || [])].includes("Files"); }

  for (const slot of ["current", "previous"]) {
    $(`${slot}-file`).addEventListener("change", (event) => {
      chooseFile(slot, event.target.files[0]);
      event.target.value = "";
    });
    const zone = $(`${slot}-drop`);
    zone.addEventListener("dragover", (event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; zone.classList.add("drag-over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
    zone.addEventListener("drop", (event) => { event.preventDefault(); zone.classList.remove("drag-over"); hideDropOverlay(); const files = event.dataTransfer.files; if (files.length > 1) { status("每个区域一次选择一个安装包。", true); return; } chooseFile(slot, files[0]); });
  }
  document.addEventListener("dragenter", (event) => {
    if (!fileDrag(event) || $("file-dialog").open || $("copy-dialog").open) return;
    event.preventDefault();
    $("drop-overlay").hidden = false;
  });
  document.addEventListener("dragover", (event) => {
    if (!fileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    const target = event.target.closest?.(".overlay-drop-target");
    for (const item of document.querySelectorAll(".overlay-drop-target")) item.classList.toggle("is-over", item === target);
  });
  document.addEventListener("dragleave", (event) => {
    if (event.relatedTarget === null && (event.clientX <= 0 || event.clientY <= 0 || event.clientX >= innerWidth || event.clientY >= innerHeight)) hideDropOverlay();
  });
  document.addEventListener("drop", (event) => {
    if (!fileDrag(event)) return;
    event.preventDefault();
    const target = event.target.closest?.(".overlay-drop-target");
    hideDropOverlay();
    if (!target) return;
    const files = event.dataTransfer.files;
    if (files.length !== 1) { status("每个位置一次放入一个安装包。", true); return; }
    chooseFile(target.dataset.slot, files[0]);
  });
  for (const target of document.querySelectorAll(".overlay-drop-target")) target.addEventListener("click", () => { hideDropOverlay(); $(`${target.dataset.slot}-file`).click(); });
  window.addEventListener("dragend", hideDropOverlay);
  window.addEventListener("blur", hideDropOverlay);
  $("load-demo").addEventListener("click", loadDemo);
  $("reset").addEventListener("click", () => { state.generation++; processor.cancel(); state.files = { current: null, previous: null }; state.demo = false; state.fileLimit = 200; updateSlots(); clearReport(); announce("reset", { id: state.generation }); busy(false); hideDropOverlay(); status("选择本次安装包，或载入问题样本。"); });
  const tabs = [...document.querySelectorAll(".report-tab")];
  for (const button of tabs) {
    button.addEventListener("click", () => selectTab(button.dataset.tab));
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = tabs.indexOf(button);
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      selectTab(tabs[next].dataset.tab, true);
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { hideDropOverlay(); return; }
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || !state.report || $("report-content").inert || $("file-dialog").open || $("copy-dialog").open) return;
    const target = event.target;
    if (target.isContentEditable || target.closest?.("input,textarea,select,[contenteditable='true']")) return;
    if (event.key === "/") { event.preventDefault(); selectTab("files"); $("file-search").focus(); }
    else if (["1", "2", "3"].includes(event.key)) { event.preventDefault(); selectTab(tabs[Number(event.key) - 1].dataset.tab, true); }
  });
  $("severity-filter").addEventListener("change", renderFindings);
  $("file-filter").addEventListener("change", () => { state.fileLimit = 200; renderFiles(); });
  $("file-search").addEventListener("input", () => { state.fileLimit = 200; renderFiles(); });
  $("more-files").addEventListener("click", () => { state.fileLimit += 200; renderFiles(); });
  $("close-dialog").addEventListener("click", () => $("file-dialog").close());
  $("close-copy-dialog").addEventListener("click", () => $("copy-dialog").close());
  for (const button of document.querySelectorAll("[data-diff-view]")) button.addEventListener("click", () => { state.diffView = button.dataset.diffView; renderInspection(); });
  $("diff-changes-only").addEventListener("change", renderInspection);
  $("treemap-mode").addEventListener("change", () => { state.mapPath = ""; renderTreemap(); });
  window.addEventListener("pack-theme-change", renderTreemap);
  window.addEventListener("pagehide", () => processor.cancel());
  $("file-dialog").addEventListener("click", (event) => { if (event.target === $("file-dialog")) { const bounds = event.target.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.target.close(); } });
  $("copy-markdown").addEventListener("click", () => { if (state.report) copyText(markdownText(), $("copy-markdown")); });
  $("copy-summary").addEventListener("click", () => { if (state.report) copyText(summaryText(), $("copy-summary")); });
  $("export-markdown").addEventListener("click", () => { if (state.report) download(markdownText(), "text/markdown;charset=utf-8", "md"); });
  $("export-json").addEventListener("click", () => { if (state.report) download(JSON.stringify({ schemaVersion: 1, demo: state.demo, ...state.report }, null, 2), "application/json;charset=utf-8", "json"); });
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => { if (state.tab === "findings") renderTreemap(); }).observe($("treemap"));
  else window.addEventListener("resize", renderTreemap);
  loadDemo();
})();
