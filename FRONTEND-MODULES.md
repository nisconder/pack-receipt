# 前端模块与交互说明

此文件记录前端模块接口。用户已选定数字收据视觉并恢复主页面合并；主页面在此基础上加入热敏打印机交互。打印表现由独立状态机控制，不修改分析结果，不重新解析或执行包代码。

## 文件与加载

| 文件 | 浏览器接口 | 用途 |
| --- | --- | --- |
| `diff.js` | `PackDiff` | 有界行级差异、UTF-8 文本预览 |
| `file-tools.js` | `PackFileTools` | 文件排序、目录聚合、Squarified 布局 |
| `processor.js` | `PackProcessor` | Worker 调度、取消、兼容回退 |
| `worker.js` | Worker 消息入口 | 在独立线程运行归档读取和分析 |
| `theme.js` | 页面主题控制 | 跟随系统、浅色、深色与偏好保存 |
| `enhancements.css` | 独立样式表 | Diff、排序、拖放、体积图和主题控件样式 |
| `receipt-skin.css` | 选定的票据皮肤 | 数字票据、账本数字、印章和深浅主题 |
| `receipt-ui.js` | 收据辅助界面 | 结构化收据标记和可访问的体积图提示 |
| `printer.js` / `printer.css` | `PackPrinter` / 热敏打印机 | 吐纸、盖章、撕下、重新打印与减少动态效果 |

保留零依赖与直接打开 HTML 的方式。`theme.js` 放在样式表之前，普通外部脚本即可；其他脚本按 `archive.js`、`analyzer.js`、`demo.js`、`diff.js`、`file-tools.js`、`processor.js`、`receipt-ui.js`、`printer.js`、`app.js` 顺序 `defer` 加载。样式依次为 `styles.css`、`enhancements.css`、`receipt-skin.css`、`printer.css`。

## 行级 Diff

```js
const before = PackDiff.readTextEntry(previousPackage, path);
const after = PackDiff.readTextEntry(currentPackage, path);
const result = PackDiff.diffLines(before.text, after.text);
```

`readTextEntry` 返回 `{kind, text, message, truncated}`。`kind` 为 `text`、`missing`、`unavailable`、`binary`、`link` 或 `special`。空文件是 `kind: 'text', text: ''`；非文本的 `text` 是 `null`，不能把提示文案当成文件内容参加比较。

`diffLines` 返回 `rows`、`added`、`removed`、`countsExact`、`before`、`after`，以及必要时的 `limited`、`truncated`、`message`。每行包含 `type: 'equal'|'add'|'remove'`、`text`、`eol`、`oldLine`、`newLine`，相邻替换区可含 `changed: true`。

- 行终止符单独保存在 `eol`：`\n`、`\r\n`、`\r` 或空串。渲染不得隐藏 CRLF/LF 和末尾换行变化。
- 预览默认每侧 64 KiB，UTF-8 不截断码点。比较硬上限为每侧 3000 行、3000 输出行、100 万 LCS 单元和 262144 字符；调用参数只能降低预算。
- 达到计算预算会明确返回非最小匹配的整块预览；达到显示预算会明确截断。不要把预览计数标成完整文件变化数量。
- 即使 `result.countsExact` 为真，只要任一输入的 `readTextEntry.truncated` 为真，计数仍然只是文件前缀的变化。
- 没有上一版时，显示本次内容即可，不应把所有行都称为“新增”。

## 文件排序和体积图

```js
const sorted = PackFileTools.sortFiles(rows, { key: 'delta', direction: 'desc' });
const level = PackFileTools.directoryItems(entries, 'dist/', false);
const rectangles = PackFileTools.squarify(level, width, height);
```

排序支持 `path`、`kind`、`size`、`delta`，不修改输入；变化顺序为新增、修改、删除、未变，差值按带符号数值排序。目录聚合只统计非空普通文件，排除链接和特殊条目；`flat: true` 返回该前缀下的文件。目录条目的 `path` 带尾部 `/`，可用于下钻。

布局返回原条目字段及 `x/y/width/height`，面积保留真实字节比例。建议每层最多展示 23 项及“其他”，以限制 SVG 数量，并为极小矩形提供图例或列表入口。尺寸比例悬殊时小文件仍然会很小，不能为了视觉均匀而改变面积含义。

## Worker 处理器

```js
const processor = PackProcessor.createProcessor();
try {
  const { current, previous, report, mode } = await processor.process(
    { current: currentFile, previous: previousFile || null },
    ({ stage, message }) => updateStatus(message),
  );
} catch (error) {
  if (error.name !== 'AbortError') showError(error.message);
}
// 清空或替换时：processor.cancel(); 最终释放时：processor.dispose();
```

