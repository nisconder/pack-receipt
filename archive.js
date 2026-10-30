(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PackArchive = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MiB = 1024 * 1024;
  const LIMITS = Object.freeze({ inputBytes: 40 * MiB, unpackedBytes: 100 * MiB, entries: 10000, metadataBytes: MiB, manifestBytes: MiB, pathBytes: 4096 });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();

  class ArchiveError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "ArchiveError";
      this.code = code;
    }
  }

  function fail(code, message) { throw new ArchiveError(code, message); }

  async function readPackage(input, options) {
    options = options || {};
    const bytes = await inputBytes(input);
    const compressedSize = bytes.byteLength;
    const tar = bytes[0] === 0x1f && bytes[1] === 0x8b ? await gunzip(bytes) : bytes;
    if (tar.byteLength > LIMITS.unpackedBytes) fail("UNPACKED_LIMIT", "归档解压后超过 100 MiB，已停止读取。");
    return parseTar(tar, compressedSize);
  }

  async function inputBytes(input) {
    let value;
    if (input instanceof Uint8Array) value = input;
    else if (input instanceof ArrayBuffer) value = new Uint8Array(input);
    else if (ArrayBuffer.isView(input)) value = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    else if (input && typeof input.arrayBuffer === "function") {
      if (Number.isFinite(input.size) && input.size > LIMITS.inputBytes) fail("INPUT_LIMIT", "归档文件超过 40 MiB，请选择较小的软件包。");
      try { value = new Uint8Array(await input.arrayBuffer()); }
      catch { fail("INPUT_READ", "无法读取归档文件，请重新选择文件。"); }
    } else fail("INPUT_TYPE", "请选择 npm .tgz 或 .tar 文件，或提供归档字节。");
    if (value.byteLength > LIMITS.inputBytes) fail("INPUT_LIMIT", "归档文件超过 40 MiB，请选择较小的软件包。");
    if (!value.byteLength) fail("INPUT_EMPTY", "归档文件为空。");
    return value;
  }

  async function gunzip(bytes) {
    if (typeof DecompressionStream !== "function" || typeof ReadableStream !== "function") fail("GZIP_UNAVAILABLE", "当前浏览器不支持 gzip 解压，请使用新版浏览器，或选择未压缩的 .tar 文件。");
    let reader;
    const chunks = [];
    let size = 0;
    try {
      const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
      reader = stream.pipeThrough(new DecompressionStream("gzip")).getReader();
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > LIMITS.unpackedBytes) {
          try { await reader.cancel(); } catch (_) { /* Preserve the size-limit error. */ }
          fail("UNPACKED_LIMIT", "归档解压后超过 100 MiB，已停止读取。");
        }
        chunks.push(result.value);
      }
    } catch (error) {
      if (error instanceof ArchiveError) throw error;
      fail("GZIP_INVALID", "gzip 文件已损坏或不完整，无法解压。");
    } finally {
      if (reader) reader.releaseLock();
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }

  function parseTar(tar, compressedSize) {
    const entries = [];
    const warnings = [];
    const seen = new Set();
    let globalPax = Object.create(null);
    let localPax = Object.create(null);
    let longName = null;
    let longLink = null;
    let totalUnpacked = 0;
    let offset = 0;
    let headers = 0;
    let ended = false;

    while (offset < tar.byteLength) {
      if (offset + 512 > tar.byteLength) fail("TAR_TRUNCATED", "tar 文件尾部不完整，缺少完整的 512 字节区块。");
      const header = tar.subarray(offset, offset + 512);
      if (isZero(header)) {
        if (offset + 1024 > tar.byteLength || !isZero(tar.subarray(offset + 512, offset + 1024))) fail("TAR_TRUNCATED", "tar 文件缺少两个完整的结束区块。");
        if (!isZero(tar.subarray(offset + 1024))) fail("TAR_TRAILING_DATA", "tar 结束标记之后仍有非空数据，已拒绝读取。");
        ended = true;
        break;
      }
      headers += 1;
      if (headers > LIMITS.entries) fail("ENTRY_LIMIT", "归档条目超过 10000 项，已停止读取。");
      verifyChecksum(header);
      const flag = header[156] ? String.fromCharCode(header[156]) : "0";
      const metadata = ["x", "g", "L", "K"].includes(flag);
      const pax = mergePax(globalPax, localPax);
      const size = !metadata && Object.hasOwn(pax, "size") ? paxSize(pax.size) : tarNumber(header.subarray(124, 136), "文件大小");
      if (size > LIMITS.unpackedBytes) fail("UNPACKED_LIMIT", "归档声明的文件大小超过 100 MiB，已停止读取。");
      const bodyStart = offset + 512;
      const bodyEnd = bodyStart + size;
      const nextOffset = bodyStart + Math.ceil(size / 512) * 512;
      if (!Number.isSafeInteger(nextOffset) || bodyEnd > tar.byteLength || nextOffset > tar.byteLength) fail("TAR_TRUNCATED", "tar 文件内容或填充区块被截断。");
      const body = tar.subarray(bodyStart, bodyEnd);
      offset = nextOffset;

      if (metadata) {
        if (size > LIMITS.metadataBytes) fail("TAR_METADATA_LIMIT", "归档的扩展头超过 1 MiB，已停止读取。");
        if (flag === "g") globalPax = mergePax(globalPax, parsePax(body));
        else if (flag === "x") localPax = Object.assign(localPax, parsePax(body));
        else if (flag === "L") longName = fieldText(body);
        else longLink = fieldText(body);
        continue;
      }
      if (flag === "S" || Object.keys(pax).some((key) => /^(?:GNU\.sparse\.|SCHILY\.realsize)/.test(key))) fail("TAR_UNSUPPORTED", "此归档使用稀疏文件扩展，当前版本无法可靠读取。");
      const magic = fieldText(header.subarray(257, 263));
      const prefix = magic === "ustar" ? fieldText(header.subarray(345, 500)) : "";
      const headerName = (prefix ? prefix + "/" : "") + fieldText(header.subarray(0, 100));
      const rawPath = Object.hasOwn(pax, "path") ? pax.path : longName || headerName;
      const rawLink = Object.hasOwn(pax, "linkpath") ? pax.linkpath : longLink || fieldText(header.subarray(157, 257));
      const type = flag === "0" || flag === "7" ? "file" : flag === "5" ? "directory" : flag === "2" ? "symlink" : flag === "1" ? "hardlink" : "special";
      const path = safePath(rawPath, type === "directory");
      localPax = Object.create(null);
      longName = null;
      longLink = null;
      if (!path && type === "directory") continue;
      if (seen.has(path)) fail("DUPLICATE_PATH", "归档含有重复路径，无法确定最终发布内容：" + path);
      seen.add(path);
      if (type === "file") {
        totalUnpacked += size;
        if (totalUnpacked > LIMITS.unpackedBytes) fail("UNPACKED_LIMIT", "归档文件内容合计超过 100 MiB，已停止读取。");
      }
      const entry = { path, type, size, bytes: type === "file" ? body : new Uint8Array(0) };
      if (type === "symlink" || type === "hardlink") {
        entry.linkname = rawLink;
        warnings.push((type === "symlink" ? "符号链接" : "硬链接") + "仅作为元数据展示，不会跟随或读取目标：" + path);
        if (unsafeLink(rawLink)) warnings.push("链接目标可能越出软件包路径：" + path);
      } else if (type === "special") warnings.push("特殊文件仅作为元数据展示，不会创建或执行：" + path);
      entries.push(entry);
    }
    if (!ended) fail("TAR_TRUNCATED", "tar 文件缺少完整的结束标记。");
    if (Object.keys(localPax).length || longName !== null || longLink !== null) fail("TAR_TRUNCATED", "tar 扩展头之后缺少对应的文件条目。");
    const manifestEntry = entries.find((entry) => entry.path === "package.json");
    if (!manifestEntry) fail("MANIFEST_MISSING", "归档中没有找到根目录 package.json。");
    if (manifestEntry.type !== "file") fail("MANIFEST_INVALID", "package.json 必须是普通文件，不能是链接或特殊文件。");
    if (manifestEntry.size > LIMITS.manifestBytes) fail("MANIFEST_LIMIT", "package.json 超过 1 MiB，无法作为合理的软件包清单读取。");
    let manifest;
    try { manifest = JSON.parse(decoder.decode(manifestEntry.bytes)); }
    catch { fail("MANIFEST_INVALID", "package.json 不是有效的 UTF-8 JSON 文件。"); }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail("MANIFEST_INVALID", "package.json 必须是 JSON 对象。");
    if (typeof manifest.name !== "string" || manifest.name.length > 214 || !/^(?:@[a-zA-Z0-9][a-zA-Z0-9._~-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._~-]*$/.test(manifest.name)) fail("MANIFEST_INVALID", "package.json 缺少合理的 name 字段。");
    if (typeof manifest.version !== "string" || manifest.version.length > 128 || !/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(manifest.version)) fail("MANIFEST_INVALID", "package.json 缺少合理的 version 字段。");
    return { name: manifest.name, version: manifest.version, manifest, entries, compressedSize, totalUnpacked, warnings };
  }

  function tarNumber(bytes, label) {
    if (bytes[0] & 0x80) {
      // GNU base-256 uses the high bit as a format marker; negative sizes
      // and values beyond safe integer precision are never valid here.
      if (bytes[0] & 0x40) fail("TAR_NUMBER", "tar 的" + label + "不能为负数。");
      let value = bytes[0] & 0x3f;
      for (let index = 1; index < bytes.length; index += 1) {
        value = value * 256 + bytes[index];
        if (!Number.isSafeInteger(value)) fail("TAR_NUMBER", "tar 的" + label + "超出可安全读取的数值范围。");
      }
      return value;
    }
    const text = ascii(bytes).replace(/\0/g, " ").trim();
    if (!text) return 0;
    if (!/^[0-7]+$/.test(text)) fail("TAR_NUMBER", "tar 的" + label + "字段不是有效八进制数。");
    const value = parseInt(text, 8);
    if (!Number.isSafeInteger(value)) fail("TAR_NUMBER", "tar 的" + label + "超出可安全读取的数值范围。");
    return value;
  }

  function verifyChecksum(header) {
    const expected = tarNumber(header.subarray(148, 156), "校验和");
    let checksum = 0;
    for (let index = 0; index < header.length; index += 1) checksum += index >= 148 && index < 156 ? 32 : header[index];
    if (checksum !== expected) fail("TAR_CHECKSUM", "tar 文件头校验失败，归档可能已损坏。");
  }

  function parsePax(bytes) {
    const result = Object.create(null);
    let offset = 0;
    while (offset < bytes.length) {
      let separator = offset;
      while (separator < bytes.length && bytes[separator] !== 32) separator += 1;
      const lengthText = ascii(bytes.subarray(offset, separator));
      if (!/^\d+$/.test(lengthText)) fail("PAX_INVALID", "PAX 扩展头的记录长度无效。");
      const length = Number(lengthText);
      const end = offset + length;
      if (!Number.isSafeInteger(length) || length <= separator - offset + 2 || end > bytes.length || bytes[end - 1] !== 10) fail("PAX_INVALID", "PAX 扩展头的记录被截断或长度不匹配。");
      const record = utf8(bytes.subarray(separator + 1, end - 1));
      const equals = record.indexOf("=");
      if (equals < 1) fail("PAX_INVALID", "PAX 扩展头缺少字段名或等号。");
      result[record.slice(0, equals)] = record.slice(equals + 1);
      offset = end;
    }
    return result;
  }

  function mergePax(base, changes) {
    const result = Object.assign(Object.create(null), base);
    for (const key of Object.keys(changes)) {
      if (changes[key] === "") delete result[key];
      else result[key] = changes[key];
    }
    return result;
  }

  function paxSize(value) {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) fail("PAX_INVALID", "PAX 扩展头的文件大小无效。");
    return Number(value);
  }

  function safePath(value, isDirectory) {
    if (!value || encoder.encode(value).byteLength > LIMITS.pathBytes || /[\u0000-\u001f\u007f-\u009f\\:]/.test(value) || value.startsWith("/")) fail("UNSAFE_PATH", "归档包含不安全或过长的文件路径。");
    let parts = value.split("/").filter((part) => part !== "" && part !== ".");
    if (parts.some((part) => part === "..")) fail("UNSAFE_PATH", "归档路径包含父目录跳转（..），已拒绝读取。");
    if (parts[0] === "package") parts = parts.slice(1);
    if (!parts.length && !isDirectory) fail("UNSAFE_PATH", "归档的文件路径为空。");
    return parts.join("/");
  }

  function unsafeLink(value) {
    return !value || /[\u0000-\u001f\u007f-\u009f\\:]/.test(value) || value.startsWith("/") || value.split("/").includes("..");
  }

  function fieldText(bytes) {
    const nul = bytes.indexOf(0);
    return utf8(nul < 0 ? bytes : bytes.subarray(0, nul));
  }

  function utf8(bytes) {
    try { return decoder.decode(bytes); }
    catch { fail("TAR_ENCODING", "tar 文件名或扩展头不是有效 UTF-8 文本。"); }
  }

  function ascii(bytes) {
    let value = "";
    for (const byte of bytes) value += String.fromCharCode(byte);
    return value;
  }

  function isZero(bytes) {
    for (const byte of bytes) if (byte !== 0) return false;
    return true;
  }

  return Object.freeze({ readPackage, ArchiveError, LIMITS });
});