新任务自动取消上一任务，旧任务返回 `AbortError`；Worker 会终止，迟到消息不会覆盖新结果。HTTP(S) 页面使用同源经典 Worker，启动握手失败会回退一次；已经开始读取后的归档错误不会被当成加载失败重复处理。

直接打开 `file://` 固定使用 `mode: 'main'` 兼容路径，并在读取和分析阶段之间让出事件循环；这不意味着逐个归档文件都在后台线程运行。此选择兼顾浏览器对 [file origin 的差异处理](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy#file_origins)。

Worker 的传输列表对共享 tar backing buffer 去重，保留各文件的 Uint8Array 视图。参见 [Transferable objects](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects)。

部署需允许 `worker-src 'self'` 并将脚本加入静态文件清单；Worker 脚本响应本身也应携带 CSP。`serve.cjs` 已加入新文件并为响应设置 CSP，维持 `connect-src 'none'`。参见 [Worker CSP](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers#content_security_policy)。

## 主题和样式接口

主题控件为 `#theme-select`，选项值是 `system/light/dark`；可选 `#theme-toggle` 依次循环三个选项。`document.documentElement.dataset.theme` 是解析后的 `light/dark`，`dataset.themePreference` 保留用户选择。系统偏好变化仅在 `system` 模式下生效。

主题变化在 `window` 派发 `pack-theme-change`，`detail` 为 `{preference, theme}`。只保存 `localStorage['pack-receipt.theme']`；读取或写入失败会降级，不存包数据。

独立样式使用以下接口：

- `.diff-table.split/.unified`、`.diff-line.equal/.add/.remove/.changed`、`.diff-number/.diff-sign/.diff-text`、`.diff-cell.empty`、`.diff-gap`、`.eol-marker`。
- `.sort-button`、`th[aria-sort]`、`.path-cell`、`.copy-path`。
- `#drop-overlay`、`.drop-overlay-grid`、`.overlay-drop-target[data-slot]`、`.is-over`。
- `.treemap-toolbar/.treemap-breadcrumb/.treemap-legend`，`--map-1` 至 `--map-10` 及 `--map-ink/--map-muted/--map-stroke`。
- `.manual-copy-content` 与 `.diff-notice/.diff-meta`。

## 验证与待整合部分

运行 `npm test`，测试入口 `tests/run.cjs` 自动枚举当前 `.test.cjs`，不依赖 shell 通配展开，不需要安装依赖。

本轮新增的模块测试覆盖：混合换行、重复行和双侧重建、有界大输入、UTF-8 截断、目录聚合、带符号排序、面积与几何不重叠、Worker 取消及失败回退、真实演示包处理与 UMD 加载。

页面已接入复制收据/摘要、路径复制、排序、键盘选项卡和快捷键、拖放、行级 Diff、下钻及打印状态机。后续改动应保留以下回归点：

1. 页面并发改动是否保留全部必需 ID，以及复制和主题事件是否被重复绑定。
2. 单包、添加/删除文件、二进制和截断预览的文案是否正确；`finalNewline: null` 应显示未知，不能显示为“无”。
3. 剪贴板成功/拒绝/手动复制回退，文件拖出窗口、取消和多文件错误。
4. ARIA Tab 键盘操作、排序 `aria-sort`、输入框内快捷键不截获正常输入。
5. `file://` 与 HTTP Worker 两种打开方式，以及浅色/深色/系统和窄屏布局。

之前的 `.qa/browser-result.json` 与 `design-preview/` 是较早界面的记录。主页面回归结果和截图单独保存在 `.qa/main-browser-result.json` 与 `.qa/main-*.png`。

## 打印事件与状态

`app.js` 在 `window` 派发 `pack:analysis-start/complete/error/reset`。事件的 `detail.id` 使用单调递增的分析编号，完成事件仅包含包名、版本、错误/复核数量和真实分析完成时间，不包含归档字节或配置内容。

`PackPrinter` 接收事件，按 `idle → analyzing → feeding → stamping → ready` 推进；撕下为 `tearing → detached`，重新打印只重播表现，不重复业务分析。旧编号、重复完成和清空后的迟到事件会被忽略。

只有有限的表现阶段会暂时设置 `#report-content.inert`，结束、取消、错误、后台或减少动态效果时都会释放。`#receipt[aria-busy]` 表示归档分析本身；外层 `#receipt-printer[aria-busy]` 还包含纸张表现阶段。LED旁有文本状态，不只依赖颜色表达含义。
