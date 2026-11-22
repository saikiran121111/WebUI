"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// D:/Projects/WebUI/WebUI/app/api/files/extract/route.ts
var route_exports = {};
__export(route_exports, {
  POST: () => POST,
  dynamic: () => dynamic,
  revalidate: () => revalidate,
  runtime: () => runtime
});
module.exports = __toCommonJS(route_exports);
var import_server = require("next/server");

// D:/Projects/WebUI/WebUI/lib/server/extract/index.ts
var import_node_fs10 = __toESM(require("node:fs"));
var import_node_path12 = __toESM(require("node:path"));

// D:/Projects/WebUI/WebUI/lib/files/extensions.ts
var EXT_CATEGORY = {
  // text / code / markup / config
  txt: "text",
  csv: "text",
  tsv: "text",
  md: "text",
  json: "text",
  jsonl: "text",
  xml: "text",
  html: "text",
  htm: "text",
  yaml: "text",
  yml: "text",
  toml: "text",
  ini: "text",
  log: "text",
  py: "text",
  js: "text",
  jsx: "text",
  ts: "text",
  tsx: "text",
  java: "text",
  c: "text",
  cpp: "text",
  cc: "text",
  h: "text",
  hpp: "text",
  cs: "text",
  go: "text",
  rs: "text",
  php: "text",
  rb: "text",
  swift: "text",
  kt: "text",
  kts: "text",
  scala: "text",
  sh: "text",
  bash: "text",
  zsh: "text",
  ps1: "text",
  bat: "text",
  cmd: "text",
  sql: "text",
  r: "text",
  m: "text",
  tex: "text",
  bib: "text",
  diff: "text",
  patch: "text",
  env: "text",
  conf: "text",
  cfg: "text",
  properties: "text",
  graphql: "text",
  gql: "text",
  proto: "text",
  dockerfile: "text",
  makefile: "text",
  tf: "text",
  hcl: "text",
  vue: "text",
  svelte: "text",
  astro: "text",
  svg: "text",
  // images
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  tif: "image",
  tiff: "image",
  heic: "image",
  heif: "image",
  avif: "image",
  ico: "image",
  // audio
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  aac: "audio",
  ogg: "audio",
  flac: "audio",
  // video
  mp4: "video",
  mpeg: "video",
  mpg: "video",
  mov: "video",
  avi: "video",
  mkv: "video",
  webm: "video",
  "3gp": "video",
  // archives
  zip: "archive",
  tar: "archive",
  gz: "archive",
  tgz: "archive",
  bz2: "archive",
  xz: "archive",
  "7z": "archive",
  rar: "archive",
  // office / document containers
  docx: "office",
  xlsx: "office",
  xlsm: "office",
  pptx: "office",
  odt: "office",
  ods: "office",
  odp: "office",
  epub: "office",
  pdf: "pdf",
  rtf: "rtf",
  ipynb: "notebook",
  // legacy binary formats — strings recovery
  doc: "legacy",
  xls: "legacy",
  ppt: "legacy",
  mat: "legacy"
};
var NAME_CATEGORY = {
  dockerfile: "text",
  makefile: "text",
  ".env": "text"
};
function fileExtension(name) {
  const i = name.lastIndexOf(".");
  if (i < 0) return "";
  if (i === 0) return "";
  return name.slice(i + 1).toLowerCase();
}
function classifyFile(name, mime) {
  const ext = fileExtension(name);
  if (ext && EXT_CATEGORY[ext]) return EXT_CATEGORY[ext];
  const base = name.toLowerCase();
  if (NAME_CATEGORY[base]) return NAME_CATEGORY[base];
  if (mime) {
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("audio/")) return "audio";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("text/")) return "text";
    if (mime === "application/pdf") return "pdf";
    if (mime === "application/json") return "text";
    if (mime === "application/xml" || mime.endsWith("+xml")) return "text";
    if (mime === "application/zip" || mime === "application/x-tar" || mime === "application/gzip" || mime === "application/x-7z-compressed" || mime === "application/vnd.rar") return "archive";
    if (mime.includes("officedocument") || mime.includes("opendocument") || mime === "application/epub+zip") return "office";
  }
  return "unknown";
}
var TEXT_CHAR_LIMIT = 48e3;
function sizeLimitLabel(bytes) {
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb % 1 ? gb.toFixed(1) : Math.round(gb)} GB`;
}
var ACCEPT_EXTENSIONS = Object.keys(EXT_CATEGORY).map((e) => "." + e).join(",") + ",Dockerfile,Makefile";

// D:/Projects/WebUI/WebUI/lib/server/extract/zip.ts
var import_fflate = require("fflate");
var CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(data) {
  let c = 4294967295;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 255] ^ c >>> 8;
  return (c ^ 4294967295) >>> 0;
}
var MAX_MEMBER_INFLATED_BYTES = 256 * 1024 * 1024;
function centralDirectoryCrcs(buf) {
  const MIN_EOCD = 22;
  if (buf.length < MIN_EOCD) return null;
  const scanFrom = Math.max(0, buf.length - (MIN_EOCD + 65535));
  let eocd = -1;
  for (let i = buf.length - MIN_EOCD; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === 101010256) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  const map = /* @__PURE__ */ new Map();
  if (count === 65535 || cdOffset === 4294967295) {
    if (eocd - 20 < 0 || buf.readUInt32LE(eocd - 20) !== 134630224) return null;
    const eocd64Pos = Number(buf.readBigUInt64LE(eocd - 20 + 8));
    if (eocd64Pos + 56 > buf.length || buf.readUInt32LE(eocd64Pos) !== 117853008) return null;
    count = Number(buf.readBigUInt64LE(eocd64Pos + 32));
    cdOffset = Number(buf.readBigUInt64LE(eocd64Pos + 48));
  }
  let pos = cdOffset;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 33639248) return map.size ? map : null;
    const crc = buf.readUInt32LE(pos + 16);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const cmtLen = buf.readUInt16LE(pos + 32);
    const name = buf.toString("utf8", pos + 46, pos + 46 + nameLen);
    map.set(name, crc >>> 0);
    pos += 46 + nameLen + extraLen + cmtLen;
  }
  return map;
}
function readZipDetailed(buf, limits = {}) {
  const perMember = limits.perMemberBytes ?? MAX_MEMBER_INFLATED_BYTES;
  const view = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let dict;
  try {
    dict = limits.include ? (0, import_fflate.unzipSync)(view, { filter: (f) => limits.include(f.name) }) : (0, import_fflate.unzipSync)(view);
  } catch (err) {
    throw new Error(
      "Not a readable ZIP file: " + (err?.message || String(err))
    );
  }
  const crcs = centralDirectoryCrcs(buf);
  const entries = [];
  const dropped = [];
  const corrupt = [];
  for (const [name, data] of Object.entries(dict)) {
    if (name.endsWith("/")) continue;
    if (data.length > perMember) {
      dropped.push({ name, bytes: data.length });
      continue;
    }
    let flag;
    const expected = crcs?.get(name);
    if (expected !== void 0 && crc32(data) >>> 0 !== expected) {
      flag = "checksum mismatch";
      corrupt.push(name);
    }
    entries.push({
      name,
      data: Buffer.from(data.buffer, data.byteOffset, data.byteLength),
      ...flag ? { corrupt: flag } : {}
    });
  }
  const names = crcs ? [...crcs.keys()] : Object.keys(dict);
  return { entries, dropped, corrupt, names };
}
function readZip(buf) {
  return readZipDetailed(buf).entries;
}

// D:/Projects/WebUI/WebUI/lib/server/extract/office.ts
var NAMED_ENTITIES = {
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  amp: "&",
  nbsp: "\xA0"
};
function codePointEntity(cp, literal) {
  if (!Number.isFinite(cp) || cp < 0 || cp > 1114111 || cp >= 55296 && cp <= 57343) {
    return literal;
  }
  return String.fromCodePoint(cp);
}
function decodeEnt(s) {
  return s.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g, (all, dec, hex, name) => {
    if (dec !== void 0) return codePointEntity(Number(dec), all);
    if (hex !== void 0) return codePointEntity(parseInt(hex, 16), all);
    return NAMED_ENTITIES[name] ?? all;
  });
}
function xmlToText(xml) {
  return decodeEnt(
    xml.replace(/<w:tab[^>]*\/>/g, "	").replace(/<a:br\s*\/>|<w:br\s*\/>/g, "\n").replace(/<\/w:p>|<\/a:p>|<\/text:p>|<\/text:h>|<\/html:br>/g, "\n").replace(/<[^>]+>/g, "")
  ).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function sharedStrings(xml) {
  const out = [];
  const siRe = /<si>([\s\S]*?)<\/si>|<si\/>/g;
  let m;
  while ((m = siRe.exec(xml)) !== null) {
    const inner = m[1] ?? "";
    out.push(
      [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeEnt(t[1])).join("")
    );
  }
  return out;
}
function worksheetText(xml, shared) {
  const lines = [];
  const rowRe = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm;
  while ((rm = rowRe.exec(xml)) !== null) {
    const body = rm[1] ?? "";
    const cells = [];
    const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cRe.exec(body)) !== null) {
      const attrs = cm[1] || "";
      const inner = cm[2] ?? "";
      const ref = /r="([A-Za-z]+\d+)"/.exec(attrs)?.[1] ?? "?";
      const t = /t="([^"]+)"/.exec(attrs)?.[1] ?? "n";
      let val = "";
      if (t === "s") {
        const raw = (/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "").trim();
        const idx = parseInt(raw, 10);
        val = Number.isFinite(idx) && shared[idx] !== void 0 ? shared[idx] : `(shared string #${raw || "?"} missing)`;
      } else if (t === "inlineStr") {
        val = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeEnt(x[1])).join("");
      } else {
        const f = /<f\b([^>]*?)?(?:\/>|>([\s\S]*?)<\/f>)/.exec(inner);
        const fAttrs = f?.[1] ?? "";
        const fText = (f?.[2] ?? "").trim();
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        const cached = v !== void 0 ? decodeEnt(v.trim()) : void 0;
        if (fText) {
          val = "=" + decodeEnt(fText);
          if (cached !== void 0 && cached !== "") val += ` (cached ${cached})`;
          if (/t="(shared|array)"/.test(fAttrs)) val += " [shared/array formula]";
        } else if (f) {
          val = cached !== void 0 ? `${cached} [formula continuation; expression not stored in this cell]` : "[formula present but neither expression nor cached value stored]";
        } else if (cached !== void 0) {
          val = cached;
        }
        if (t === "b") val = val === "1" ? "TRUE" : "FALSE";
      }
      if (val !== "") {
        const flat = val.replace(/\s+/g, " ");
        cells.push(`${ref}=${flat}`);
      }
    }
    if (cells.length) lines.push(cells.join("	"));
  }
  return lines.join("\n");
}
function relTargets(partDir, relsDir, target) {
  const norm = (base) => {
    const path14 = target.startsWith("/") ? target.slice(1) : base + target;
    const out = [];
    for (const seg of path14.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") out.pop();
      else out.push(seg.replace(/%20/g, " "));
    }
    return out.join("/");
  };
  const a = norm(partDir), b = norm(relsDir);
  return a === b ? [a] : [a, b];
}
function sheetOrder(entries, str2) {
  const wb = entries.find((e) => e.name === "xl/workbook.xml");
  if (!wb) return null;
  const rels = entries.find((e) => e.name === "xl/_rels/workbook.xml.rels");
  const relMap = /* @__PURE__ */ new Map();
  if (rels) {
    for (const rm of str2(rels).matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
      const id = /Id="([^"]+)"/.exec(rm[1])?.[1];
      const target = /Target="([^"]+)"/.exec(rm[1])?.[1];
      if (!id || !target) continue;
      relMap.set(id, relTargets("xl/", "xl/_rels/", target));
    }
  }
  const order = [];
  for (const sm of str2(wb).matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const name = /name="([^"]*)"/.exec(sm[1])?.[1];
    const rid = /r:id="([^"]+)"/.exec(sm[1])?.[1];
    if (!name || !rid) continue;
    const cands = relMap.get(rid);
    if (!cands) continue;
    const path14 = cands.find((c) => entries.some((e) => e.name === c)) ?? cands[0];
    order.push({ path: path14, name: decodeEnt(name) });
  }
  return order.length ? order : null;
}
function slideOrder(entries, str2) {
  const pres = entries.find((e) => e.name === "ppt/presentation.xml");
  const rels = entries.find((e) => e.name === "ppt/_rels/presentation.xml.rels");
  const slides = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name));
  if (!pres || !rels || !slides.length) return null;
  const relMap = /* @__PURE__ */ new Map();
  for (const rm of str2(rels).matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const id = /Id="([^"]+)"/.exec(rm[1])?.[1];
    const target = /Target="([^"]+)"/.exec(rm[1])?.[1];
    if (!id || !target) continue;
    relMap.set(id, relTargets("ppt/", "ppt/_rels/", target));
  }
  const lst = /<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/.exec(str2(pres))?.[1] ?? "";
  const ordered = [];
  const used = /* @__PURE__ */ new Set();
  for (const sm of lst.matchAll(/<p:sldId\b([^>]*?)\/?>/g)) {
    const rid = /r:id="([^"]+)"/.exec(sm[1])?.[1];
    let e;
    for (const c of rid ? relMap.get(rid) ?? [] : []) {
      e = slides.find((s) => s.name === c);
      if (e) break;
    }
    if (e && !used.has(e.name)) {
      ordered.push(e);
      used.add(e.name);
    }
  }
  const rest = slides.filter((s) => !used.has(s.name)).sort((a, b) => parseInt(/\d+/.exec(a.name)?.[0] ?? "0", 10) - parseInt(/\d+/.exec(b.name)?.[0] ?? "0", 10));
  return ordered.length ? [...ordered, ...rest] : null;
}
function integrityNote(corrupt) {
  if (!corrupt.length) return "";
  return `[integrity: ${corrupt.length} package part(s) failed their stored CRC checksum and were skipped: ${corrupt.join(", ")}]`;
}
var XLSX_INCLUDE = (name) => /^xl\/(sharedStrings|workbook)\.xml$/.test(name) || /^xl\/_rels\/workbook\.xml\.rels$/.test(name) || /^xl\/worksheets\/sheet\d+\.xml$/.test(name) || /^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/.test(name) || /^xl\/charts\/chart\d+\.xml$/.test(name);
function sheetStructure(xml, relsXml) {
  const notes = [];
  const merged = [...xml.matchAll(/<mergeCell\b[^>]*ref="([^"]+)"/g)].map((m) => m[1]);
  if (merged.length) {
    notes.push(`### merged cells (${merged.length}): ${merged.slice(0, 40).join(", ")}` + (merged.length > 40 ? ` +${merged.length - 40} more` : "") + " - a merged block carries ONE value; the other cells in it are blank, not zero");
  }
  const links = [];
  for (const m of xml.matchAll(/<hyperlink\b([^>]*?)\/?>/g)) {
    const ref = /ref="([^"]+)"/.exec(m[1])?.[1];
    const ext = /r:id="([^"]+)"/.exec(m[1])?.[1];
    const loc = /location="([^"]+)"/.exec(m[1])?.[1];
    if (!ref) continue;
    if (ext && relsXml) {
      const rel = new RegExp(`Id="${ext}"[^>]*Target="([^"]+)"`).exec(relsXml)?.[1];
      if (rel) links.push(`${ref} -> ${decodeEnt(rel)}`);
      continue;
    }
    if (loc) links.push(`${ref} -> internal ${loc}`);
  }
  if (links.length) {
    notes.push(`### hyperlinks (${links.length}): ${links.slice(0, 25).join("; ")}` + (links.length > 25 ? ` +${links.length - 25} more` : ""));
  }
  return notes;
}
function officeText(buf, ext) {
  const limits = ext === "xlsx" || ext === "xlsm" ? { include: XLSX_INCLUDE } : ext === "pptx" ? { include: (n) => /^ppt\/(presentation\.xml|slides\/slide\d+\.xml)$/.test(n) || n === "ppt/_rels/presentation.xml.rels" } : ext === "docx" ? { include: (n) => /^word\/((document|footnotes|endnotes)\.xml|(header|footer)\d*\.xml)$/.test(n) } : ext === "epub" ? { include: (n) => /\.(xhtml|html)$/.test(n) } : ext === "odt" || ext === "ods" || ext === "odp" ? { include: (n) => n === "content.xml" } : {};
  const zip = readZipDetailed(buf, limits);
  const entries = zip.entries;
  const find = (re) => entries.filter((e) => re.test(e.name));
  const str2 = (e) => e.data.toString("utf8");
  const good = (e) => !e.corrupt;
  switch (ext) {
    case "docx": {
      const parts = [
        ...entries.filter((e) => /^word\/(document|footnotes|endnotes)\.xml$/.test(e.name) && good(e)),
        ...find(/^word\/(header|footer)\d*\.xml$/).filter(good)
      ];
      const body = parts.map((e) => xmlToText(str2(e))).filter(Boolean).join("\n\n");
      const note = integrityNote(zip.corrupt);
      return [note, body].filter(Boolean).join("\n\n");
    }
    case "xlsx":
    case "xlsm": {
      const out = [];
      const sharedEntry = entries.find((e) => e.name === "xl/sharedStrings.xml" && good(e));
      const shared = sharedEntry ? sharedStrings(str2(sharedEntry)) : [];
      const order = sheetOrder(entries.filter(good), str2);
      let sheets;
      if (order) {
        sheets = order.map((o) => {
          const e = entries.find((x) => x.name === o.path && good(x));
          return e ? { e, name: o.name } : null;
        }).filter((x) => !!x);
        for (const o of order) {
          if (!entries.some((x) => x.name === o.path)) {
            out.push(`### worksheet: ${o.name} \u2014 part ${o.path} is missing from the package`);
          }
        }
      } else {
        sheets = find(/^xl\/worksheets\/sheet\d+\.xml$/).filter(good).sort((a, b) => parseInt(/(\d+)/.exec(a.name)?.[1] ?? "0", 10) - parseInt(/(\d+)/.exec(b.name)?.[1] ?? "0", 10)).map((e) => ({ e, name: "" }));
      }
      for (const { e, name } of sheets) {
        const body = worksheetText(str2(e), shared);
        const sheetRels = entries.find((x) => x.name === e.name.replace(/^(xl\/worksheets\/)/, "$1_rels/") + ".rels" && good(x));
        const structure = sheetStructure(str2(e), sheetRels ? str2(sheetRels) : void 0);
        const head = name ? `### worksheet: ${name}` : "";
        const tail = [head, ...structure].filter(Boolean).join("\n");
        if (name) out.push([tail, body].filter(Boolean).join("\n").trim());
        else out.push([body, ...structure].filter(Boolean).join("\n"));
      }
      const labels = [];
      for (const e of find(/^xl\/charts\/chart\d+\.xml$/).filter(good).sort((a, b) => a.name.localeCompare(b.name))) {
        const xml = str2(e);
        const title = /<c:title>[\s\S]*?<a:t>([^<]*)<\/a:t>/.exec(xml)?.[1]?.trim();
        const cached = /<c:(?:num|string)Cache/.test(xml);
        labels.push(
          `Chart${title ? ` "${title}"` : ""} (${e.name}): ` + (cached ? "native chart; the file caches its series values (not expanded here)" : "chart with NO cached data \u2014 only its picture exists for a text reader; do not infer values from it")
        );
      }
      const media = zip.names.filter((n) => /^xl\/media\/[^/]+$/.test(n));
      if (media.length) {
        labels.push(
          `${media.length} embedded image(s) in xl/media: image-only visuals (photos OR pictures of charts \u2014 not distinguishable from metadata); there is NO readable data behind them`
        );
      }
      if (labels.length) out.push(labels.join("\n"));
      const note = integrityNote(zip.corrupt);
      if (note) out.unshift(note);
      return out.filter(Boolean).join("\n\n");
    }
    case "pptx": {
      const ordered = slideOrder(entries.filter(good), str2);
      const slides = ordered ?? find(/^ppt\/slides\/slide\d+\.xml$/).filter(good).sort((a, b) => parseInt(/(\d+)/.exec(a.name)?.[1] ?? "0", 10) - parseInt(/(\d+)/.exec(b.name)?.[1] ?? "0", 10));
      const body = slides.map((e) => xmlToText(str2(e))).filter(Boolean).join("\n\n");
      const note = integrityNote(zip.corrupt);
      return [note, body].filter(Boolean).join("\n\n");
    }
    case "odt":
    case "ods":
    case "odp": {
      const content = entries.find((e) => e.name === "content.xml" && good(e));
      const body = content ? xmlToText(str2(content)) : "";
      const note = integrityNote(zip.corrupt);
      return [note, body].filter(Boolean).join("\n\n");
    }
    case "epub": {
      const pages = find(/\.(xhtml|html)$/).filter(good).sort((a, b) => a.name.localeCompare(b.name));
      const body = pages.map((e) => xmlToText(str2(e))).filter(Boolean).join("\n\n");
      const note = integrityNote(zip.corrupt);
      return [note, body].filter(Boolean).join("\n\n");
    }
    default:
      return "";
  }
}

// D:/Projects/WebUI/WebUI/lib/server/extract/rtf.ts
var LBRACE = "\uF1CB";
var RBRACE = "\uF1CD";
var BACKSLASH = "\uF1CC";
function rtfToText(rtf) {
  return rtf.replace(/\\([{}\\])/g, (_, c) => c === "{" ? LBRACE : c === "}" ? RBRACE : BACKSLASH).replace(/\\'([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\u(-?\d{1,5})\s?\??/g, (_, d) => {
    let n = parseInt(d, 10);
    if (n < 0) n += 65536;
    return n >= 0 && n <= 65535 ? String.fromCharCode(n) : " ";
  }).replace(/\\par[d]?|\\line|\\sect/g, "\n").replace(/\\tab/g, "	").replace(/\\cell|\\row|\\nestcell|\\nestrow/g, "\n").replace(/\\pict[\s\S]*?(?={|\\par)/g, " ").replace(/\\[a-zA-Z]{1,32}-?\d{0,10} ?/g, "").replace(/\\'[0-9a-fA-F]{2}/g, "").replace(/[{}]/g, "").split(LBRACE).join("{").split(RBRACE).join("}").split(BACKSLASH).join("\\").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// D:/Projects/WebUI/WebUI/lib/server/extract/notebook.ts
var MAX_OUTPUT_CHARS = 2e4;
function joinSource(src) {
  if (Array.isArray(src)) return src.map((s) => String(s)).join("");
  return String(src ?? "");
}
function joinMultiline(v) {
  if (v == null) return null;
  const one = (x) => x !== null && typeof x === "object" ? JSON.stringify(x) : String(x);
  const s = Array.isArray(v) ? v.map(one).join("") : one(v);
  return s.length ? s : null;
}
function renderDataBundle(data, label, meta) {
  const out = [];
  const exec = meta?.execution;
  if (exec?.execution_count != null) out.push(`${label} [cell ${exec.execution_count}]:`);
  else out.push(`${label}:`);
  for (const [mime, raw] of Object.entries(data)) {
    const text = joinMultiline(raw);
    if (text == null) continue;
    if (mime === "text/plain" || mime === "text/markdown") {
      out.push(text);
    } else if (mime === "application/json") {
      out.push(`[JSON output]
${text}`);
    } else if (mime === "text/html") {
      const stripped = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&[a-z]+;/gi, " ").replace(/[ \t]+\n/g, "\n").trim();
      out.push(`[HTML output \u2014 markup removed]
${stripped}`);
    } else if (mime === "image/svg+xml") {
      out.push(`[SVG image output \u2014 vector markup, ${text.length} chars \u2014 not rendered here]`);
    } else if (mime.startsWith("image/") || mime.startsWith("application/pdf") || mime.startsWith("audio/") || mime.startsWith("video/")) {
      out.push(`[${mime} output: ${text.length} chars of base64 \u2014 binary, not readable as text]`);
    } else if (mime.startsWith("text/") || mime === "application/javascript") {
      out.push(`[${mime} output]
${text}`);
    } else {
      out.push(`[${mime} output skipped \u2014 no text rendering for this MIME]`);
    }
  }
  return out;
}
function renderOutput(o) {
  const kind = String(o?.output_type ?? "");
  const blocks = [];
  if (kind === "stream") {
    const t = joinMultiline(o.text);
    if (t) blocks.push(`--- output (${o.name === "stderr" ? "stderr" : "stdout"}) ---
${capBlock(t)}`);
  } else if (kind === "error") {
    const ename = String(o.ename ?? "Error");
    const evalue = String(o.evalue ?? "");
    const tb = Array.isArray(o.traceback) ? o.traceback.join("\n") : "";
    blocks.push(`--- output (error: ${ename}: ${evalue}) ---
${capBlock(tb)}`);
  } else if (kind === "execute_result" || kind === "display_data") {
    const data = o.data && typeof o.data === "object" ? o.data : {};
    const rendered = renderDataBundle(data, kind === "execute_result" ? "result" : "display");
    if (rendered.length) blocks.push(`--- output ---
${rendered.map((s, i) => i === 0 ? s : capBlock(s)).join("\n")}`);
  }
  if (!blocks.length && kind) blocks.push(`--- output (${kind || "unknown"}) skipped \u2014 no text content recognized ---`);
  return blocks;
}
function capBlock(s) {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return `${s.slice(0, MAX_OUTPUT_CHARS)}
[\u2026output truncated at ${MAX_OUTPUT_CHARS} chars of ${s.length} \u2014 the notebook stored more\u2026]`;
}
function notebookText(json) {
  let nb;
  try {
    nb = JSON.parse(json);
  } catch {
    return "[Notebook not readable: the file is not valid JSON. It may be truncated or corrupted.]";
  }
  if (!nb || typeof nb !== "object") {
    return "[Notebook not readable: expected a JSON object, found something else.]";
  }
  const major = Number(nb.nbformat);
  if (Number.isFinite(major) && major < 4) {
    return renderNotebook(nb, `[notebook format v${major} \u2014 pre-v4 layout, converted best-effort]`);
  }
  return renderNotebook(nb, "");
}
function renderNotebook(nb, header) {
  const rawCells = Array.isArray(nb.cells) ? nb.cells : [];
  const blocks = header ? [header] : [];
  let skipped = 0;
  rawCells.forEach((c, i) => {
    if (!c || typeof c !== "object") {
      skipped++;
      return;
    }
    const src = joinSource(c.source);
    const kind = c.cell_type === "markdown" ? "markdown" : c.cell_type === "raw" ? "raw" : "code";
    let block = `### [${kind}]${c.cell_type === "code" && c.execution_count != null ? ` #In[${c.execution_count}]` : ""}
${src}`;
    const outs = Array.isArray(c.outputs) ? c.outputs : [];
    for (const o of outs) {
      for (const b of renderOutput(o)) block += `
${b}`;
    }
    if (!src.trim() && !outs.length) block += "\n(empty cell)";
    blocks.push(block);
  });
  if (skipped) blocks.push(`[${skipped} malformed cell(s) skipped]`);
  if (!rawCells.length) blocks.push("[No cells found in this notebook]");
  return blocks.join("\n\n");
}

// D:/Projects/WebUI/WebUI/lib/server/extract/archives.ts
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var import_node_zlib = __toESM(require("node:zlib"));
var import_node_child_process = require("node:child_process");
var import_node_util = require("node:util");
var import_node_crypto = require("node:crypto");

// D:/Projects/WebUI/WebUI/lib/files/encoding.ts
var FATAL = new TextDecoder("utf-8", { fatal: true });
var CP1252 = new TextDecoder("windows-1252");
function decodeUtf32(buf, le, afterBom) {
  let s = "";
  for (let i = afterBom; i + 3 < buf.length; i += 4) {
    const cp = le ? (buf[i] | buf[i + 1] << 8 | buf[i + 2] << 16 | buf[i + 3] << 24) >>> 0 : (buf[i] << 24 | buf[i + 1] << 16 | buf[i + 2] << 8 | buf[i + 3]) >>> 0;
    s += cp <= 1114111 && (cp < 55296 || cp > 57343) ? String.fromCodePoint(cp) : "\uFFFD";
  }
  return s;
}
function utf16HasAlternatingNul(buf, parity) {
  let nul = 0, nonzero = 0;
  const n = Math.min(buf.length - parity, 4096);
  for (let i = parity; i < n; i += 2) {
    if (buf[i] === 0) nul++;
    else nonzero++;
  }
  return nul >= 8 && nul >= nonzero;
}
function decodeText(buf) {
  if (buf.length >= 4 && buf[0] === 255 && buf[1] === 254 && buf[2] === 0 && buf[3] === 0) {
    return { text: decodeUtf32(buf, true, 4), encoding: "utf-32le", lossy: false };
  }
  if (buf.length >= 4 && buf[0] === 0 && buf[1] === 0 && buf[2] === 254 && buf[3] === 255) {
    return { text: decodeUtf32(buf, false, 4), encoding: "utf-32be", lossy: false };
  }
  if (buf.length >= 2 && buf[0] === 255 && buf[1] === 254) {
    return { text: new TextDecoder("utf-16le").decode(buf), encoding: "utf-16le", lossy: false };
  }
  if (buf.length >= 2 && buf[0] === 254 && buf[1] === 255) {
    return { text: new TextDecoder("utf-16be").decode(buf), encoding: "utf-16be", lossy: false };
  }
  if (buf.length >= 3 && buf[0] === 239 && buf[1] === 187 && buf[2] === 191) {
    return { text: new TextDecoder("utf-8").decode(buf), encoding: "utf-8", lossy: false };
  }
  if (utf16HasAlternatingNul(buf, 0)) {
    return { text: new TextDecoder("utf-16be").decode(buf), encoding: "utf-16be (no BOM)", lossy: false };
  }
  if (utf16HasAlternatingNul(buf, 1)) {
    return { text: new TextDecoder("utf-16le").decode(buf), encoding: "utf-16le (no BOM)", lossy: false };
  }
  try {
    return { text: FATAL.decode(buf), encoding: "utf-8", lossy: false };
  } catch {
    return { text: CP1252.decode(buf), encoding: "windows-1252 (best guess)", lossy: true };
  }
}

// D:/Projects/WebUI/WebUI/lib/server/extract/pdf.ts
var import_unpdf = require("unpdf");
async function pdfText(buf) {
  const doc = await (0, import_unpdf.getDocumentProxy)(new Uint8Array(buf));
  try {
    const { text, totalPages } = await (0, import_unpdf.extractText)(doc, { mergePages: false });
    const perPage = Array.isArray(text) ? text.map((p) => String(p)) : [String(text)];
    const pages = totalPages || perPage.length;
    const pagesWithoutText = [];
    perPage.forEach((p, i) => {
      if (!p.trim()) pagesWithoutText.push(i + 1);
    });
    return { text: perPage.join("\n\n").trim(), pages, perPage, pagesWithoutText };
  } finally {
    await doc.destroy?.();
  }
}

// D:/Projects/WebUI/WebUI/lib/server/extract/strings.ts
var MIN_RUN = 5;
function isPrintableUnit(cp) {
  if (cp === 9 || cp === 10 || cp >= 32 && cp < 127) return true;
  if (cp >= 160 && cp <= 55295) return true;
  if (cp >= 57344 && cp <= 65533) return true;
  return false;
}
function extractStrings(buf, minLen = MIN_RUN) {
  const runs = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (s) => {
    const t = s.trim();
    if (t.length >= minLen && !seen.has(t)) {
      seen.add(t);
      runs.push(t);
    }
  };
  let cur = "";
  for (const b of buf) {
    if (b >= 32 && b < 127 || b === 9) cur += String.fromCharCode(b);
    else {
      push(cur);
      cur = "";
    }
  }
  push(cur);
  for (const parity of [0, 1]) {
    let u = "";
    for (let i = parity; i + 1 < buf.length; i += 2) {
      const cp = buf.readUInt16LE(i);
      if (isPrintableUnit(cp)) u += String.fromCharCode(cp);
      else {
        push(u);
        u = "";
      }
    }
    push(u);
  }
  return runs.join("\n");
}

// D:/Projects/WebUI/WebUI/lib/server/extract/archives.ts
var execFileP = (0, import_node_util.promisify)(import_node_child_process.execFile);
var TMP_DIR = import_node_path.default.join(process.cwd(), ".data", "tmp");
function tmpName(ext) {
  import_node_fs.default.mkdirSync(TMP_DIR, { recursive: true });
  return import_node_path.default.join(TMP_DIR, "x_" + (0, import_node_crypto.randomBytes)(6).toString("hex") + ext);
}
function tarMembers(buf) {
  const out = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    let name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeStr = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = parseInt(sizeStr, 8) || 0;
    const typeFlag = String.fromCharCode(header[156]);
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    if (prefix) name = prefix + "/" + name;
    off += 512;
    if (typeFlag === "0" || typeFlag === "\0" || typeFlag === "") {
      out.push({ name, data: buf.subarray(off, off + size) });
    }
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}
function looksLikeTar(buf) {
  return buf.length >= 512 && buf.subarray(257, 262).toString("utf8") === "ustar";
}
function flattenMembers(members, depth = 0, notExpanded = []) {
  const out = [];
  for (const m of members) {
    if (m.corrupt) {
      out.push(m);
      continue;
    }
    const ext = fileExtension(m.name);
    const nested = ext === "tar" || ext === "gz" || ext === "tgz" || ext === "zip";
    if (nested) {
      if (depth > 2) {
        notExpanded.push(`${m.name} (nesting limit)`);
        continue;
      }
      try {
        if (ext === "tar") {
          out.push(...flattenMembers(tarMembers(m.data), depth + 1, notExpanded));
          continue;
        }
        if (ext === "gz" || ext === "tgz") {
          const raw = import_node_zlib.default.gunzipSync(m.data);
          const inner2 = looksLikeTar(raw) ? tarMembers(raw) : [{ name: m.name.replace(/\.(gz|tgz)$/i, ""), data: raw }];
          out.push(...flattenMembers(inner2, depth + 1, notExpanded));
          continue;
        }
        const zip = readZipDetailed(m.data);
        const inner = [];
        for (const e of zip.entries) {
          inner.push({ name: e.name, data: e.data, ...e.corrupt ? { corrupt: e.corrupt } : {} });
        }
        out.push(...flattenMembers(inner, depth + 1, notExpanded));
        continue;
      } catch {
      }
      notExpanded.push(`${m.name} (nested ${ext} could not be opened)`);
      out.push(m);
      continue;
    }
    if (ext === "7z" || ext === "rar") notExpanded.push(`${m.name} (nested ${ext} not expanded here)`);
    out.push(m);
  }
  return out;
}
var ARCHIVE_TEXT_BUDGET = 8e6;
var MEMBER_TEXT_BYTES = 8 * 1024 * 1024;
async function memberBody(m) {
  const ext = fileExtension(m.name);
  const cat = classifyFile(m.name);
  if (cat === "text") {
    const slice = m.data.length > MEMBER_TEXT_BYTES ? m.data.subarray(0, MEMBER_TEXT_BYTES) : m.data;
    const dec = decodeText(slice);
    const note = (m.data.length > MEMBER_TEXT_BYTES ? `${m.data.length} bytes \u2014 first ${MEMBER_TEXT_BYTES} decoded` : "") + (dec.lossy ? `${dec.encoding === "windows-1252 (best guess)" ? "decoded as windows-1252 (not valid UTF-8) \u2014 characters may be off" : ""}` : "");
    return { body: dec.text, note: note || void 0 };
  }
  if (cat === "rtf") return { body: rtfToText(decodeText(m.data).text) };
  if (cat === "notebook") return { body: notebookText(decodeText(m.data).text) };
  if (cat === "pdf") {
    const r = await pdfText(m.data);
    const cov = r.pages > r.pagesWithoutText.length && r.pagesWithoutText.length ? ` [${r.pages - r.pagesWithoutText.length} of ${r.pages} pages have a text layer]` : "";
    return { body: r.text, note: cov.trim() || void 0 };
  }
  if (cat === "office") {
    if (ext === "epub" || ["docx", "xlsx", "xlsm", "pptx", "odt", "ods", "odp"].includes(ext)) {
      return { body: officeText(m.data, ext) };
    }
    return { body: "", note: "office part with unhandled subtype" };
  }
  if (cat === "legacy") {
    return {
      body: extractStrings(m.data),
      note: "legacy binary format \u2014 strings recovered by byte scan (lossy)"
    };
  }
  if (cat === "image" || cat === "audio" || cat === "video") {
    return { body: "", note: `${cat} content (binary \u2014 not text-extracted)` };
  }
  return { body: "", note: "unrecognised content type" };
}
async function membersToText(members) {
  const notExpanded = [];
  const flat = flattenMembers(members, 0, notExpanded);
  const parts = [];
  const parsed = [];
  const skipped = [];
  const truncated = [];
  const corrupt = [];
  let total = 0;
  let budgetHit = false;
  for (const m of flat) {
    if (m.corrupt) {
      corrupt.push(m.name);
      continue;
    }
    if (total >= ARCHIVE_TEXT_BUDGET) {
      budgetHit = true;
      skipped.push(`${m.name} (joined-text budget reached)`);
      continue;
    }
    let r;
    try {
      r = await memberBody(m);
    } catch (err) {
      skipped.push(`${m.name} (parse failed: ${err?.message || "error"})`);
      continue;
    }
    if (!r.body.trim()) {
      skipped.push(`${m.name}${r.note ? ` \u2014 ${r.note}` : " (no readable text)"}`);
      continue;
    }
    const suffix = r.note ? ` [${r.note}]` : "";
    if (r.note && /bytes — first/.test(r.note)) truncated.push(`${m.name} (${r.note})`);
    const block = `--- member: ${m.name}${suffix} ---
${r.body}
`;
    const room = ARCHIVE_TEXT_BUDGET - total;
    if (block.length > room) {
      parts.push(block.slice(0, room) + `
[\u2026truncated at ${ARCHIVE_TEXT_BUDGET} chars\u2026]`);
      total = ARCHIVE_TEXT_BUDGET;
      budgetHit = true;
    } else {
      parts.push(block);
      total += block.length;
    }
    parsed.push(m.name + suffix);
  }
  const footer = [];
  footer.push(`--- archive coverage --- ${flat.length} member(s) flattened, ${parsed.length} parsed for text`);
  if (corrupt.length) footer.push(`CORRUPT (checksum failed, skipped): ${corrupt.join(", ")}`);
  if (notExpanded.length) footer.push(`NOT EXPANDED: ${notExpanded.join("; ")}`);
  if (truncated.length) footer.push(`TRUNCATED: ${truncated.join("; ")}`);
  if (budgetHit) footer.push(`joined text hit the ${ARCHIVE_TEXT_BUDGET} character budget \u2014 later members are listed but their content is not included`);
  if (skipped.length) footer.push(`no text content: ${skipped.slice(0, 200).join("; ")}${skipped.length > 200 ? ` (+${skipped.length - 200} more)` : ""}`);
  return [...parts, footer.join("\n")].join("\n").trim();
}
async function extractWith7za(buf, ext) {
  const seven = await import("7zip-bin");
  const exe = seven.path7za ?? seven.default?.path7za;
  if (!exe || !import_node_fs.default.existsSync(exe)) throw new Error("Bundled 7za binary is missing \u2014 run `npm install`");
  const src = tmpName(ext);
  const dir = tmpName("");
  import_node_fs.default.mkdirSync(dir, { recursive: true });
  try {
    import_node_fs.default.writeFileSync(src, buf);
    await execFileP(exe, ["x", "-y", `-o${dir}`, src], { timeout: 6e4, maxBuffer: 64 * 1024 * 1024 });
    const members = [];
    const walk = (d, rel) => {
      for (const ent of import_node_fs.default.readdirSync(d, { withFileTypes: true })) {
        const p = import_node_path.default.join(d, ent.name);
        const r = rel ? rel + "/" + ent.name : ent.name;
        if (ent.isDirectory()) walk(p, r);
        else if (ent.isFile()) members.push({ name: r, data: import_node_fs.default.readFileSync(p) });
      }
    };
    walk(dir, "");
    return members;
  } finally {
    try {
      import_node_fs.default.rmSync(src, { force: true });
      import_node_fs.default.rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  }
}
async function extractRar(buf) {
  const mod = await import("node-unrar-js");
  const extractor = await mod.createExtractorFromData({ data: new Uint8Array(buf) });
  const members = [];
  const list = extractor.getFileList();
  for (const f of list.fileHeaders) {
    if (f.directory) continue;
    const extracted = extractor.extract({ files: [f.fileName] });
    for (const file of extracted.files) {
      if (file.extraction?.data) {
        members.push({ name: file.fileName, data: Buffer.from(file.extraction.data) });
      }
    }
  }
  return members;
}
function nameBareStream(members, originalName, ext) {
  if (members.length !== 1 || fileExtension(members[0].name)) return members;
  const inner = originalName.replace(new RegExp(`\\.${ext}$`, "i"), "");
  return inner && inner !== originalName ? [{ ...members[0], name: inner }] : members;
}
async function zipMembers(buf) {
  try {
    return readZip(buf);
  } catch {
    try {
      return await extractWith7za(buf, ".zip");
    } catch {
      throw new Error(
        "Unreadable ZIP archive (it may be password-protected, or use a compression method that 7za cannot open without a password)"
      );
    }
  }
}
async function archiveText(buf, ext, originalName = "") {
  switch (ext) {
    case "zip":
      return membersToText(await zipMembers(buf));
    case "tar":
      return membersToText(tarMembers(buf));
    case "gz": {
      const raw = import_node_zlib.default.gunzipSync(buf);
      if (looksLikeTar(raw)) return membersToText(tarMembers(raw));
      const dec = decodeText(raw.subarray(0, ARCHIVE_TEXT_BUDGET));
      const label = dec.lossy ? `[decoded as ${dec.encoding} \u2014 not valid UTF-8] ` : "";
      const trunc = raw.length > ARCHIVE_TEXT_BUDGET ? `
[\u2026single-stream gzip: ${raw.length} bytes decoded to ${ARCHIVE_TEXT_BUDGET} chars\u2026]` : "";
      return label + dec.text + trunc;
    }
    case "tgz":
      return membersToText(tarMembers(import_node_zlib.default.gunzipSync(buf)));
    case "bz2":
    case "xz": {
      const members = await extractWith7za(buf, "." + ext);
      return membersToText(nameBareStream(members, originalName, ext));
    }
    case "7z":
      return membersToText(await extractWith7za(buf, ".7z"));
    case "rar":
      return membersToText(await extractRar(buf));
    default:
      throw new Error("Unsupported archive format: " + ext);
  }
}

// D:/Projects/WebUI/WebUI/lib/server/extract/document-capability.ts
var import_node_path2 = __toESM(require("node:path"));

// D:/Projects/WebUI/WebUI/lib/server/ml-job.ts
var import_node_crypto2 = require("node:crypto");

// D:/Projects/WebUI/WebUI/lib/server/rustProxy.ts
function rustEnabled() {
  return process.env.RUKE_RUST_BACKEND === "1";
}
function rustBaseUrl() {
  const port = process.env.RUKE_BACKEND_PORT?.trim() || "3101";
  return `http://127.0.0.1:${port}`;
}
var INTERNAL_SECRET_HEADER = "x-ruke-internal-secret";
function internalSecretHeaders() {
  const secret = process.env.RUKE_BROWSER_BRIDGE_SECRET?.trim();
  return secret ? { [INTERNAL_SECRET_HEADER]: secret } : {};
}

// D:/Projects/WebUI/WebUI/lib/server/ml-job.ts
var ML_JOB_PATH = "/api/ruke/ml/job";
var ML_JOB_SCHEMA_VERSION = 1;
var ML_JOB_DEFAULT_DEADLINE_MS = 12e4;
var ML_JOB_MIN_DEADLINE_MS = 1e3;
var ML_JOB_MAX_DEADLINE_MS = 6e5;
var ML_JOB_GRACE_MS = 5e3;
var ML_JOB_NEGATIVE_TTL_MS = 6e4;
var idPart = () => (0, import_node_crypto2.randomBytes)(9).toString("hex");
var newRunId = () => `run_${idPart()}`;
var NEGATIVE_TTL = ML_JOB_NEGATIVE_TTL_MS;
var negative = /* @__PURE__ */ new Map();
var CACHEABLE_REASONS = /* @__PURE__ */ new Set([
  "not_configured",
  "invalid_endpoint",
  "unreachable",
  "deadline_exceeded",
  "contract_mismatch",
  "capability_mismatch",
  "resource_busy"
]);
function clampDeadlineMs(ms) {
  const raw = typeof ms === "number" && Number.isFinite(ms) ? ms : ML_JOB_DEFAULT_DEADLINE_MS;
  return Math.min(ML_JOB_MAX_DEADLINE_MS, Math.max(ML_JOB_MIN_DEADLINE_MS, Math.round(raw)));
}
function combineCancellation(external, timeoutMs) {
  const controller = new AbortController();
  let timeoutHit = false;
  let externalHit = false;
  const timer = setTimeout(() => {
    timeoutHit = true;
    controller.abort(new Error(`the capability job exceeded its ${timeoutMs} ms client deadline`));
  }, timeoutMs);
  timer.unref?.();
  const onExternal = () => {
    externalHit = true;
    const reason = external?.reason;
    controller.abort(reason ?? new Error("the caller cancelled the capability job"));
  };
  if (external) {
    if (external.aborted) onExternal();
    else external.addEventListener("abort", onExternal, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      if (external) external.removeEventListener("abort", onExternal);
    },
    timedOut: () => timeoutHit,
    abortedExternally: () => externalHit
  };
}
function localEnvelope(capability, runId, jobId, requestId, deadlineS, reason, message, retryable, humanStep) {
  return {
    state: "unavailable",
    capability,
    job_id: jobId,
    run_id: runId,
    request_id: requestId,
    deadline_s: deadlineS,
    source: "ts-ml-job-client",
    error: { reason, message, retryable, capability, human_step: humanStep }
  };
}
function asEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value;
  if (typeof raw.state !== "string" || typeof raw.capability !== "string") return null;
  const error = raw.error && typeof raw.error === "object" ? raw.error : void 0;
  return {
    state: raw.state,
    capability: raw.capability,
    job_id: typeof raw.job_id === "string" ? raw.job_id : "",
    run_id: typeof raw.run_id === "string" ? raw.run_id : "",
    request_id: typeof raw.request_id === "string" ? raw.request_id : "",
    deadline_s: Number.isFinite(Number(raw.deadline_s)) ? Number(raw.deadline_s) : 0,
    source: typeof raw.source === "string" ? raw.source : "rust-ml-job",
    ...error ? {
      error: {
        reason: typeof error.reason === "string" ? error.reason : "internal",
        message: typeof error.message === "string" ? error.message : "the capability job did not complete",
        retryable: error.retryable === true,
        capability: typeof error.capability === "string" ? error.capability : raw.capability,
        human_step: typeof error.human_step === "string" ? error.human_step : ""
      }
    } : {},
    ..."result" in raw ? { result: raw.result } : {}
  };
}
async function mlJob(capability, payload = {}, opts = {}) {
  if (!rustEnabled()) return null;
  if (typeof capability !== "string" || capability.length === 0) return null;
  const cached = negative.get(capability);
  const now = Date.now();
  if (cached && now - cached.at < NEGATIVE_TTL) return { ...cached.envelope };
  if (cached) negative.delete(capability);
  const deadlineMs = clampDeadlineMs(opts.deadlineMs);
  const deadlineS = Math.round(deadlineMs / 1e3);
  const requestId = `req_${idPart()}`;
  const runId = newRunId();
  const jobId = `job_${idPart()}`;
  const cancellation = combineCancellation(opts.signal, deadlineMs + ML_JOB_GRACE_MS);
  try {
    const response = await fetch(`${rustBaseUrl()}${ML_JOB_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...internalSecretHeaders()
      },
      body: JSON.stringify({
        request_id: requestId,
        run_id: runId,
        job_id: jobId,
        capability,
        payload,
        deadline_s: deadlineS,
        schema_version: ML_JOB_SCHEMA_VERSION
      }),
      signal: cancellation.signal
    });
    const text = await response.text();
    if (response.status === 401) {
      return localEnvelope(
        capability,
        runId,
        jobId,
        requestId,
        deadlineS,
        "unauthorized",
        "the Rust backend refused this internal call (bridge secret mismatch)",
        false,
        "restart `npm run dev` so the supervisor and the backend share one bridge secret"
      );
    }
    const parsed = asEnvelope(JSON.parse(text));
    if (parsed) {
      if (parsed.error && CACHEABLE_REASONS.has(parsed.error.reason)) {
        negative.set(capability, { at: Date.now(), envelope: parsed });
      }
      return parsed;
    }
    const gate = response.status === 400 || response.status === 413;
    const envelope = localEnvelope(
      capability,
      runId,
      jobId,
      requestId,
      deadlineS,
      gate ? "input_rejected" : "contract_mismatch",
      gate ? `the capability gate refused this request with HTTP ${response.status}: ${text.slice(0, 300)}` : `the capability route answered HTTP ${response.status} with a body that is not the job envelope`,
      !gate,
      gate ? "this is a programming fault in the caller: report it, do not retry blindly" : "check that the Rust backend and this UI were started by the same `npm run dev`"
    );
    if (!gate) negative.set(capability, { at: Date.now(), envelope });
    return envelope;
  } catch (err) {
    if (cancellation.abortedExternally() || opts.signal?.aborted) {
      return localEnvelope(
        capability,
        runId,
        jobId,
        requestId,
        deadlineS,
        "cancelled",
        "the caller cancelled the capability job",
        false,
        "no action needed: nothing was published"
      );
    }
    if (cancellation.timedOut()) {
      const envelope2 = localEnvelope(
        capability,
        runId,
        jobId,
        requestId,
        deadlineS,
        "deadline_exceeded",
        `the capability backend did not answer within ${deadlineMs + ML_JOB_GRACE_MS} ms`,
        true,
        "retry, or ask for a narrower range"
      );
      negative.set(capability, { at: Date.now(), envelope: envelope2 });
      return envelope2;
    }
    const envelope = localEnvelope(
      capability,
      runId,
      jobId,
      requestId,
      deadlineS,
      "unreachable",
      `the Rust backend could not be reached for this job (${err?.message ?? "transport error"})`,
      true,
      "restart `npm run dev`; the capability route lives in the Rust server"
    );
    negative.set(capability, { at: Date.now(), envelope });
    return envelope;
  } finally {
    cancellation.dispose();
  }
}

// D:/Projects/WebUI/WebUI/lib/server/extract/document-capability.ts
var DOCUMENT_PARSE_CAPABILITY = "documents.parse";
var DOCUMENT_PARSE_DEADLINE_MS = 9e4;
var LOST_ITEMS_NAMED = 6;
var PDF_VARIANT_RATIO = 1.2;
var DOCUMENT_OCR_LANGUAGE_ENV = "RUKE_DOCUMENT_OCR_LANGUAGE";
var asString = (v, fallback = "") => typeof v === "string" ? v : typeof v === "number" ? String(v) : fallback;
var asNumber = (v, fallback = 0) => typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : fallback;
function idList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const n = asNumber(item, NaN);
    if (Number.isFinite(n) && n > 0) out.push(Math.trunc(n));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}
function normalizeUnitProvenance(kind, extraction) {
  if (kind === "ocr_text") return "ocr";
  if (extraction.includes("weak")) return "text-layer-weak";
  return "text-layer";
}
function normalizeDocument(result) {
  if (!result || typeof result !== "object") return null;
  const outer = result;
  const payload = outer.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload;
  const document = p.document;
  if (!document || typeof document !== "object" || Array.isArray(document)) return null;
  const rawDoc = document;
  const coverage = rawDoc.coverage && typeof rawDoc.coverage === "object" ? rawDoc.coverage : {};
  const meta = rawDoc.meta && typeof rawDoc.meta === "object" ? rawDoc.meta : {};
  const blocks = Array.isArray(rawDoc.blocks) ? rawDoc.blocks : [];
  const unitsTotal = asNumber(coverage.units_total, 0);
  if (unitsTotal <= 0) return null;
  const grouped = [];
  for (const raw of blocks) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw;
    const loc = b.loc && typeof b.loc === "object" ? b.loc : {};
    const kind = asString(b.kind);
    const extraction = asString(loc.extraction);
    const unit = asNumber(loc.page ?? loc.slide ?? loc.sheet ?? loc.unit ?? 0, 0);
    const text = asString(b.text);
    if (!text.trim()) continue;
    const confidence = typeof b.confidence === "number" && Number.isFinite(b.confidence) ? b.confidence : null;
    grouped.push({
      unit,
      text,
      provenance: normalizeUnitProvenance(kind, extraction),
      engine: asString(loc.engine, asString(coverage.method)),
      language: asString(loc.language_code ?? loc.language),
      confidence
    });
  }
  const rendered = [];
  for (const raw of Array.isArray(p.rendered_units) ? p.rendered_units : []) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const r = raw;
    const text = asString(r.text);
    if (!text.trim()) continue;
    const who = asString(r.provenance);
    rendered.push({
      unit: asNumber(r.unit, 0),
      text,
      provenance: who === "ocr" || who === "text-layer-weak" ? who : "text-layer",
      engine: asString(r.engine, asString(coverage.method)),
      blocks: asNumber(r.blocks, 0),
      truncated: r.truncated === true
    });
  }
  const ocrRaw = p.ocr && typeof p.ocr === "object" ? p.ocr : {};
  const ran = ocrRaw.ran === true;
  const ocrPages = [];
  if (Array.isArray(ocrRaw.pages)) {
    for (const row of ocrRaw.pages) {
      if (!row || typeof row !== "object") continue;
      const unit = asNumber(row.page, 0);
      if (!unit) continue;
      ocrPages.push({
        unit,
        state: asString(row.state, "unknown"),
        engine: asString(row.engine),
        detail: asString(row.detail),
        confidence: typeof row.confidence === "number" && Number.isFinite(row.confidence) ? row.confidence : null,
        languageCode: asString(row.language_code),
        rotation: (() => {
          const raster = row.raster && typeof row.raster === "object" && !Array.isArray(row.raster) ? row.raster : {};
          const rot = Number(raster.rotation);
          return Number.isFinite(rot) && rot !== 0 ? (rot % 360 + 360) % 360 : null;
        })()
      });
    }
  }
  const enginesRecognised = {};
  if (ocrRaw.engines_recognised && typeof ocrRaw.engines_recognised === "object") {
    for (const [engine, count] of Object.entries(
      ocrRaw.engines_recognised
    )) {
      enginesRecognised[engine] = asNumber(count, 0);
    }
  }
  const engines = Array.isArray(ocrRaw.engines) ? ocrRaw.engines.map((engine) => asString(engine)).filter(Boolean) : [];
  const doc = {
    kind: asString(rawDoc.kind, "unknown"),
    engine: asString(coverage.method, `${asString(rawDoc.kind)} reader`),
    unitsTotal,
    unitsSucceeded: idList(coverage.units_succeeded),
    unitsEmpty: idList(coverage.units_empty),
    unitsNeedingOcr: idList(coverage.units_needing_ocr),
    unitsFailed: idList(coverage.units_failed),
    ocrUnits: idList(p.ocr_units),
    complete: p.coverage_complete === true,
    note: asString(coverage.note) || asString(outer.coverage?.note),
    units: grouped,
    rendered,
    ocr: {
      ran,
      attempted: asNumber(ocrRaw.attempted, 0),
      recognized: asNumber(ocrRaw.recognized, 0),
      language: asString(ocrRaw.language),
      summary: asString(ocrRaw.summary),
      reason: asString(ocrRaw.reason),
      needsLanguage: ocrRaw.needs_language === true,
      pages: ocrPages,
      engines,
      enginesRecognised,
      primaryReady: ocrRaw.primary_ready === true,
      languageSource: asString(ocrRaw.language_source)
    },
    meta
  };
  const reportsNothing = doc.units.length === 0 && doc.rendered.length === 0 && doc.unitsFailed.length === 0 && doc.unitsEmpty.length === 0 && doc.unitsNeedingOcr.length === 0;
  if (reportsNothing) return null;
  return doc;
}
async function readDocumentViaCapability(srcPath, opts = {}) {
  const run = opts.runJob ?? mlJob;
  const resolved = import_node_path2.default.resolve(srcPath);
  const language = (opts.language ?? process.env[DOCUMENT_OCR_LANGUAGE_ENV] ?? "").trim();
  const payload = { path: resolved, root: import_node_path2.default.dirname(resolved) };
  if (language) payload.language = language;
  const envelope = await run(DOCUMENT_PARSE_CAPABILITY, payload, {
    deadlineMs: opts.deadlineMs ?? DOCUMENT_PARSE_DEADLINE_MS,
    signal: opts.signal
  });
  if (envelope === null) return { state: "none" };
  if (envelope.state === "ready") {
    const doc = normalizeDocument(envelope.result);
    if (doc) return { state: "ready", doc };
    return {
      state: "unavailable",
      reason: "contract_mismatch",
      message: "the capability backend reported a successful document parse that carries no readable units, which is refused rather than treated as an empty document",
      humanStep: "report this: the payload shape and the reader version must match",
      retryable: false
    };
  }
  const error = envelope.error;
  return {
    state: "unavailable",
    reason: error?.reason || (envelope.state === "cancelled" ? "cancelled" : "internal"),
    message: error?.message || `the capability job ended in state ${envelope.state}`,
    humanStep: error?.human_step || "",
    retryable: error?.retryable === true
  };
}
var unitLabel = (units) => !units.length ? "no pages" : units.length === 1 ? `page ${units[0]}` : `pages ${units.join(", ")}`;
var listForNote = (units, limit = 15) => units.length <= limit ? unitLabel(units) : `${units.length} pages`;
function ocrEngineNote(ocr) {
  const bits = [];
  const engines = Array.isArray(ocr.engines) ? ocr.engines : [];
  const recognised = ocr.enginesRecognised && typeof ocr.enginesRecognised === "object" ? ocr.enginesRecognised : {};
  const pages = Array.isArray(ocr.pages) ? ocr.pages : [];
  if (engines.length) bits.push(`engines consulted: ${engines.join(" -> ")}`);
  if (Object.keys(recognised).length) {
    bits.push(
      `recognised per engine: ${Object.entries(recognised).map(([engine, count]) => `${engine}=${count}`).join(", ")}`
    );
  }
  if (ocr.ran && !ocr.primaryReady) {
    bits.push("the primary OCR engine was NOT ready for this run, so any OCR here came from the recovery engine with lower layout/formula fidelity");
  }
  const unresolved = pages.filter((p) => p.state === "ocr_failed" || p.state === "raster_failed").map((p) => p.unit);
  if (unresolved.length) bits.push(`unresolved after fallback: ${listForNote(unresolved)}`);
  const skipped = pages.filter((p) => p.state === "skipped").map((p) => p.unit);
  if (skipped.length) bits.push(`cancelled before OCR: ${listForNote(skipped)}`);
  const emptied = pages.filter((p) => p.state === "empty").map((p) => p.unit);
  if (emptied.length) bits.push(`OCR found no text on ${listForNote(emptied)}`);
  if (ocr.language && ocr.languageSource) bits.push(`language ${ocr.language} from ${ocr.languageSource}`);
  return bits.join("; ");
}
var nonSpace = (s) => s.replace(/\s+/g, "").length;
function dropSharedLines(variant, primary) {
  const collapse = (s) => s.replace(/\s+/g, " ").trim();
  const delivered = collapse(primary);
  return variant.trim().split(/\r?\n/).filter((line) => {
    const c = collapse(line);
    return c.length > 0 && !delivered.includes(c);
  }).join("\n").trim();
}
function unitForPage(doc, page) {
  const candidates = doc.units.filter((u) => u.unit === page && u.text.trim());
  if (!candidates.length) return null;
  const nativeFirst = (u) => u.provenance === "ocr" ? 1 : 0;
  candidates.sort(
    (a, b) => nativeFirst(a) - nativeFirst(b) || b.text.replace(/\s+/g, "").length - a.text.replace(/\s+/g, "").length
  );
  return candidates[0];
}
function provenanceLabel(reader, unit) {
  if (reader === "ts-text-layer") return "pdf.js text layer";
  if (unit?.provenance === "ocr") {
    const extra = [unit.language, unit.confidence !== null ? `confidence ${unit.confidence}` : ""].filter(Boolean).join(", ");
    return `${unit.engine || "ocr engine"} OCR${extra ? ` (${extra})` : ""}`;
  }
  return `${unit?.engine || "capability reader"} text layer`;
}
function unitFailureReasons(doc) {
  const out = [];
  const push = (value) => {
    if (typeof value === "string" && value.trim()) out.push(value.trim());
  };
  const lists = [
    [doc.meta.page_failures, (e) => `page ${asString(e.page, "?")}: ${asString(e.stage, "extract")} failed - ${asString(e.detail)}`],
    [doc.meta.sheet_failures, (e) => `sheet ${asString(e.sheet, "?")} (unit ${asString(e.sheet_index, "?")}): ${asString(e.why)}${e.part ? ` [part ${asString(e.part)}]` : ""}`]
  ];
  for (const [raw, format] of lists) {
    if (!Array.isArray(raw)) continue;
    for (const entry of raw) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) push(format(entry));
      else push(entry);
    }
  }
  return [...new Set(out)].slice(0, 12);
}
function hasRasterEvidence(doc) {
  if (doc.unitsNeedingOcr.length > 0) return true;
  if (doc.ocrUnits.length > 0) return true;
  if (doc.ocr.attempted > 0 || doc.ocr.recognized > 0) return true;
  const images = doc.meta.pages_with_images;
  if (images && typeof images === "object" && !Array.isArray(images)) {
    for (const value of Object.values(images)) {
      if (asNumber(value, 0) > 0) return true;
    }
  }
  return false;
}
function mergePdfUnits(ts, doc) {
  const pages = Math.max(ts.pages || 0, doc.unitsTotal || 0);
  const readBy = {};
  const bodies = [];
  const readUnits = [];
  const unreadUnits = [];
  let filledByOcr = 0;
  let filledByCapText = 0;
  let keptWeakWithOcr = 0;
  let variantsKept = 0;
  const pageRaster = (page) => {
    if (doc.unitsNeedingOcr.includes(page) || doc.ocrUnits.includes(page)) return true;
    const images = doc.meta.pages_with_images;
    if (images && typeof images === "object" && !Array.isArray(images)) {
      const entry = images[String(page)];
      return asNumber(entry, 0) > 0;
    }
    return false;
  };
  for (let page = 1; page <= pages; page += 1) {
    const tsText = (ts.perPage[page - 1] ?? "").trim();
    const capUnit = unitForPage(doc, page);
    if (tsText) {
      readBy[page] = "ts-text-layer";
      readUnits.push(page);
      bodies.push(`[page ${page} | read by: ${provenanceLabel("ts-text-layer", null)}]
${tsText}`);
      const ocrUnit = doc.units.find((u) => u.unit === page && u.provenance === "ocr" && u.text.trim()) ?? null;
      const variant = ocrUnit ?? capUnit;
      if (variant) {
        if (ocrUnit) keptWeakWithOcr += 1;
        const tsChars = nonSpace(tsText);
        const capChars = nonSpace(variant.text);
        if (capChars >= Math.max(1, tsChars) * PDF_VARIANT_RATIO) {
          const delivered = dropSharedLines(variant.text, tsText);
          const deliveredChars = nonSpace(delivered);
          if (deliveredChars > 0) {
            variantsKept += 1;
            const who = provenanceLabel(ocrUnit ? "capability-ocr" : "capability-text-layer", variant);
            const shared = nonSpace(variant.text) - deliveredChars;
            bodies.push(
              `[page ${page} | second reader ${who}: ${deliveredChars} non-whitespace characters vs the pdf.js text layer's ${tsChars}${shared > 0 ? `, ${shared} characters already delivered above were not repeated` : ""}; kept as a variant, the text layer above was NOT replaced]
` + delivered
            );
          }
        }
      }
      continue;
    }
    if (capUnit) {
      readBy[page] = capUnit.provenance === "ocr" ? "capability-ocr" : "capability-text-layer";
      readUnits.push(page);
      if (capUnit.provenance === "ocr") filledByOcr += 1;
      else filledByCapText += 1;
      bodies.push(`[page ${page} | read by: ${provenanceLabel(readBy[page], capUnit)}]
${capUnit.text.trim()}`);
      continue;
    }
    unreadUnits.push(page);
    bodies.push(
      `[page ${page} | not read: ${pageRaster(page) ? "no text layer, and OCR produced nothing for this page" : "no text layer AND no image content on this page, so there is nothing for an OCR engine to read"}]`
    );
  }
  const capUnread = [...doc.unitsEmpty, ...doc.unitsNeedingOcr, ...doc.unitsFailed].filter((u) => u >= 1 && u <= pages).filter((u, i, arr) => arr.indexOf(u) === i).sort((a, b) => a - b).filter((u) => !readUnits.includes(u));
  const tsUnreadCount = ts.pagesWithoutText.filter((p) => p >= 1 && p <= pages).length;
  const parts = [];
  parts.push(`document capability ${DOCUMENT_PARSE_CAPABILITY} (${doc.engine})`);
  if (ts.pages > 0) {
    parts.push(`text layer: ${readUnits.filter((u) => readBy[u] === "ts-text-layer").length} of ${ts.pages} page(s) via pdf.js`);
    parts.push(`capability filled ${filledByOcr} page(s) by OCR and ${filledByCapText} page(s) by its own text layer`);
    if (tsUnreadCount === 0 && capUnread.length === 0 && doc.unitsTotal === ts.pages) {
      parts.push("both readers agree every page carries a text layer");
    }
  } else {
    parts.push("the TS engine could not open this document; the capability engine served the body");
  }
  parts.push(`read: ${listForNote(readUnits)}`);
  parts.push(`units: ${readUnits.length} of ${pages} read`);
  if (unreadUnits.length) parts.push(`not read: ${listForNote(unreadUnits)}`);
  if (doc.unitsFailed.length) parts.push(`failed units: ${doc.unitsFailed.join(", ")}`);
  const failures = unitFailureReasons(doc);
  if (failures.length) parts.push(`unit failures: ${failures.join(" | ")}`);
  if (doc.ocr.ran) {
    parts.push(`${doc.ocr.recognized} page(s) recognised by OCR${doc.ocr.language ? ` (${doc.ocr.language})` : ""}: ${doc.ocr.summary || doc.ocr.attempted + " attempted"}`);
    parts.push(ocrEngineNote(doc.ocr));
    const rotated = doc.ocr.pages.filter((o) => (o.rotation ?? 0) !== 0);
    if (rotated.length) {
      parts.push(`raster rotation applied: ${rotated.map((o) => `page ${o.unit} ${o.rotation}\xB0`).join(", ")}`);
    }
  } else if (doc.ocr.needsLanguage) {
    parts.push(`OCR needs an explicit language (set ${DOCUMENT_OCR_LANGUAGE_ENV}); ${doc.ocr.reason}`);
  } else {
    parts.push(`OCR did not run: ${doc.ocr.reason || "no reason reported"}`);
  }
  if (keptWeakWithOcr) {
    parts.push(`${keptWeakWithOcr} page(s) were OCR-flagged and OCR output exists but the TS text layer was kept`);
  }
  if (variantsKept) {
    parts.push(`${variantsKept} page(s) carry a second-reader variant alongside the TS text layer (kept beside it, never replaced)`);
  }
  const coverageNote = `[${parts.join("; ")}]`;
  let refusal = "";
  let honestEmpty = false;
  if (!readUnits.length && pages > 0) {
    if (hasRasterEvidence(doc)) {
      const scanned = doc.unitsNeedingOcr.length ? `${listForNote(doc.unitsNeedingOcr)} ${doc.unitsNeedingOcr.length === 1 ? "carries" : "carry"}` : "every page carries";
      const blocker = doc.ocr.ran ? "OCR ran and recognised nothing on these pages" : doc.ocr.needsLanguage ? `OCR needs an explicit language (set ${DOCUMENT_OCR_LANGUAGE_ENV}); the engine was not run: ${doc.ocr.reason}` : `OCR did not run: ${doc.ocr.reason || "no reason reported"}`;
      refusal = `this document has no readable text layer - ${scanned} image content with no text layer. ${blocker}. Send the page you care about as an image and the vision model can read it.`;
    } else {
      honestEmpty = true;
    }
  }
  return {
    text: [coverageNote, "", bodies.join("\n\n")].join("\n"),
    pages,
    readUnits,
    unreadUnits,
    readBy,
    coverageNote,
    refusal,
    honestEmpty,
    unitFailures: unitFailureReasons(doc),
    bodyEngine: "ts"
  };
}
var CONTENT_TOKEN = /[\p{L}\p{N}][\p{L}\p{N}_-]*/gu;
var normLine = (value) => value.replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
var contentLines = (value) => value.split(/\r?\n/).map(normLine).filter(Boolean);
var contentTokens = (value) => value.toLowerCase().match(CONTENT_TOKEN) ?? [];
function lineInside(needle, haystack) {
  if (!needle) return true;
  if (needle === haystack) return true;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "u").test(haystack);
  } catch {
    return false;
  }
}
var READER_ARTIFACT_PATTERNS = [
  { why: "TS OOXML reader: out-of-range shared-string index", re: /\((?:shared string|shared string #\d*|string #\d*)\s*missing\)/gi },
  { why: 'spreadsheet stored error value (OOXML t="e")', re: /#(?:REF!|VALUE!|DIV\/0!|NAME\?|NULL!|NUM!|N\/A)/g },
  { why: "TS OOXML reader: formula half missing", re: /\[formula (?:continuation; expression not stored in this cell|present but neither expression nor cached value stored)\]/gi },
  { why: "legacy byte-scan recovery marker", re: /\[binary (?:string|run)[^\]]*\]/gi }
];
function stripReaderArtifacts(value) {
  let text = value;
  let dropped = 0;
  for (const artifact of READER_ARTIFACT_PATTERNS) {
    text = text.replace(artifact.re, () => {
      dropped += 1;
      return " ";
    });
  }
  return { text, dropped };
}
var CELL_REF_TOKEN = /[A-Z]{1,3}[1-9][0-9]*/;
function countStructureFacts(value) {
  const count = (re) => value.match(re)?.length ?? 0;
  let declaredEmptyCells = 0;
  for (const header of value.matchAll(/### declared-empty cells[^\n]*?:\s*([^\n]*)/gi)) {
    const listed = (header[1] ?? "").match(new RegExp(CELL_REF_TOKEN.source, "g")) ?? [];
    declaredEmptyCells += listed.length;
  }
  let corruptCells = 0;
  for (const header of value.matchAll(/### cells this reader could NOT read:\s*([^\n]*)/gi)) {
    const listed = (header[1] ?? "").match(new RegExp(`${CELL_REF_TOKEN.source}\\s*:`, "g")) ?? [];
    corruptCells += listed.length;
  }
  return {
    mergedAttributions: count(/\[merged\s+[A-Z]{1,3}[1-9][0-9]*(?::[A-Z]{1,3}[1-9][0-9]*)?\]/g),
    declaredEmptyCells,
    corruptCells,
    // Deliberately disjoint from the corrupt-CELL header above: a unit failure is a WHOLE unit
    // the reader could not read, and double-counting one header would inflate the tie-breaker.
    unitFailures: count(/(?:could NOT be read|could not be read|no parser is configured|part [^\n]*is missing from the package)/gi),
    formulaWithCache: count(/(?:^|[\t >])=\S[^\n]*\(cached\s+[^\n)]+\)/gim)
  };
}
var structureTotal = (facts) => facts.mergedAttributions + facts.declaredEmptyCells + facts.corruptCells + facts.unitFailures + facts.formulaWithCache;
var STRUCTURE_LABELS = [
  ["mergedAttributions", "merged-area attributions"],
  ["declaredEmptyCells", "declared-empty cells"],
  ["corruptCells", "cells unreadable-by-reference"],
  ["unitFailures", "reported unit failures"],
  ["formulaWithCache", "formulas carrying cached values"]
];
function structureBreakdown(facts) {
  const named = STRUCTURE_LABELS.filter(([key]) => facts[key] > 0).map(([key, label]) => `${label} ${facts[key]}`);
  return named.length ? named.join(", ") : "none stated";
}
function measureContentCoverage(tsText, capabilityText) {
  const tsClean = stripReaderArtifacts(tsText);
  const capClean = stripReaderArtifacts(capabilityText);
  const tsItems = new Set(contentTokens(tsClean.text));
  const capItems = new Set(contentTokens(capClean.text));
  const lostTokens = [];
  for (const item of tsItems) if (!capItems.has(item)) lostTokens.push(item);
  let newTokens = 0;
  for (const item of capItems) if (!tsItems.has(item)) newTokens += 1;
  const tsLines = contentLines(tsClean.text);
  const capLines = contentLines(capClean.text);
  const distinct = (values) => [...new Set(values)];
  const tsUnique = distinct(tsLines);
  const capUnique = distinct(capLines);
  let rebuiltLines = 0;
  let lostLines = 0;
  for (const line of tsUnique) {
    if (capUnique.some((cap2) => lineInside(line, cap2))) continue;
    const items = new Set(contentTokens(line));
    if ([...items].some((item) => !capItems.has(item))) lostLines += 1;
    else rebuiltLines += 1;
  }
  let groupedLines = 0;
  for (const cap2 of capUnique) {
    let carried = 0;
    for (const line of tsUnique) if (lineInside(line, cap2)) carried += 1;
    if (carried >= 2) groupedLines += 1;
  }
  return {
    lostTokens,
    newTokens,
    rebuiltLines,
    lostLines,
    groupedLines,
    tsItems: tsItems.size,
    tsLines: tsUnique.length,
    capLines: capUnique.length,
    droppedArtifacts: tsClean.dropped + capClean.dropped
  };
}
function officeBodyDecision(promote, coverage, engine, capCount, tsCount, renderingMeasured, capStructure, tsStructure) {
  const measured = renderingMeasured ? "measured on the reader's own structure-preserving rendering" : "measured on joined block texts (this backend ships no rendering)";
  const structure = `plus structure: capability ${structureTotal(capStructure)} structural fact(s) [${structureBreakdown(capStructure)}] vs TS ${structureTotal(tsStructure)} [${structureBreakdown(tsStructure)}]`;
  const artifacts = coverage.droppedArtifacts > 0 ? `; ${coverage.droppedArtifacts} reader artifact rendering(s) (placeholder/error text, not document content) excluded from the loss measurement on both sides` : "";
  if (promote) {
    const rebuilt = coverage.rebuiltLines ? `, ${coverage.rebuiltLines} line(s) re-broken but fully carried` : "";
    return `${engine} chosen over the TS reader: it carries all ${coverage.tsItems} content item(s) the TS reader read and adds ${coverage.newTokens} new item(s) plus ${coverage.groupedLines} structurally grouped line(s)${rebuilt} ${structure}; ${capCount} vs ${tsCount} non-whitespace characters (reported, not the decision); ${measured}${artifacts}`;
  }
  if (capCount === 0) return `${engine} produced no body text at all, so the TS reader served the body`;
  if (coverage.lostTokens.length > 0) {
    const named = coverage.lostTokens.slice(0, LOST_ITEMS_NAMED).join(", ");
    const more = coverage.lostTokens.length > LOST_ITEMS_NAMED ? ` +${coverage.lostTokens.length - LOST_ITEMS_NAMED} more` : "";
    return `${engine} refused as the body: it loses ${coverage.lostTokens.length} content item(s) the TS reader read (${named}${more}), so promoting it would be a regression whatever its ${capCount} characters suggest ${structure}; ${measured}${artifacts}`;
  }
  return `${engine} carries the same ${coverage.tsItems} content item(s) as the TS reader and adds nothing (${capCount} vs ${tsCount} non-whitespace characters) ${structure}, so the merge kept the TS reader: a measurement, not a language preference; ${measured}${artifacts}`;
}
function mergeOfficeText(tsText, doc) {
  const source = doc.rendered.length > 0 ? doc.rendered : doc.units;
  const renderingMeasured = doc.rendered.length > 0;
  const capabilityBody = source.slice().sort((a, b) => a.unit - b.unit).map((u) => u.text.trim()).filter(Boolean).join("\n\n");
  const tsCount = nonSpace(tsText);
  const capCount = nonSpace(capabilityBody);
  const coverage = measureContentCoverage(tsText, capabilityBody);
  const capStructure = countStructureFacts(capabilityBody);
  const tsStructure = countStructureFacts(tsText);
  const promote = capCount > 0 && coverage.lostTokens.length === 0 && (coverage.newTokens > 0 || coverage.groupedLines > 0 || structureTotal(capStructure) > structureTotal(tsStructure));
  const failedUnits = [...doc.unitsFailed, ...doc.unitsEmpty].filter((u, i, a) => a.indexOf(u) === i).sort((a, b) => a - b);
  const failureReasons = unitFailureReasons(doc);
  const parts = [
    `document capability ${DOCUMENT_PARSE_CAPABILITY} (${doc.engine})`,
    `body: ${officeBodyDecision(promote, coverage, doc.engine, capCount, tsCount, renderingMeasured, capStructure, tsStructure)}`,
    // Which engine's bytes the reader is actually looking at. The Python renderer and the TS
    // office reader phrase some headers almost identically, so a note that only names the
    // CANDIDATE engine cannot prove which body was delivered. This token is checkable.
    `body_source: ${promote ? `capability:${doc.engine}` : "ts:office-reader"}`,
    `units: ${doc.unitsSucceeded.length} of ${doc.unitsTotal} read`
  ];
  if (failedUnits.length) parts.push(`failed units: ${failedUnits.join(", ")}`);
  if (failureReasons.length) parts.push(`unit failures: ${failureReasons.join(" | ")}`);
  if (coverage.lostLines > 0) {
    parts.push(`${coverage.lostLines} TS content line(s) were not carried by the capability reader`);
  }
  if (!promote && doc.unitsFailed.length) {
    parts.push(
      `the TS body may carry unverified content for the unit(s) the capability reader reported as failed (${doc.unitsFailed.join(", ")}); treat those units as unconfirmed`
    );
  }
  if (doc.rendered.some((u) => u.truncated)) {
    parts.push("a capability rendering hit its per-unit character cap; the block list still carries every block");
  }
  if (!doc.ocr.ran && doc.ocrUnits.length) parts.push(`OCR did not run: ${doc.ocr.reason || "no reason reported"}`);
  if (doc.ocr.ran) parts.push(`${doc.ocr.recognized} unit(s) recognised by OCR: ${doc.ocr.summary}`);
  if (doc.ocr.ran) {
    const engineNote = ocrEngineNote(doc.ocr);
    if (engineNote) parts.push(engineNote);
  }
  const coverageNote = `[${parts.join("; ")}]`;
  const body = promote ? capabilityBody : tsText;
  let refusal = "";
  let honestEmpty = false;
  if (!body.trim()) {
    if (doc.unitsFailed.length) {
      refusal = `no engine produced text for this file - the capability reader could not read unit(s) ${doc.unitsFailed.join(", ")}${failureReasons.length ? ` (${failureReasons.join(" | ")})` : ""}, and the TS reader produced nothing. Re-save the file from the application that wrote it, or send the affected page/sheet as an image so the vision model can read it.`;
    } else {
      honestEmpty = doc.unitsTotal > 0 && [...doc.unitsEmpty, ...doc.unitsFailed].length >= doc.unitsTotal;
    }
  }
  return {
    // The coverage statement is part of the delivered text in BOTH branches: a reader that
    // says "1 of 3 sheets read" must say it where the model sees it, not only in a side field.
    text: [coverageNote, "", body].join("\n"),
    pages: doc.unitsTotal,
    readUnits: doc.unitsSucceeded,
    unreadUnits: failedUnits.filter((u) => !doc.unitsSucceeded.includes(u)),
    readBy: Object.fromEntries(doc.unitsSucceeded.map((u) => [u, promote ? "capability-text-layer" : "ts-text-layer"])),
    coverageNote,
    refusal,
    honestEmpty,
    unitFailures: failureReasons,
    bodyEngine: promote ? "capability" : "ts"
  };
}
function capabilityBlockerLine(outcome) {
  const step = outcome.humanStep ? ` - ${outcome.humanStep}` : "";
  return `the document capability backend also refused (${outcome.reason}): ${outcome.message}${step}`;
}

// D:/Projects/WebUI/WebUI/lib/server/extract/sniff.ts
function sniffMagic(head) {
  if (head.length >= 5 && head.subarray(0, 5).toString("latin1") === "%PDF-") {
    return { category: "pdf", strong: true };
  }
  if (head.length >= 4 && head.readUInt32LE(0) === 3759263696) {
    return { category: "legacy", strong: true };
  }
  if (head.length >= 5 && head.subarray(0, 5).toString("latin1") === "{\\rtf") {
    return { category: "rtf", strong: true };
  }
  if (head.length >= 8 && head[0] === 137 && head[1] === 80 && head[2] === 78 && head[3] === 71) {
    return { category: "image", strong: true };
  }
  if (head.length >= 6 && ["GIF87a", "GIF89a"].includes(head.subarray(0, 6).toString("latin1"))) {
    return { category: "image", strong: true };
  }
  if (head.length >= 3 && head[0] === 255 && head[1] === 216 && head[2] === 255) {
    return { category: "image", strong: true };
  }
  if (head.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") {
    return { category: "image", strong: true };
  }
  if (head.length >= 4 && head.subarray(0, 2).toString("latin1") === "BM") {
    return { category: "image", strong: true };
  }
  if (head.length >= 4 && head[0] === 80 && head[1] === 75 && (head[2] === 3 || head[2] === 5 || head[2] === 7) && (head[3] === 4 || head[3] === 6 || head[3] === 8)) {
    return { category: "archive", strong: false };
  }
  if (head.length >= 12 && head.subarray(4, 8).toString("latin1") === "ftyp") {
    return { category: "video", strong: false };
  }
  if (head.length >= 4 && head.subarray(0, 4).toString("latin1") === "OggS") {
    return { category: "audio", strong: false };
  }
  if (head.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WAVE") {
    return { category: "audio", strong: true };
  }
  if (head.length >= 4 && (head[0] === 73 && head[1] === 68 && head[2] === 51)) {
    return { category: "audio", strong: true };
  }
  if (head.length >= 2 && head[0] === 255 && (head[1] & 224) === 224) {
    return { category: "audio", strong: true };
  }
  return null;
}

// D:/Projects/WebUI/WebUI/lib/server/extract/ffmpeg.ts
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_path3 = __toESM(require("node:path"));
var import_node_child_process2 = require("node:child_process");
var import_node_util2 = require("node:util");
var import_node_crypto3 = require("node:crypto");
var execFileP2 = (0, import_node_util2.promisify)(import_node_child_process2.execFile);
var TMP_DIR2 = import_node_path3.default.join(process.cwd(), ".data", "tmp");
var VIDEO_FRAMES = 2;
var MAX_IMAGE_SIDE = 1280;
var ffmpegPathPromise = null;
function ffmpegPath() {
  if (!ffmpegPathPromise) {
    ffmpegPathPromise = (async () => {
      const mod = await import("ffmpeg-static");
      const p = typeof mod === "string" ? mod : mod?.default ?? null;
      if (!p || !import_node_fs2.default.existsSync(p)) {
        throw new Error("Bundled ffmpeg binary is missing \u2014 run `npm install`");
      }
      return p;
    })().catch((err) => {
      ffmpegPathPromise = null;
      throw err;
    });
  }
  return ffmpegPathPromise;
}
function tmpName2(ext) {
  import_node_fs2.default.mkdirSync(TMP_DIR2, { recursive: true });
  return import_node_path3.default.join(TMP_DIR2, "m_" + (0, import_node_crypto3.randomBytes)(6).toString("hex") + ext);
}
async function probeInfo(src, opts = {}) {
  const ff = await ffmpegPath();
  try {
    const { stderr } = await execFileP2(ff, ["-i", src], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      // I15: NO ffmpeg call may hang forever — a wedged probe used to pin an
      // upload (and its client request) indefinitely. The probe answers in
      // milliseconds even when it fails; 20 s is generous for a locked file.
      timeout: opts.timeoutMs ?? 2e4,
      ...opts.signal ? { signal: opts.signal } : {}
    });
    return stderr;
  } catch (err) {
    return String(err?.stderr ?? err?.message ?? "");
  }
}
function parseDuration(stderr) {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3]);
}
async function runFFmpeg(args, opts = {}) {
  const ff = await ffmpegPath();
  const { stdout } = await execFileP2(ff, args, {
    encoding: "buffer",
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    // I15: bounded + abortable like every other ffmpeg invocation.
    timeout: opts.timeoutMs ?? 12e4,
    ...opts.signal ? { signal: opts.signal } : {}
  });
  return stdout;
}
var SCALE_FILTER = `scale=w=min(iw\\,${MAX_IMAGE_SIDE}):h=min(ih\\,${MAX_IMAGE_SIDE}):force_original_aspect_ratio=decrease,format=rgb24`;
function toDataUrl(png) {
  return "data:image/png;base64," + png.toString("base64");
}
var MAX_IMAGE_PAGES = 8;
async function imageToDataUrlFromPath(src, opts = {}) {
  const base = tmpName2("");
  const pattern = base + "_%03d.png";
  const written = [];
  try {
    await runFFmpeg(
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        src,
        "-frames:v",
        String(MAX_IMAGE_PAGES),
        "-vf",
        SCALE_FILTER,
        "-vsync",
        "vfr",
        pattern
      ],
      { timeoutMs: 6e4, ...opts.signal ? { signal: opts.signal } : {} }
    );
    for (let i = 1; i <= MAX_IMAGE_PAGES; i++) {
      const p = `${base}_${String(i).padStart(3, "0")}.png`;
      if (import_node_fs2.default.existsSync(p) && import_node_fs2.default.statSync(p).size > 0) written.push(p);
      else break;
    }
    if (!written.length) throw new Error("Could not decode this image");
    const dataUrl = toDataUrl(import_node_fs2.default.readFileSync(written[0]));
    const frames = written.slice(1).map((p, i) => ({
      dataUrl: toDataUrl(import_node_fs2.default.readFileSync(p)),
      at: i + 2
      // page number of this frame (page 1 is `dataUrl`)
    }));
    return { dataUrl, ...frames.length ? { frames } : {}, pages: written.length };
  } finally {
    try {
      const dir = import_node_path3.default.dirname(base);
      const stem = import_node_path3.default.basename(base);
      for (const f of import_node_fs2.default.readdirSync(dir)) {
        if (f.startsWith(stem)) import_node_fs2.default.rmSync(import_node_path3.default.join(dir, f), { force: true });
      }
    } catch {
    }
  }
}
async function videoFramesFromPath(src, opts = {}) {
  const out = tmpName2(".png");
  try {
    const duration = parseDuration(await probeInfo(src, opts));
    const marks = duration > 0 ? [duration * 0.2, duration * 0.7].slice(0, VIDEO_FRAMES) : [0, 2, 5].slice(0, VIDEO_FRAMES);
    const frames = [];
    for (const at of marks) {
      if (opts.signal?.aborted) break;
      try {
        await runFFmpeg(
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            at.toFixed(3),
            "-i",
            src,
            "-frames:v",
            "1",
            "-vf",
            SCALE_FILTER,
            out
          ],
          { timeoutMs: 6e4, ...opts.signal ? { signal: opts.signal } : {} }
        );
        if (import_node_fs2.default.existsSync(out) && import_node_fs2.default.statSync(out).size > 0) {
          frames.push({ dataUrl: toDataUrl(import_node_fs2.default.readFileSync(out)), at: Math.round(at * 100) / 100 });
          import_node_fs2.default.rmSync(out, { force: true });
        }
      } catch {
      }
    }
    if (!frames.length) throw new Error("Could not read any frames from the video");
    return { frames, durationSec: duration };
  } finally {
    try {
      import_node_fs2.default.rmSync(out, { force: true });
    } catch {
    }
  }
}
var MAX_KEYFRAMES = 150;
async function videoKeyframesFromPath(src, outDir, opts = {}) {
  const cap2 = Math.max(2, opts.maxFrames ?? MAX_KEYFRAMES);
  import_node_fs2.default.mkdirSync(outDir, { recursive: true });
  const ff = await ffmpegPath();
  const duration = parseDuration(await probeInfo(src, opts));
  const frames = [];
  const frameName = (n) => `f_${String(n).padStart(5, "0")}.jpg`;
  let stderr = "";
  if (!opts.signal?.aborted) {
    for (const pre of [
      ["-hwaccel", "auto", "-skip_frame", "nokey"],
      ["-skip_frame", "nokey"],
      []
    ]) {
      try {
        const r = await execFileP2(
          ff,
          [
            "-hide_banner",
            "-y",
            ...pre,
            "-i",
            src,
            "-vf",
            `select='gt(scene,0.3)',showinfo,${SCALE_FILTER}`,
            "-vsync",
            "vfr",
            "-frames:v",
            String(cap2),
            "-f",
            "image2",
            import_node_path3.default.join(outDir, "f_%05d.jpg")
          ],
          {
            encoding: "utf8",
            maxBuffer: 32 * 1024 * 1024,
            // I15: the full-decode fallback on a 6 h video can legitimately
            // run long, but it must never hang forever: 20 min bounds a
            // wedged pass, and an aborted caller kills the process instead.
            timeout: 12e5,
            ...opts.signal ? { signal: opts.signal } : {}
          }
        );
        stderr = r.stderr;
        break;
      } catch (err) {
        if (opts.signal?.aborted) break;
        stderr = String(err?.stderr ?? "");
        try {
          for (const f of import_node_fs2.default.readdirSync(outDir)) {
            if (/^f_\d+\.jpg$/.test(f)) import_node_fs2.default.rmSync(import_node_path3.default.join(outDir, f), { force: true });
          }
        } catch {
        }
      }
    }
  }
  const times = [...stderr.matchAll(/pts_time:(\d+(?:\.\d+)?)/g)].map((m) => parseFloat(m[1]));
  for (let i = 0; i < times.length; i++) {
    const name = frameName(i + 1);
    if (import_node_fs2.default.existsSync(import_node_path3.default.join(outDir, name))) frames.push({ at: times[i], name });
  }
  const coveredUntil = frames.reduce((m, f) => Math.max(m, f.at), 0);
  if (duration > 0 && frames.length && coveredUntil < duration - 90) {
    const seekBudget = Math.min(cap2, Math.ceil(duration / 120));
    const keepScenes = Math.max(2, Math.min(frames.length, cap2 - seekBudget));
    if (keepScenes < frames.length) {
      const step = Math.ceil(frames.length / keepScenes);
      const kept = frames.filter((_, i) => i % step === 0 || i === frames.length - 1);
      for (const f of frames) {
        if (kept.includes(f)) continue;
        try {
          import_node_fs2.default.rmSync(import_node_path3.default.join(outDir, f.name), { force: true });
        } catch {
        }
      }
      kept.forEach((f, i) => {
        const nn = frameName(i + 1);
        if (f.name !== nn) {
          try {
            import_node_fs2.default.renameSync(import_node_path3.default.join(outDir, f.name), import_node_path3.default.join(outDir, nn));
          } catch {
          }
          f.name = nn;
        }
      });
      frames.length = 0;
      frames.push(...kept);
    }
  }
  let seq = frames.length;
  const grab = async (t) => {
    const name = frameName(seq + 1);
    try {
      await execFileP2(
        ff,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-ss",
          t.toFixed(3),
          "-i",
          src,
          "-frames:v",
          "1",
          "-vf",
          SCALE_FILTER,
          import_node_path3.default.join(outDir, name)
        ],
        { encoding: "utf8", timeout: 6e4, ...opts.signal ? { signal: opts.signal } : {} }
      );
      if (import_node_fs2.default.existsSync(import_node_path3.default.join(outDir, name)) && import_node_fs2.default.statSync(import_node_path3.default.join(outDir, name)).size > 0) {
        frames.push({ at: t, name });
        seq++;
      }
    } catch {
    }
  };
  for (let t = 60; t < duration && frames.length < cap2; t += 120) {
    if (opts.signal?.aborted) break;
    if (frames.some((f) => Math.abs(f.at - t) < 60)) continue;
    await grab(t);
  }
  if (duration > 0 && frames.length && frames[frames.length - 1].at < duration - 90 && frames.length < cap2) {
    await grab(Math.max(0, duration - 30));
  }
  return frames;
}
async function decodeAudioPcmFile(src, opts = {}) {
  const out = tmpName2(".f32");
  try {
    const ff = await ffmpegPath();
    await execFileP2(
      ff,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        src,
        "-f",
        "f32le",
        "-ac",
        "1",
        "-ar",
        "16000",
        out
      ],
      { timeout: 6e5, ...opts.signal ? { signal: opts.signal } : {} }
    );
    if (!import_node_fs2.default.existsSync(out) || import_node_fs2.default.statSync(out).size === 0) {
      throw new Error("Audio decoded to nothing");
    }
    return { file: out, samples: Math.floor(import_node_fs2.default.statSync(out).size / 4) };
  } catch (err) {
    try {
      import_node_fs2.default.rmSync(out, { force: true });
    } catch {
    }
    throw err;
  }
}
function readPcmRange(file, fromSample, toSample) {
  const b0 = Math.max(0, Math.floor(fromSample)) * 4;
  const size = import_node_fs2.default.statSync(file).size;
  const b1 = Math.min(size, Math.max(b0, Math.floor(toSample) * 4));
  const fd = import_node_fs2.default.openSync(file, "r");
  try {
    const buf = Buffer.alloc(b1 - b0);
    let off = 0;
    while (off < buf.length) off += import_node_fs2.default.readSync(fd, buf, off, buf.length - off, b0 + off);
    return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  } finally {
    import_node_fs2.default.closeSync(fd);
  }
}

// D:/Projects/WebUI/WebUI/lib/server/extract/audio.ts
var import_node_fs5 = __toESM(require("node:fs"));
var import_node_path6 = __toESM(require("node:path"));
var import_node_child_process3 = require("node:child_process");
var import_node_util3 = require("node:util");

// D:/Projects/WebUI/WebUI/lib/server/logger.ts
var import_pino = __toESM(require("pino"));
var import_pino_pretty = __toESM(require("pino-pretty"));
var isProd = process.env.NODE_ENV === "production";
var level = process.env.LOG_LEVEL ?? (isProd ? "info" : "debug");
var options = {
  level,
  timestamp: import_pino.default.stdTimeFunctions.isoTime,
  base: void 0
  // drop pid/hostname — this is a single local process
};
var destination = isProd ? void 0 : (0, import_pino_pretty.default)({
  colorize: true,
  translateTime: "SYS:HH:MM:ss.l",
  ignore: "pid,hostname",
  singleLine: true
});
var logger = (0, import_pino.default)(options, destination);
function childLogger(name) {
  return logger.child({ name });
}

// D:/Projects/WebUI/WebUI/lib/server/settings.ts
var import_node_fs3 = __toESM(require("node:fs"));
var import_node_path4 = __toESM(require("node:path"));
var SETTINGS_FILE = import_node_path4.default.join(process.cwd(), "settings.json");
var DOTENV_FILE = import_node_path4.default.join(process.cwd(), ".env.local");
var LLM_FALLBACK = "http://127.0.0.1:8080/v1/chat/completions";
var LLM_KEY_FALLBACK = "no-key";
var ENV_CONTROL_ORIGIN = "RUKE_LLM_ENDPOINT";
var ENV_UNLOAD_URL = "LLM_UNLOAD_URL";
var ENV_RELOAD_URL = "LLM_RELOAD_URL";
var ENV_LIFECYCLE_BASE = "RUKE_LIFECYCLE_BASE";
var ENV_PROVIDER = "RUKE_LLM_PROVIDER";
var ENV_MODEL = "RUKE_LLM_MODEL";
var ENV_AUTOMATIC_HANDOFF = "RUKE_LLM_AUTOMATIC_HANDOFF";
var ENV_LEGACY_ALLOW_UNLOAD = "RUKE_OCR_ALLOW_UNLOAD";
var cachedMtimeMs = null;
var cachedData = {};
function readSettings() {
  let mtimeMs;
  try {
    mtimeMs = import_node_fs3.default.statSync(SETTINGS_FILE).mtimeMs;
  } catch {
    if (cachedMtimeMs !== null) {
      cachedMtimeMs = null;
      cachedData = {};
    }
    return cachedData;
  }
  if (mtimeMs !== cachedMtimeMs) {
    try {
      cachedData = JSON.parse(import_node_fs3.default.readFileSync(SETTINGS_FILE, "utf8"));
    } catch {
      mtimeMs = cachedMtimeMs;
    }
    cachedMtimeMs = mtimeMs;
  }
  return cachedData;
}
var dotenvMtimeMs = null;
var dotenvData = {};
function readDotenv() {
  let mtimeMs;
  try {
    mtimeMs = import_node_fs3.default.statSync(DOTENV_FILE).mtimeMs;
  } catch {
    if (dotenvMtimeMs !== null) {
      dotenvMtimeMs = null;
      dotenvData = {};
    }
    return dotenvData;
  }
  if (mtimeMs !== dotenvMtimeMs) {
    try {
      const parsed = {};
      for (const raw of import_node_fs3.default.readFileSync(DOTENV_FILE, "utf8").split(/\r?\n/)) {
        let line = raw.trim();
        if (!line || line.startsWith("#") || !line.includes("=")) continue;
        if (line.toLowerCase().startsWith("export ")) line = line.slice("export ".length).trim();
        const eq = line.indexOf("=");
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
          value = value.slice(1, -1).trim();
        }
        if (key && value) parsed[key] = value;
      }
      dotenvData = parsed;
    } catch {
      return dotenvData;
    }
    dotenvMtimeMs = mtimeMs;
  }
  return dotenvData;
}
function resolveLayer(settingsValue, envName) {
  if (typeof settingsValue === "string" && settingsValue.trim()) {
    return { value: settingsValue.trim(), source: `settings.json(${envName})` };
  }
  const fromEnv = process.env[envName];
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    return { value: fromEnv.trim(), source: `process.env(${envName})` };
  }
  const fromFile = readDotenv()[envName];
  if (typeof fromFile === "string" && fromFile.trim()) {
    return { value: fromFile.trim(), source: `.env.local(${envName})` };
  }
  return null;
}
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
function readBool(name) {
  const got = resolveLayer(void 0, name);
  if (!got) return null;
  const raw = got.value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return null;
}
function llmApiUrl() {
  return resolveLayer(readSettings().llm_api_url, "LLM_API_URL")?.value ?? LLM_FALLBACK;
}
function llmApiKey() {
  return resolveLayer(readSettings().llm_api_key, "LLM_API_KEY")?.value ?? LLM_KEY_FALLBACK;
}
function providerConfig() {
  const settings = readSettings();
  const source = {};
  const chat = resolveLayer(settings.llm_api_url, "LLM_API_URL");
  const chatUrl = chat?.value ?? LLM_FALLBACK;
  source.chatUrl = chat?.source ?? "fallback(LLM_API_URL)";
  const key = resolveLayer(settings.llm_api_key, "LLM_API_KEY");
  const apiKey = key?.value ?? LLM_KEY_FALLBACK;
  source.apiKey = key?.source ?? "fallback(LLM_API_KEY)";
  const pinned = resolveLayer(void 0, ENV_CONTROL_ORIGIN);
  const derived = originOf(chatUrl);
  const controlOrigin = pinned ? pinned.value.replace(/\/+$/, "") : derived ?? (originOf(LLM_FALLBACK) ?? "http://127.0.0.1:8080");
  source.controlOrigin = pinned ? pinned.source : derived ? `derived-from-chatUrl(${source.chatUrl})` : "fallback(chat url is not an absolute URL)";
  const unload = resolveLayer(void 0, ENV_UNLOAD_URL);
  const reload = resolveLayer(void 0, ENV_RELOAD_URL);
  const base = resolveLayer(void 0, ENV_LIFECYCLE_BASE);
  const lifecycleBase = base ? base.value.replace(/\/+$/, "") : "";
  const anchor = lifecycleBase || controlOrigin;
  source.lifecycleBase = base ? `${base.source} (path prefix preserved)` : "unset(append to the control origin, which preserves the root-mounted lifecycle endpoints this deployment serves)";
  const anchorSource = lifecycleBase ? source.lifecycleBase : source.controlOrigin;
  const unloadUrl = unload?.value ?? `${anchor}/unload`;
  const reloadUrl = reload?.value ?? `${anchor}/load`;
  source.unloadUrl = unload?.source ?? `derived(${anchorSource})`;
  source.reloadUrl = reload?.source ?? `derived(${anchorSource})`;
  const providerHint = resolveLayer(void 0, ENV_PROVIDER)?.value ?? "";
  const modelId = resolveLayer(void 0, ENV_MODEL)?.value ?? "";
  const configured = readBool(ENV_AUTOMATIC_HANDOFF);
  const legacy = readBool(ENV_LEGACY_ALLOW_UNLOAD);
  const automaticHandoff = configured ?? legacy ?? true;
  source.automaticHandoff = (configured !== null ? resolveLayer(void 0, ENV_AUTOMATIC_HANDOFF)?.source : legacy !== null ? resolveLayer(void 0, ENV_LEGACY_ALLOW_UNLOAD)?.source : void 0) ?? "default(true: only ever used when the job does not fit and the provider supports lifecycle calls)";
  return {
    chatUrl,
    apiKey,
    controlOrigin,
    lifecycleBase,
    unloadUrl,
    reloadUrl,
    lifecycleExplicit: Boolean(unload || reload),
    providerHint,
    modelId,
    automaticHandoff,
    handoffSource: source.automaticHandoff,
    configSource: source
  };
}

// D:/Projects/WebUI/WebUI/lib/server/resource-identity.ts
var LOOPBACK_ALIASES = /* @__PURE__ */ new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "ip6-localhost",
  "ip6-loopback",
  "host.docker.internal"
]);
function resourceKey(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return "raw:" + rawUrl.trim().toLowerCase();
  }
  const scheme = u.protocol === "https:" ? "https" : "http";
  let host = u.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (LOOPBACK_ALIASES.has(host)) host = "127.0.0.1";
  const implicitPort = scheme === "http" ? "80" : "443";
  const port = u.port && u.port !== implicitPort ? `:${u.port}` : "";
  return `${scheme}://${host}${port}`;
}

// D:/Projects/WebUI/WebUI/lib/server/upstream-bridge.ts
var log = childLogger("upstream-bridge");
var MAX_WAITERS = 4;
var UpstreamBusyError = class extends Error {
  constructor() {
    super("Model endpoint is busy; please retry.");
    this.name = "UpstreamBusyError";
  }
};
var UpstreamTimeoutError = class extends Error {
  constructor(ms) {
    super(`Upstream deadline of ${ms}ms expired`);
    this.name = "UpstreamTimeoutError";
  }
};
function abortError() {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}
function isAbortLike(e) {
  const name = e?.name;
  return name === "AbortError" || name === "TimeoutError";
}
function startLifecycle(external, timeoutMs) {
  if (!external && timeoutMs === void 0) {
    return { signal: void 0, endReason: () => "", dispose: () => {
    } };
  }
  const ctrl = new AbortController();
  let reason = "";
  let timer;
  let offExternal;
  const fire = (r) => {
    if (reason !== "") return;
    reason = r;
    ctrl.abort(r === "timeout" ? new UpstreamTimeoutError(timeoutMs ?? 0) : external?.reason ?? r);
  };
  if (external) {
    if (external.aborted) fire("caller");
    else {
      const onAbort = () => fire("caller");
      external.addEventListener("abort", onAbort, { once: true });
      offExternal = () => external.removeEventListener("abort", onAbort);
    }
  }
  if (timeoutMs !== void 0 && timeoutMs >= 0 && reason === "") {
    timer = setTimeout(() => fire("timeout"), timeoutMs);
  }
  return {
    signal: ctrl.signal,
    endReason: () => reason,
    dispose: () => {
      if (timer !== void 0) {
        clearTimeout(timer);
        timer = void 0;
      }
      if (offExternal) {
        offExternal();
        offExternal = void 0;
      }
    }
  };
}
function outcomeOf(e, lc) {
  if (e instanceof UpstreamBusyError) return "saturated";
  if (e instanceof UpstreamTimeoutError || lc.endReason() === "timeout") return "deadline";
  if (isAbortLike(e) || lc.endReason() === "caller") return "caller-abort";
  return "upstream";
}
function raceBody(read, res, lc) {
  if (!lc.signal) return read;
  const signal = lc.signal;
  return new Promise((resolve, reject) => {
    const lose = () => {
      try {
        void res.body?.cancel().catch(() => void 0);
      } catch {
      }
      reject(signal.reason ?? abortError());
    };
    if (signal.aborted) {
      lose();
      return;
    }
    signal.addEventListener("abort", lose, { once: true });
    read.then(
      (value) => {
        signal.removeEventListener("abort", lose);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", lose);
        reject(err);
      }
    );
  });
}
function sameResourceAsConfigured(candidate) {
  return resourceKey(candidate) === resourceKey(llmApiUrl());
}
function credentialFor(resKey) {
  if (resKey === resourceKey(llmApiUrl())) return llmApiKey();
  const own = process.env.WEB_SEARCH_LLM_API_KEY?.trim();
  return own || void 0;
}
var LocalUpstreamAdmission = class {
  constructor() {
    this.active = false;
    this.queue = [];
  }
  get inFlight() {
    return this.active;
  }
  get queued() {
    return this.queue.length;
  }
  acquire(signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (!this.active) {
      this.active = true;
      return Promise.resolve(this.makeRelease());
    }
    if (this.queue.length >= MAX_WAITERS) return Promise.reject(new UpstreamBusyError());
    return new Promise((resolve, reject) => {
      const w = { settled: false, grant: resolve };
      this.queue.push(w);
      if (signal) {
        const onAbort = () => {
          if (w.settled) return;
          w.settled = true;
          const i = this.queue.indexOf(w);
          if (i >= 0) this.queue.splice(i, 1);
          reject(abortError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        w.off = () => signal.removeEventListener("abort", onAbort);
      }
    });
  }
  makeRelease() {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      while (this.queue.length) {
        const next = this.queue.shift();
        if (!next.settled) {
          next.settled = true;
          next.off?.();
          next.off = void 0;
          next.grant(this.makeRelease());
          return;
        }
      }
      this.active = false;
    };
  }
};
var localAdmissions = /* @__PURE__ */ new Map();
function admissionForResource(resKey) {
  let a = localAdmissions.get(resKey);
  if (!a) {
    a = new LocalUpstreamAdmission();
    localAdmissions.set(resKey, a);
  }
  return a;
}
async function acquireFor(resKey, lc) {
  const release = await admissionForResource(resKey).acquire(lc.signal);
  return { release, releaseEarly: lc.signal?.aborted === true };
}
async function sharedUpstreamCompletion(o) {
  if (o.body.stream === true) {
    throw new Error("sharedUpstreamCompletion: stream:true must use sharedUpstreamStream");
  }
  const abortOutcome = (e) => {
    if (isAbortLike(e) && o.throwOnAbort && o.signal?.aborted) throw e;
    return null;
  };
  const lc = startLifecycle(o.signal, o.timeoutMs);
  try {
    if (lc.signal?.aborted) return abortOutcome(lc.signal.reason ?? abortError());
    const configured = !o.targetUrl || sameResourceAsConfigured(o.targetUrl);
    if (rustEnabled() && configured) {
      const payload = { ...o.body };
      if (o.timeoutMs !== void 0) payload.timeout_ms = o.timeoutMs;
      const res = await fetch(`${rustBaseUrl()}/api/ruke/internal/completion`, {
        method: "POST",
        headers: { "content-type": "application/json", ...internalSecretHeaders() },
        body: JSON.stringify(payload),
        signal: lc.signal
      });
      if (res.status === 401 || res.status === 403) {
        log.error({ label: o.label }, "internal completion bridge refused (secret mismatch?)");
        return null;
      }
      const json = await raceBody(res.json().catch(() => null), res, lc);
      return { status: res.status, json };
    }
    const resKey = configured ? resourceKey(llmApiUrl()) : resourceKey(o.targetUrl);
    let release;
    try {
      const grant = await acquireFor(resKey, lc);
      release = grant.release;
      if (grant.releaseEarly) {
        release();
        release = void 0;
        return abortOutcome(lc.signal?.reason ?? abortError());
      }
    } catch (e) {
      const outcome = outcomeOf(e, lc);
      if (outcome === "saturated") {
        log.warn({ label: o.label, outcome }, "local queue full; degrading");
      } else if (outcome === "deadline") {
        log.warn({ label: o.label, outcome, timeoutMs: o.timeoutMs }, "deadline expired while queued");
      }
      return abortOutcome(e);
    }
    try {
      const cred = credentialFor(resKey);
      const headers = { "content-type": "application/json" };
      if (cred) headers.Authorization = "Bearer " + cred;
      const res = await fetch(o.targetUrl ?? llmApiUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify(o.body),
        // The lifecycle signal, not a post-acquisition one: an abort or a
        // deadline that fires mid-body now reaches the transport.
        signal: lc.signal
      });
      const json = await raceBody(res.json().catch(() => null), res, lc);
      return { status: res.status, json };
    } finally {
      release?.();
    }
  } catch (e) {
    const outcome = outcomeOf(e, lc);
    if (isAbortLike(e) || e instanceof UpstreamTimeoutError) {
      if (outcome === "deadline") {
        log.warn(
          { label: o.label, outcome, timeoutMs: o.timeoutMs, err: e?.message },
          "upstream deadline expired"
        );
      }
      return abortOutcome(e);
    }
    log.warn(
      { label: o.label, outcome, err: e?.message },
      outcome === "deadline" ? "upstream deadline expired" : "upstream unreachable"
    );
    return null;
  } finally {
    lc.dispose();
  }
}

// D:/Projects/WebUI/WebUI/lib/lifecycle/ownedResource.ts
function parseIdleTtl(raw, fallback) {
  if (raw === void 0 || raw === null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "") return fallback;
  if (v === "off" || v === "none" || v === "never" || v === "-1") return -1;
  if (v === "0" || v === "now" || v === "immediate") return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}
function idleReleaseDecision(args) {
  const { now, lastUsed, inFlight, idleTtlMs, resident, force } = args;
  if (!resident) return { action: "none", delayMs: 0 };
  if (inFlight > 0) return { action: "none", delayMs: 0 };
  if (force) return { action: "release", delayMs: 0 };
  if (idleTtlMs < 0) return { action: "none", delayMs: 0 };
  const due = lastUsed + idleTtlMs;
  if (now >= due) return { action: "release", delayMs: 0 };
  return { action: "arm", delayMs: due - now };
}
function defaultSetTimer(cb, ms) {
  const t = setTimeout(cb, ms);
  try {
    t.unref?.();
  } catch {
  }
  return { cancel: () => clearTimeout(t) };
}
function reasonOf(e) {
  if (e instanceof Error) return e.message;
  return String(e);
}
var OwnedResource = class {
  constructor(opts) {
    this.opts = opts;
    this.value = null;
    this.hasValue = false;
    this.creating = null;
    this.releasing = null;
    this.inFlight = 0;
    this.lastUsed = 0;
    this.failures = 0;
    this.closed = false;
    this.timer = null;
    this.generation = 0;
    /** Shutdown happened while a lease was live; the last lease out tears down. */
    this.pendingClose = false;
  }
  now() {
    return this.opts.now ? this.opts.now() : Date.now();
  }
  emit(kind, reason) {
    try {
      this.opts.onEvent?.({ name: this.opts.name, kind, failures: this.failures, reason });
    } catch {
    }
  }
  clearTimer() {
    if (!this.timer) return;
    try {
      this.timer.cancel();
    } catch {
    }
    this.timer = null;
  }
  /** Run `fn` with the resource, holding one lease for its whole duration. */
  async use(fn) {
    if (this.closed) throw new Error(`${this.opts.name}: resource has been shut down`);
    this.inFlight++;
    this.lastUsed = this.now();
    this.clearTimer();
    try {
      const value = await this.ensure();
      this.lastUsed = this.now();
      return await fn(value);
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.lastUsed = this.now();
      if (this.closed && this.inFlight === 0) {
        void this.teardown("closed during lease").catch(() => {
        });
      } else {
        this.schedule();
      }
    }
  }
  async ensure() {
    while (this.releasing) {
      try {
        await this.releasing;
      } catch {
      }
    }
    if (this.hasValue) return this.value;
    if (this.creating) return this.creating;
    const generation = this.generation;
    const pending = (async () => {
      try {
        const created = await this.opts.create();
        if (generation !== this.generation || this.closed) {
          await this.destroyQuietly(created, "invalidated while starting");
          throw new Error(`${this.opts.name}: invalidated while starting`);
        }
        this.value = created;
        this.hasValue = true;
        this.failures = 0;
        this.emit("created");
        try {
          this.opts.onCreated?.(created);
        } catch {
        }
        return created;
      } catch (e) {
        if (generation === this.generation && !this.closed) {
          this.failures++;
          this.emit("create_failed", reasonOf(e));
        }
        throw e;
      } finally {
        if (generation === this.generation) this.creating = null;
      }
    })();
    this.creating = pending;
    return pending;
  }
  /** Returns true only when a teardown actually ran and did not throw. */
  async destroyQuietly(value, reason) {
    if (typeof this.opts.destroy === "function") {
      try {
        await this.opts.destroy(value);
        return true;
      } catch (e) {
        this.emit("destroy_failed", `${reason}: ${reasonOf(e)}`);
      }
    } else {
      this.emit("no_destroy_api", reason);
    }
    return false;
  }
  /** Destroy whatever is held, exactly once. Returns false if nothing was held. */
  async teardown(reason) {
    if (!this.hasValue) return false;
    this.generation++;
    const victim = this.value;
    this.value = null;
    this.hasValue = false;
    this.creating = null;
    const run = (async () => {
      if (await this.destroyQuietly(victim, reason)) this.emit("released", reason);
    })();
    this.releasing = run;
    try {
      await run;
    } finally {
      if (this.releasing === run) this.releasing = null;
    }
    return true;
  }
  /**
   * External invalidation: the resource died on its own (Chromium's
   * "disconnected", an ONNX session that errored out). The slot drops
   * immediately so the NEXT use creates a fresh one; the dead object is not
   * destroyed (it is already gone).
   */
  discard(reason = "invalidated") {
    this.generation++;
    this.value = null;
    this.hasValue = false;
    this.creating = null;
    this.clearTimer();
    this.emit("discarded", reason + (this.inFlight > 0 ? " (held)" : ""));
  }
  /**
   * Reclaim the resource if the law allows it. Returns true only when this call
   * actually owned and destroyed it. `force` (explicit shutdown/pressure) skips
   * the TTL but still never destroys a resource that is in use.
   */
  async releaseIdle(opts = {}) {
    const now = opts.now ?? this.now();
    const decision = idleReleaseDecision({
      now,
      lastUsed: this.lastUsed,
      inFlight: this.inFlight,
      idleTtlMs: this.opts.idleTtlMs,
      resident: this.hasValue,
      force: opts.force
    });
    if (decision.action !== "release") return false;
    this.clearTimer();
    return this.teardown("idle release");
  }
  schedule() {
    const decision = idleReleaseDecision({
      now: this.now(),
      lastUsed: this.lastUsed,
      inFlight: this.inFlight,
      idleTtlMs: this.opts.idleTtlMs,
      resident: this.hasValue
    });
    if (decision.action === "none") {
      this.clearTimer();
      return;
    }
    if (decision.action === "release") {
      this.clearTimer();
      void this.releaseIdle().catch(() => {
      });
      return;
    }
    this.clearTimer();
    const setTimer = this.opts.setTimer ?? defaultSetTimer;
    this.timer = setTimer(() => {
      this.timer = null;
      void this.releaseIdle().catch(() => {
      });
    }, decision.delayMs);
  }
  /** Explicit shutdown. Idempotent; later use() calls fail fast. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    this.clearTimer();
    while (this.releasing) {
      try {
        await this.releasing;
      } catch {
      }
    }
    if (this.inFlight > 0) {
      this.pendingClose = true;
      return;
    }
    await this.teardown("closed");
  }
  state() {
    return {
      name: this.opts.name,
      resident: this.hasValue,
      starting: this.creating !== null,
      held: this.inFlight,
      failures: this.failures,
      idleTtlMs: this.opts.idleTtlMs,
      closed: this.closed
    };
  }
  get resident() {
    return this.hasValue;
  }
};

// D:/Projects/WebUI/WebUI/lib/server/coordination/llm-lease.ts
var import_node_fs4 = __toESM(require("node:fs"));
var import_node_path5 = __toESM(require("node:path"));
var import_node_crypto4 = __toESM(require("node:crypto"));
var LEASE_REL = ".ai-coordination/llm-handoff.lock";
var LEASE_RECORD_BYTES = 512;
var LEASE_STALE_MS = Number(process.env.RUKE_HANDOFF_STALE_MS ?? 6e4);
var LeaseRecordTooLarge = class extends Error {
  constructor(byteLength, capacity) {
    super(
      `a coordination record needs ${byteLength} bytes but the fixed slot is ${capacity}; refusing to write a truncated (unparseable) record`
    );
    this.name = "LeaseRecordTooLarge";
  }
};
var CORE_RECORD_KEYS = ["token", "owner", "pid", "pid_created", "phase", "started", "heartbeat"];
function leasePath(root = process.cwd()) {
  return import_node_path5.default.join(root, LEASE_REL);
}
function statMtimeMs(at) {
  try {
    return import_node_fs4.default.statSync(at).mtimeMs;
  } catch {
    return null;
  }
}
function readRecord(at) {
  let raw;
  try {
    raw = import_node_fs4.default.readFileSync(at);
  } catch (error) {
    const code = error?.code;
    if (code === "ENOENT") {
      return { state: "absent", holder: null, detail: "no lease record exists", mtimeMs: null };
    }
    return {
      state: "unreadable",
      holder: null,
      mtimeMs: statMtimeMs(at),
      detail: `the lease record at ${at} could not be read: ${code ?? error?.name ?? "error"}: ${error?.message ?? String(error)}`
    };
  }
  const mtimeMs = statMtimeMs(at);
  const end = raw.indexOf(0);
  const text = (end === -1 ? raw : raw.subarray(0, end)).toString("utf8").trim();
  if (!text) {
    return {
      state: "corrupt",
      holder: null,
      mtimeMs,
      detail: "the lease record is blank: a writer created the file and never got a parseable record into it"
    };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      state: "corrupt",
      holder: null,
      mtimeMs,
      detail: `the lease record is not parseable JSON: ${error?.name ?? "error"}`
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      state: "corrupt",
      holder: null,
      mtimeMs,
      detail: `the lease record is ${Array.isArray(value) ? "an array" : typeof value}, not an object`
    };
  }
  const holder = value;
  if (!holder.token && !holder.owner) {
    return {
      state: "corrupt",
      holder,
      mtimeMs,
      detail: "the lease record carries neither a token nor an owner, so no holder can be identified or ruled out"
    };
  }
  return { state: "ok", holder, detail: "record parsed", mtimeMs };
}
function leaseState(at = leasePath()) {
  const record = readRecord(at);
  if (record.state === "absent") {
    return {
      path: at,
      state: "absent",
      held: false,
      stale: false,
      uncertain: false,
      abandoned: false,
      proof: record.detail,
      holder: null,
      ageMs: null
    };
  }
  const holder = record.holder;
  if (record.state === "unreadable" || record.state === "corrupt") {
    const ageMs2 = record.mtimeMs === null ? null : Math.max(0, Date.now() - record.mtimeMs);
    const abandoned = ageMs2 !== null && ageMs2 > LEASE_STALE_MS;
    const secs = (value) => `${Math.round(value / 1e3)}s`;
    const proof = ageMs2 === null ? `${record.detail}, and its age cannot be established, so no holder can be ruled out and it cannot be aged out` : abandoned ? `${record.detail} and the file itself is ${secs(ageMs2)} old, past the ${secs(LEASE_STALE_MS)} window, so it is abandoned` : `${record.detail}, so no holder can be ruled out (record age ${secs(ageMs2)})`;
    return {
      path: at,
      state: record.state,
      held: !abandoned,
      stale: abandoned,
      uncertain: true,
      abandoned,
      proof,
      holder,
      ageMs: ageMs2
    };
  }
  const heartbeat = typeof holder?.heartbeat === "number" ? holder.heartbeat * 1e3 : 0;
  const newest = Math.max(heartbeat, record.mtimeMs ?? 0);
  if (!Number.isFinite(newest) || newest <= 0) {
    return {
      path: at,
      state: "ok",
      held: true,
      stale: false,
      uncertain: true,
      abandoned: false,
      proof: "the lease record carries no timestamp at all, so no holder can be ruled out and it cannot be aged out",
      holder,
      ageMs: null
    };
  }
  const ageMs = Math.max(0, Date.now() - newest);
  if (ageMs > LEASE_STALE_MS) {
    return {
      path: at,
      state: "ok",
      held: false,
      stale: true,
      uncertain: false,
      abandoned: true,
      proof: `the newest lease evidence is ${Math.round(ageMs / 1e3)}s old, past the ${Math.round(LEASE_STALE_MS / 1e3)}s window, so the holder is gone`,
      holder,
      ageMs
    };
  }
  return {
    path: at,
    state: "ok",
    held: true,
    stale: false,
    uncertain: false,
    abandoned: false,
    proof: `${holder?.owner ?? "unknown"} holds the lease (pid ${holder?.pid ?? "?"}, phase ${holder?.phase ?? "?"}, heartbeat ${Math.round(ageMs / 1e3)}s ago)`,
    holder,
    ageMs
  };
}
function packRecord(payload) {
  const keys = Object.keys(payload).sort();
  const data = Buffer.from(JSON.stringify(payload, keys), "utf8");
  if (data.byteLength > LEASE_RECORD_BYTES) {
    throw new LeaseRecordTooLarge(data.byteLength, LEASE_RECORD_BYTES);
  }
  const out = Buffer.alloc(LEASE_RECORD_BYTES, 0);
  out.set(data, 0);
  return out;
}
function coreRecord(payload) {
  const out = {};
  for (const key of CORE_RECORD_KEYS) {
    if (payload[key] !== void 0) out[key] = payload[key];
  }
  return out;
}
function pidAlive(pid) {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error?.code;
    return code !== "ESRCH";
  }
}
function acquireLease(owner, phase = "waiting", at = leasePath()) {
  const token = import_node_crypto4.default.randomBytes(16).toString("hex");
  const existing = leaseState(at);
  if (existing.held) {
    return { acquired: false, refusal: `the main model is already parked: ${existing.proof}`, state: existing, token };
  }
  if (existing.stale && existing.holder) {
    const pid = existing.holder.pid;
    if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) {
      return {
        acquired: false,
        refusal: "the lease record is old but names no pid, so its holder cannot be proven gone",
        state: existing,
        token
      };
    }
    if (pidAlive(pid)) {
      return {
        acquired: false,
        refusal: `the lease evidence is old but pid ${pid} is still running, so the holder is not provably gone`,
        state: existing,
        token
      };
    }
    try {
      import_node_fs4.default.rmSync(at, { force: true });
    } catch {
      return { acquired: false, refusal: `the abandoned lease record at ${existing.path} could not be removed`, state: existing, token };
    }
  }
  const now = Date.now() / 1e3;
  let record;
  try {
    record = packRecord({ token, owner, pid: process.pid, phase, started: now, heartbeat: now });
  } catch (error) {
    const message = error?.message ?? String(error);
    return { acquired: false, refusal: `the lease record cannot be written: ${message}`, state: existing, token };
  }
  try {
    import_node_fs4.default.mkdirSync(import_node_path5.default.dirname(at), { recursive: true });
    const fd = import_node_fs4.default.openSync(at, "wx");
    try {
      import_node_fs4.default.writeFileSync(fd, record);
    } finally {
      import_node_fs4.default.closeSync(fd);
    }
  } catch (error) {
    const again = leaseState(at);
    if (again.held) {
      return { acquired: false, refusal: `another client took the lease first: ${again.proof}`, state: again, token };
    }
    if (again.stale) {
      return {
        acquired: false,
        refusal: `a stale lease record exists and this client is not allowed to break it: ${again.proof}`,
        state: again,
        token
      };
    }
    const message = error?.message ?? String(error);
    return { acquired: false, refusal: `the lease record could not be created: ${message}`, state: again, token };
  }
  return { acquired: true, refusal: "", state: leaseState(at), token };
}
function heartbeatLease(at, token, phase, extra) {
  const current = leaseState(at);
  if (!current.holder || current.holder.token !== token) return false;
  const merged = { ...current.holder, ...extra ?? {}, heartbeat: Date.now() / 1e3 };
  if (phase) merged.phase = phase;
  try {
    import_node_fs4.default.writeFileSync(at, packRecord(merged));
    return true;
  } catch (error) {
    if (error instanceof LeaseRecordTooLarge) {
      try {
        import_node_fs4.default.writeFileSync(at, packRecord(coreRecord(merged)));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}
function releaseLease(at, token) {
  const current = leaseState(at);
  if (!current.holder || current.holder.token !== token) return false;
  try {
    import_node_fs4.default.rmSync(at, { force: true });
    return true;
  } catch {
    return false;
  }
}

// D:/Projects/WebUI/WebUI/lib/server/extract/audio.ts
var execFileP3 = (0, import_node_util3.promisify)(import_node_child_process3.execFile);
var log2 = childLogger("extract/audio");
var MODEL_ID = process.env.WHISPER_MODEL ?? "Xenova/whisper-base.en";
var VRAM_FLOOR_MB = Number(process.env.WHISPER_VRAM_FLOOR_MB ?? 1500);
var SILENCE_RMS = Number(process.env.WHISPER_SILENCE_RMS ?? 4e-3);
var SR = 16e3;
var PROVIDER = providerConfig();
var LLM_UNLOAD_URL = PROVIDER.unloadUrl;
var LLM_RELOAD_URL = PROVIDER.reloadUrl;
var WHISPER_CPU_IDLE_MS = parseIdleTtl(process.env.WHISPER_CPU_IDLE_MS, 9e4);
var cpuAsrResource = new OwnedResource({
  name: "whisper-cpu",
  idleTtlMs: WHISPER_CPU_IDLE_MS,
  create: () => loadAsr("cpu", "q8"),
  destroy: async (pipe) => {
    await pipe?.dispose?.();
  }
});
function withCpuAsr(fn) {
  return cpuAsrResource.use(fn);
}
var cudaBroken = false;
async function loadAsr(device, dtype) {
  const { pipeline: pipeline2, env } = await import("@huggingface/transformers");
  const cacheDir = import_node_path6.default.join(process.cwd(), ".data", "models");
  import_node_fs5.default.mkdirSync(cacheDir, { recursive: true });
  env.allowLocalModels = false;
  env.useBrowserCache = false;
  env.cacheDir = cacheDir;
  return pipeline2("automatic-speech-recognition", MODEL_ID, {
    ...device ? { device } : {},
    ...dtype ? { dtype } : {}
  });
}
async function getFreeVramMb() {
  try {
    const { stdout } = await execFileP3(
      "nvidia-smi",
      ["--query-gpu=memory.free", "--format=csv,noheader,nounits"],
      { timeout: 2e3, encoding: "utf8" }
    );
    const vals = stdout.split("\n").map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite);
    return vals.length ? Math.max(...vals) : null;
  } catch {
    return null;
  }
}
async function postJson(url, body, timeoutMs) {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs)
    });
    return r.ok;
  } catch {
    return false;
  }
}
var UNDER_TEST = process.env.VITEST !== void 0 || process.env.NODE_ENV === "test";
var LIVE_LIFECYCLE_OPT_IN = process.env.RUKE_ALLOW_LIVE_LIFECYCLE === "1";
function llmParkPermission() {
  if (!PROVIDER.automaticHandoff) {
    return {
      allowed: false,
      reason: "the provider handoff policy is switched off"
    };
  }
  if (LLM_UNLOAD_URL === "") {
    return { allowed: false, reason: "no lifecycle unload endpoint is configured" };
  }
  if (UNDER_TEST && !LIVE_LIFECYCLE_OPT_IN) {
    return {
      allowed: false,
      reason: "a test process may not call the live provider lifecycle endpoint (set RUKE_ALLOW_LIVE_LIFECYCLE=1 to allow it)"
    };
  }
  return { allowed: true, reason: `the provider lifecycle endpoint is ${LLM_UNLOAD_URL}` };
}
async function tryLlmUnload() {
  const perm = llmParkPermission();
  if (!perm.allowed) {
    log2.warn({ reason: perm.reason }, "not calling the provider unload endpoint");
    return false;
  }
  return postJson(LLM_UNLOAD_URL, {}, 1e4);
}
async function tryLlmReload() {
  const perm = llmParkPermission();
  if (!perm.allowed) {
    log2.warn({ reason: perm.reason }, "not calling the provider reload endpoint");
    return;
  }
  if (LLM_RELOAD_URL) {
    await postJson(LLM_RELOAD_URL, {}, 12e4);
    return;
  }
  await sharedUpstreamCompletion({
    body: { model: "default", messages: [{ role: "user", content: "x" }], max_tokens: 1, stream: false },
    label: "audio-llm-warmup",
    timeoutMs: 12e4
  });
}
function rmsOf(pcm, from, to) {
  let sum = 0;
  const n = Math.max(1, to - from);
  for (let i = from; i < to; i++) {
    const v = pcm[i];
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}
function planWindows(pcm, winSec = 30, threshold = SILENCE_RMS) {
  const win = winSec * SR;
  const out = [];
  for (let from = 0; from < pcm.length; from += win) {
    const to = Math.min(pcm.length, from + win);
    out.push({ from, to, silent: rmsOf(pcm, from, to) < threshold });
  }
  return out;
}
function offsetSegments(segs, offsetSec) {
  if (!offsetSec) return segs;
  return segs.map((s) => ({
    ...s,
    start: s.start + offsetSec,
    end: s.end === null ? null : s.end + offsetSec
  }));
}
function normalizeSegmentTimeline(segs) {
  let runningEnd = 0;
  const out = [];
  for (const s of segs) {
    const shift = s.start < runningEnd - 6 ? runningEnd : 0;
    const fixed = {
      ...s,
      start: s.start + shift,
      end: s.end === null ? null : s.end + shift
    };
    runningEnd = Math.max(runningEnd, fixed.end ?? fixed.start);
    out.push(fixed);
  }
  return out;
}
function dedupeSeamSegments(segs) {
  const out = [];
  for (const s of segs) {
    const p = out[out.length - 1];
    if (p && p.text && s.text && s.start < (p.end ?? p.start) - 2) {
      if (s.text === p.text || p.text.includes(s.text)) continue;
      if (s.text.includes(p.text)) {
        out[out.length - 1] = { ...s };
        continue;
      }
    }
    out.push(s);
  }
  return out;
}
function toSegments(out) {
  return Array.isArray(out?.chunks) ? out.chunks.map((c) => ({
    text: String(c?.text ?? "").trim(),
    start: Number(c?.timestamp?.[0] ?? 0),
    end: c?.timestamp?.[1] ?? null
  })).filter((s) => s.text) : [];
}
var ASR_CHUNK_OPTS = { chunk_length_s: 30, stride_length_s: 5 };
async function asrOnce(asr, pcm, extra) {
  const out = await asr(pcm, { return_timestamps: true, ...extra, ...ASR_CHUNK_OPTS });
  return {
    text: String(typeof out === "string" ? out : out?.text ?? "").trim(),
    segments: dedupeSeamSegments(normalizeSegmentTimeline(toSegments(out)))
  };
}
async function transcribeWith(asr, pcm, extra, signal) {
  if (pcm.length <= 30 * SR) return asrOnce(asr, pcm, extra);
  const plan = planWindows(pcm);
  const silent = plan.filter((w) => w.silent).length;
  if (!silent || silent < plan.length * 0.2) return asrOnce(asr, pcm, extra);
  const texts = [];
  const segments = [];
  for (const w of plan) {
    if (signal?.aborted) throw new Error("Transcription cancelled");
    if (w.silent) continue;
    const r = await asrOnce(asr, pcm.subarray(w.from, w.to), extra);
    if (r.text) texts.push(r.text);
    segments.push(...offsetSegments(r.segments, w.from / SR));
  }
  return { text: texts.join(" ").replace(/\s+/g, " ").trim(), segments };
}
async function withAsrStage(opts, task) {
  const probe = opts.probe ?? getFreeVramMb;
  const unload = opts.unload ?? tryLlmUnload;
  const reload = opts.reload ?? tryLlmReload;
  const leaseAt = opts.leaseAt ?? leasePath();
  const onStage = opts.onStage ?? (() => {
  });
  const parkPerm = llmParkPermission();
  const canPark = opts.unload !== void 0 || parkPerm.allowed;
  let useCuda = false;
  let unloaded = false;
  let unloadAttempted = false;
  let leaseToken = "";
  let leaseRefusal = "";
  let gpuAsr = null;
  try {
    if (!cudaBroken) {
      let free;
      try {
        free = await probe();
      } catch {
        free = null;
      }
      if (free !== null) {
        if (free >= VRAM_FLOOR_MB) {
          useCuda = true;
        } else {
          const held = leaseState(leaseAt);
          if (!canPark) {
            leaseRefusal = `${parkPerm.reason}, so this job cannot park the main model`;
            onStage(leaseRefusal + " - staying on CPU");
          } else if (held.held) {
            leaseRefusal = held.proof;
            onStage(`not unloading the LLM: ${held.proof}`);
            log2.warn({ lease: held.proof }, "not unloading the LLM: a handoff job already owns the parked-model window");
          } else {
            const took = acquireLease("ruke-node-asr", "unloading_main_model", leaseAt);
            if (!took.acquired) {
              leaseRefusal = took.refusal;
              onStage(`not unloading the LLM: ${took.refusal}`);
              log2.warn({ lease: took.refusal }, "not unloading the LLM: another client took the handoff lease");
            } else {
              leaseToken = took.token;
              unloadAttempted = true;
              onStage(unloaded ? "main model parked by this job (lease held)" : "unload hook failed, model state unknown (lease held until restore)");
              try {
                unloaded = await unload();
              } catch (err) {
                unloaded = false;
                log2.warn({ err: err?.message }, "LLM unload hook failed; the model may still be resident");
              }
              heartbeatLease(leaseAt, leaseToken, unloaded ? "processing" : "restoring_main_model", {
                vram_free_mb: free,
                confirmed_unloaded: unloaded
              });
            }
          }
          const re = unloaded ? await probe().catch(() => null) : null;
          if ((re ?? free) >= VRAM_FLOOR_MB) useCuda = true;
        }
      }
    }
    if (useCuda) {
      try {
        gpuAsr = await loadAsr("cuda", "fp16");
        return await task(gpuAsr, { batch_size: 8 });
      } catch (err) {
        cudaBroken = true;
        log2.warn({ err: err?.message }, "GPU whisper unavailable \u2014 falling back to CPU");
      }
    }
    return await withCpuAsr((asr) => task(asr, {}));
  } finally {
    if (gpuAsr) {
      try {
        await gpuAsr.dispose?.();
      } catch {
      }
    }
    if (unloaded || unloadAttempted) {
      if (leaseToken) releaseLease(leaseAt, leaseToken);
      leaseToken = "";
      try {
        await reload();
      } catch (err) {
        log2.warn({ err: err?.message }, "LLM reload hook failed \u2014 chat may need to warm the model back up");
      }
    } else if (leaseToken) {
      releaseLease(leaseAt, leaseToken);
      leaseToken = "";
    }
  }
}
async function transcribePcmSegments(pcm, opts = {}) {
  return withAsrStage(opts, (asr, extra) => transcribeWith(asr, pcm, extra, opts.signal));
}
async function transcribePcmFile(pcmFile, samples, opts = {}) {
  return withAsrStage(opts, async (asr, extra) => {
    const win = 30 * SR;
    const segments = [];
    for (let from = 0; from < samples; from += win) {
      if (opts.signal?.aborted) throw new Error("Transcription cancelled");
      const to = Math.min(samples, from + win);
      const core = readPcmRange(pcmFile, from, to);
      if (rmsOf(core, 0, core.length) < SILENCE_RMS) continue;
      const r = await asrOnce(asr, core, extra);
      segments.push(...offsetSegments(r.segments, from / SR));
    }
    const merged = dedupeSeamSegments(normalizeSegmentTimeline(segments));
    return {
      text: merged.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim(),
      segments: merged
    };
  });
}
function asrCapabilityNote() {
  if (!/\.en\b/.test(MODEL_ID)) return "";
  return `[transcribed with the English-only speech model "${MODEL_ID}" \u2014 speech in other languages may be missing or wrong; set WHISPER_MODEL to a multilingual checkpoint (e.g. "Xenova/whisper-base") to change this]`;
}

// D:/Projects/WebUI/WebUI/lib/server/extract/speech-capability.ts
var import_node_path7 = __toESM(require("node:path"));
var SPEECH_ASR_CAPABILITY = "speech.asr";
var SPEECH_ASR_DEADLINE_MS = 24e4;
var SPEECH_LANGUAGE_ENV = "RUKE_SPEECH_LANGUAGE";
var SPEECH_CAPABILITY_ENV = "RUKE_SPEECH_CAPABILITY";
var MAX_SEGMENTS = 2e4;
var STRUCTURAL_REASONS = /* @__PURE__ */ new Set([
  "unsupported_input",
  "input_rejected",
  "corrupt_input",
  "unsupported_language"
]);
function speechCapabilityDisabled() {
  return (process.env[SPEECH_CAPABILITY_ENV] ?? "").trim().toLowerCase() === "off";
}
var num = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
var str = (value) => typeof value === "string" ? value : "";
var obj = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
function spanList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!Array.isArray(item)) continue;
    const a = num(item[0]);
    const b = num(item[1]);
    if (a !== null && b !== null && b >= a) out.push([a, b]);
  }
  return out;
}
function normalizeAsr(result) {
  const raw = obj(result);
  const state = str(raw.state);
  const segmentsIn = Array.isArray(raw.segments) ? raw.segments : [];
  const segments = [];
  let dropped = 0;
  for (const entry of segmentsIn.slice(0, MAX_SEGMENTS)) {
    const seg = obj(entry);
    const text = str(seg.text).trim();
    const start = num(seg.start);
    const end = num(seg.end);
    if (!text || start === null || start < 0) {
      dropped++;
      continue;
    }
    if (end !== null && end < start) {
      dropped++;
      continue;
    }
    const words = Array.isArray(seg.words) ? seg.words.map((w) => {
      const word = obj(w);
      const ws = num(word.start);
      const we = num(word.end);
      const text2 = str(word.word).trim();
      if (!text2 || ws === null) return null;
      return {
        word: text2,
        start: ws,
        end: we ?? ws,
        probability: num(word.probability)
      };
    }).filter((w) => w !== null) : void 0;
    segments.push({
      start,
      end,
      text,
      ...words && words.length ? { words } : {},
      // Only ever set from the adapter's own provenance; never inferred from text.
      ...seg.window_truncated === true ? { windowTruncated: true } : {}
    });
  }
  const superseded = (Array.isArray(raw.superseded) ? raw.superseded : []).slice(0, MAX_SEGMENTS).map((entry) => {
    const frag = obj(entry);
    const start = num(frag.start);
    const end = num(frag.end);
    const text = str(frag.text).trim();
    if (!text || start === null) return null;
    const by = obj(frag.superseded_by);
    const byStart = num(by.start);
    return {
      start,
      end,
      text,
      window: (Array.isArray(frag.window) ? frag.window : []).map((v) => num(v)).filter((v) => v !== null),
      cutAt: str(frag.cut_at),
      ...byStart === null ? {} : { supersededBy: { start: byStart, end: num(by.end) } },
      reason: str(frag.reason)
    };
  }).filter((f) => f !== null);
  const asrRan = typeof raw.asr_ran === "boolean" ? raw.asr_ran : state !== "silence";
  const truncatedSegments = segments.filter((s) => s.windowTruncated).length;
  const asr = {
    state: state || (asrRan ? "transcribed" : "silence"),
    text: str(raw.text).trim(),
    segments,
    segmentCount: num(raw.segment_count) ?? segmentsIn.length,
    droppedSegments: dropped,
    language: str(raw.language),
    languageSource: str(raw.language_source),
    languageProbability: num(raw.language_probability),
    model: str(raw.model),
    device: str(raw.device),
    computeType: str(raw.compute_type),
    durationSec: num(raw.duration) ?? 0,
    complete: raw.complete === true,
    asrRan,
    note: str(raw.note),
    examined: spanList(raw.examined),
    unexamined: spanList(obj(raw.coverage).skipped),
    audioLevel: obj(raw.audio_level),
    probe: obj(raw.probe),
    routing: obj(raw.routing),
    vadFilter: raw.vad_filter === true,
    vadState: str(raw.vad_state),
    // Count and list are kept apart on purpose: the adapter caps the list, so a larger
    // count is honest reporting, not a mismatch to hide.
    supersededFragments: num(raw.superseded_fragments) ?? superseded.length,
    superseded,
    truncatedSegments
  };
  if (!asr.text && !segments.length && asr.state !== "silence" && !Object.keys(asr.audioLevel).length) {
    return null;
  }
  return asr;
}
function speechBlockerLine(outcome) {
  const step = outcome.humanStep ? ` Next step: ${outcome.humanStep}.` : "";
  return `[speech backend: ${outcome.message}]${step}`;
}
function speechEngineNote(asr) {
  const bits = [];
  if (asr.model) bits.push(`speech model "${asr.model}"`);
  if (asr.device) bits.push(`${asr.device}${asr.computeType ? `/${asr.computeType}` : ""}`);
  if (asr.language) {
    bits.push(
      `language ${asr.language}${asr.languageSource === "detected" ? " (detected)" : asr.languageSource === "explicit" ? " (as specified)" : ""}`
    );
  }
  if (asr.segments.some((s) => s.words?.length)) bits.push("word timing supplied by the provider");
  else bits.push("segment-level timing only (no word timing was requested or provided)");
  if (asr.vadState === "applied") bits.push("speech-activity gating applied per window");
  else if (asr.vadState) bits.push(`speech-activity gating ${asr.vadState}`);
  if (asr.truncatedSegments)
    bits.push(`${asr.truncatedSegments} segment(s) cut at a decode-window boundary`);
  if (asr.supersededFragments)
    bits.push(`${asr.supersededFragments} window-boundary fragment(s) replaced by a complete reading`);
  if (!asr.complete) bits.push("coverage was partial: unexamined audio cannot prove absence");
  return `[${bits.join("; ")}]`;
}
async function transcribeViaCapability(srcPath, opts = {}) {
  if (speechCapabilityDisabled()) return { state: "none" };
  const run = opts.runJob ?? mlJob;
  const resolved = import_node_path7.default.resolve(srcPath);
  const language = (opts.language ?? process.env[SPEECH_LANGUAGE_ENV] ?? "").trim();
  const payload = { path: resolved, root: import_node_path7.default.dirname(resolved) };
  if (language) payload.language = language;
  if (opts.wordTimestamps) payload.word_timestamps = true;
  if (opts.windowSec) payload.window_s = opts.windowSec;
  const envelope = await run(SPEECH_ASR_CAPABILITY, payload, {
    deadlineMs: opts.deadlineMs ?? SPEECH_ASR_DEADLINE_MS,
    signal: opts.signal
  });
  if (envelope === null) return { state: "none" };
  if (envelope.state === "cancelled") {
    return {
      state: "unavailable",
      reason: "cancelled",
      message: "the speech job was cancelled before it produced a transcript",
      humanStep: "",
      retryable: false,
      structural: false
    };
  }
  if (envelope.state === "ready") {
    const asr = normalizeAsr(envelope.result);
    if (!asr) {
      return {
        state: "unavailable",
        reason: "contract_mismatch",
        message: "the speech backend reported a successful run that carries no inspectable transcript and no measured audio verdict, which is refused rather than reported as an empty recording",
        humanStep: "report this: the payload shape and the backend version must match",
        retryable: false,
        structural: false
      };
    }
    return asr.state === "silence" ? { state: "silence", asr } : { state: "ready", asr };
  }
  const error = envelope.error;
  const reason = error?.reason || (envelope.state === "cancelled" ? "cancelled" : "internal");
  return {
    state: "unavailable",
    reason,
    message: error?.message || `the speech job ended in state ${envelope.state}`,
    humanStep: error?.human_step || "",
    retryable: error?.retryable === true,
    structural: STRUCTURAL_REASONS.has(reason)
  };
}

// D:/Projects/WebUI/WebUI/lib/server/attachindex/chunk.ts
var CHUNK_CHARS = Number(process.env.ATTACH_INDEX_CHUNK ?? 1200);
var OVERLAP_CHARS = Number(process.env.ATTACH_INDEX_OVERLAP ?? 150);
function sentenceUnits(text) {
  const units = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    for (const p of t.split(/(?<=[.!?])["')\]]*\s+/)) {
      const s = p.trim();
      if (s) units.push({ text: s, startSec: null, endSec: null });
    }
  }
  return units;
}
function segmentUnits(segments) {
  return segments.map((s) => ({ text: s.text.trim(), startSec: s.start, endSec: s.end })).filter((u) => u.text);
}
function splitOversized(u, size) {
  if (u.text.length <= size) return [u];
  const pieces = [];
  let cur = "";
  for (const s of u.text.match(/[^.!?]+[.!?]*|[.!?]+|\s+/g) ?? []) {
    if (cur && (cur + s).length > size) {
      pieces.push(cur);
      cur = s;
    } else cur += s;
    while (cur.length > size) {
      pieces.push(cur.slice(0, size));
      cur = cur.slice(size);
    }
  }
  if (cur) pieces.push(cur);
  if (pieces.join("") !== u.text) {
    pieces.length = 0;
    for (let i = 0; i < u.text.length; i += size) pieces.push(u.text.slice(i, i + size));
  }
  return pieces.map((t) => ({ text: t, startSec: u.startSec, endSec: u.endSec }));
}
function groupUnits(units, size, overlap) {
  const expanded = units.flatMap((u) => splitOversized(u, size));
  const chunks = [];
  let cur = [];
  let len = 0;
  const flush = () => {
    if (!cur.length) return;
    const text = cur.map((u) => u.text).join(" ");
    const startSec = cur.find((u) => u.startSec != null)?.startSec ?? null;
    const endSec = [...cur].reverse().find((u) => u.endSec != null)?.endSec ?? null;
    chunks.push({ i: chunks.length, startSec, endSec, text, vec: [] });
  };
  for (const u of expanded) {
    if (cur.length && len + 1 + u.text.length > size) {
      const done = cur;
      flush();
      const carry = [];
      let carryChars = 0;
      for (let j = done.length - 1; j >= 0; j--) {
        const add = done[j].text.length + (carry.length ? 1 : 0);
        if (carryChars + add > overlap || carryChars + add > size / 2) break;
        carry.unshift(done[j]);
        carryChars += add;
      }
      cur = carry.length < done.length ? carry : [];
      len = cur === carry ? carryChars : 0;
    }
    len += (cur.length ? 1 : 0) + u.text.length;
    cur.push(u);
  }
  flush();
  return chunks;
}
function chunkSegments(segments, size = CHUNK_CHARS, overlap = OVERLAP_CHARS) {
  return groupUnits(segmentUnits(segments), size, overlap);
}
function chunkText(text, size = CHUNK_CHARS, overlap = OVERLAP_CHARS) {
  return groupUnits(sentenceUnits(text), size, overlap);
}

// D:/Projects/WebUI/WebUI/lib/server/attachindex/embed.ts
var import_node_fs6 = __toESM(require("node:fs"));
var import_node_path8 = __toESM(require("node:path"));
var EMBED_MODEL_ID = process.env.EMBED_MODEL ?? "Xenova/all-MiniLM-L6-v2";
var EMBED_POOLING = "mean";
var EMBED_NORMALIZED = true;
function embedFingerprint(dim) {
  return `model=${EMBED_MODEL_ID};pool=${EMBED_POOLING};normalize=${EMBED_NORMALIZED};dim=${dim}`;
}
function embedRevision() {
  return "unpinned";
}
var ATTACH_EMBED_IDLE_MS = parseIdleTtl(process.env.ATTACH_EMBED_IDLE_MS, 6e4);
async function createEmbedder() {
  const { pipeline: pipeline2, env } = await import("@huggingface/transformers");
  const cacheDir = import_node_path8.default.join(process.cwd(), ".data", "models");
  import_node_fs6.default.mkdirSync(cacheDir, { recursive: true });
  env.allowLocalModels = false;
  env.useBrowserCache = false;
  env.cacheDir = cacheDir;
  return pipeline2("feature-extraction", EMBED_MODEL_ID);
}
async function destroyEmbedder(pipe) {
  if (typeof pipe?.dispose === "function") {
    await pipe.dispose();
    return;
  }
  if (typeof pipe?.model?.dispose === "function") {
    await pipe.model.dispose();
    return;
  }
  throw new Error("feature-extraction pipeline exposes no dispose()");
}
var embedderResource = new OwnedResource({
  name: "attach-embedder",
  idleTtlMs: ATTACH_EMBED_IDLE_MS,
  create: createEmbedder,
  destroy: destroyEmbedder
});
async function embedTexts(texts, signal) {
  const throwIfAborted3 = () => {
    if (!signal?.aborted) return;
    const reason = signal.reason;
    if (reason instanceof Error) throw reason;
    const e = new Error("The user aborted this request.");
    e.name = "AbortError";
    throw e;
  };
  throwIfAborted3();
  if (embedDisabled()) {
    throw new Error("embeddings disabled (ATTACH_EMBED=off)");
  }
  const out = [];
  const BATCH = 16;
  await embedderResource.use(async (fe) => {
    for (let i = 0; i < texts.length; i += BATCH) {
      throwIfAborted3();
      const res = await fe(texts.slice(i, i + BATCH), { pooling: EMBED_POOLING, normalize: EMBED_NORMALIZED });
      const rows = res.tolist();
      const matrix = Array.isArray(rows?.[0]) ? rows : [rows];
      for (const r of matrix) out.push(r);
      onEmbedProgress?.(out.length, texts.length);
    }
  });
  return out;
}
var onEmbedProgress = null;
function embedDisabled() {
  const v = (process.env.ATTACH_EMBED ?? "").trim().toLowerCase();
  return v === "off" || v === "none" || v === "0";
}

// D:/Projects/WebUI/WebUI/lib/server/attachindex/bm25.ts
function tokenize(t) {
  return t.toLowerCase().match(/[\p{L}\p{N}]+(?:'[a-z]+)*/gu) ?? [];
}

// D:/Projects/WebUI/WebUI/lib/server/attachindex/format.ts
function fmtStamp(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s % 3600 / 60);
  const r = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}
function firstSentence(text, max = 90) {
  const m = /^[^.!?]+[.!?]?/.exec(text.trim());
  const s = (m?.[0] ?? text).trim();
  return s.length > max ? s.slice(0, max).trimEnd() + "..." : s;
}
function lastSentence(text, max = 90) {
  const parts = text.trim().match(/[^.!?]+[.!?]?/g) ?? [];
  const s = (parts[parts.length - 1] ?? text).trim();
  return s.length > max ? "..." + s.slice(-max).trimStart() : s;
}

// D:/Projects/WebUI/WebUI/lib/server/attachindex/spine.ts
var MAX_BLOCKS = Number(process.env.ATTACH_SPINE_BLOCKS ?? 40);
var BLOCK_SEC = 600;
function buildSpine(chunks) {
  if (!chunks.length) return { blocks: [], text: "" };
  let groups = [];
  const timed = chunks.some((c) => c.startSec != null);
  if (timed) {
    const byBucket = /* @__PURE__ */ new Map();
    for (const c of chunks) {
      const key = Math.floor((c.startSec ?? 0) / BLOCK_SEC);
      const g = byBucket.get(key);
      if (g) g.push(c);
      else byBucket.set(key, [c]);
    }
    groups = [...byBucket.keys()].sort((a, b) => a - b).map((k) => byBucket.get(k));
    while (groups.length > MAX_BLOCKS) {
      const merged = [];
      for (let i = 0; i < groups.length; i += 2) merged.push(groups[i].concat(groups[i + 1] ?? []));
      groups = merged;
    }
  } else {
    const per = Math.max(1, Math.ceil(chunks.length / MAX_BLOCKS));
    for (let i = 0; i < chunks.length; i += per) groups.push(chunks.slice(i, i + per));
  }
  const toks = groups.map((g) => tokenize(g.map((c) => c.text).join(" ")));
  const df = /* @__PURE__ */ new Map();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
  const n = groups.length;
  const blocks = groups.map((g, gi) => {
    const tf = /* @__PURE__ */ new Map();
    for (const w of toks[gi]) tf.set(w, (tf.get(w) ?? 0) + 1);
    const keywords = [...tf.entries()].filter(([w]) => w.length >= 3).map(([w, f]) => {
      const d = df.get(w) ?? 0;
      return [w, f * Math.log(1 + (n - d + 0.5) / (d + 0.5))];
    }).sort((a, b) => b[1] - a[1]).slice(0, 5).map((e) => e[0]);
    return {
      startSec: g[0].startSec ?? null,
      endSec: g[g.length - 1].endSec ?? null,
      chunkFrom: g[0].i,
      chunkTo: g[g.length - 1].i,
      keywords,
      opening: firstSentence(g[0].text),
      closing: lastSentence(g[g.length - 1].text)
    };
  });
  const text = blocks.map((b) => {
    const span = b.startSec != null ? `[${fmtStamp(b.startSec)} - ${fmtStamp(b.endSec ?? b.startSec)}]` : `[chunks ${b.chunkFrom}-${b.chunkTo}]`;
    return `${span} ${b.keywords.join(", ")} \u2014 opens: "${b.opening}"; closes: "${b.closing}"`;
  }).join("\n");
  return { blocks, text };
}

// D:/Projects/WebUI/WebUI/lib/server/attachindex/store.ts
var import_node_fs8 = __toESM(require("node:fs"));
var import_node_path10 = __toESM(require("node:path"));

// D:/Projects/WebUI/WebUI/lib/server/attachindex/publish.ts
var import_node_fs7 = __toESM(require("node:fs"));
var import_node_path9 = __toESM(require("node:path"));
var import_node_crypto5 = __toESM(require("node:crypto"));
var JOURNAL_RE = /^att_[a-z0-9]{4,32}\.json$/;
var GEN_DIR_RE = /^g\d{1,20}-[0-9a-f]{8}$/;
var STALE_SUFFIX_RE = /\.stale-\d{1,20}$/;
var PublishError = class extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = "PublishError";
    this.code = code;
    this.cause = cause;
  }
};
var FaultAbort = class extends Error {
  constructor(point) {
    super(`injected fault at ${point}`);
    this.name = "FaultAbort";
    this.point = point;
  }
};
function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  const e = new Error("The user aborted this request.");
  e.name = "AbortError";
  throw e;
}
function isErrno(err, code) {
  return err?.code === code;
}
function uniqueTmp(file) {
  const rand = import_node_crypto5.default.randomBytes(4).toString("hex");
  return import_node_path9.default.join(import_node_path9.default.dirname(file), `${import_node_path9.default.basename(file)}.tmp-${process.pid}-${rand}`);
}
function durableWrite(file, data) {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const tmp = uniqueTmp(file);
  import_node_fs7.default.mkdirSync(import_node_path9.default.dirname(file), { recursive: true });
  try {
    const fd = import_node_fs7.default.openSync(tmp, "w");
    try {
      import_node_fs7.default.writeFileSync(fd, buf);
      try {
        import_node_fs7.default.fsyncSync(fd);
      } catch {
      }
    } finally {
      import_node_fs7.default.closeSync(fd);
    }
    import_node_fs7.default.renameSync(tmp, file);
  } catch (err) {
    try {
      import_node_fs7.default.unlinkSync(tmp);
    } catch {
    }
    throw err;
  }
  return { sha256: import_node_crypto5.default.createHash("sha256").update(buf).digest("hex"), size: buf.length };
}
function readJournal(txRoot, attId) {
  try {
    const f = import_node_path9.default.join(txRoot, `${attId}.json`);
    if (!JOURNAL_RE.test(`${attId}.json`) || !import_node_fs7.default.existsSync(f)) return null;
    const j = JSON.parse(import_node_fs7.default.readFileSync(f, "utf8"));
    if (j?.v !== 1 || j.attId !== attId || typeof j.gen !== "string" || !Array.isArray(j.files)) return null;
    return j;
  } catch {
    return null;
  }
}
function writeJournal(txRoot, j) {
  import_node_fs7.default.mkdirSync(txRoot, { recursive: true });
  durableWrite(import_node_path9.default.join(txRoot, `${j.attId}.json`), JSON.stringify(j));
}
function clearJournal(txRoot, attId) {
  try {
    import_node_fs7.default.rmSync(import_node_path9.default.join(txRoot, `${attId}.json`), { force: true });
  } catch {
  }
}
function rmQuiet(dir) {
  try {
    import_node_fs7.default.rmSync(dir, { recursive: true, force: true });
  } catch {
  }
}
function validateGen(genDir, meta, chunks) {
  try {
    const metaBack = JSON.parse(import_node_fs7.default.readFileSync(import_node_path9.default.join(genDir, "meta.json"), "utf8"));
    const jsonl = import_node_fs7.default.readFileSync(import_node_path9.default.join(genDir, "chunks.jsonl"), "utf8");
    const lines = jsonl.split("\n").filter((l) => l.trim());
    if (lines.length !== chunks.length) {
      return { ok: false, reason: `chunks.jsonl has ${lines.length} lines but the build had ${chunks.length} chunks` };
    }
    const declared = Number(metaBack.chunkCount ?? 0);
    if (declared !== lines.length) {
      return { ok: false, reason: `meta.chunkCount=${declared} disagrees with ${lines.length} chunk lines` };
    }
    const seen = /* @__PURE__ */ new Set();
    const dimsSeen = /* @__PURE__ */ new Set();
    let dim = -1;
    for (const line of lines) {
      const c = JSON.parse(line);
      const id = Number(c.i);
      if (!Number.isInteger(id) || id < 0 || seen.has(id)) {
        return { ok: false, reason: `chunk id ${String(c.i)} is not a unique non-negative integer` };
      }
      seen.add(id);
      const v = Array.isArray(c.vec) ? c.vec : [];
      if (v.length) {
        const bad = v.some((n) => typeof n !== "number" || !Number.isFinite(n));
        if (bad) return { ok: false, reason: `chunk ${id} has a non-finite embedding component` };
        if (dim === -1) dim = v.length;
        dimsSeen.add(v.length);
      }
    }
    const stamped = meta.embed;
    if (stamped && typeof stamped.dim === "number") {
      if (dim >= 0 && (dimsSeen.size !== 1 || dimsSeen.has(stamped.dim) === false)) {
        return { ok: false, reason: `embedding stamp dim ${stamped.dim} does not describe the stored shapes (${[...dimsSeen].join(", ")})` };
      }
    }
    const frames = Array.isArray(meta.frames) ? meta.frames : [];
    for (const f of frames) {
      const rel = String(f?.file ?? "");
      if (!rel || rel.includes("..") || import_node_path9.default.isAbsolute(rel)) {
        return { ok: false, reason: `frame path ${rel || "(empty)"} escapes the index dir` };
      }
      if (!import_node_fs7.default.existsSync(import_node_path9.default.join(genDir, rel))) {
        return { ok: false, reason: `declared keyframe ${rel} is not present in the staged generation` };
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `staged generation unreadable: ${err?.message ?? String(err)}` };
  }
}
function renameIntoPlace(from, to) {
  try {
    import_node_fs7.default.renameSync(from, to);
  } catch (err) {
    if (isErrno(err, "ENOTEMPTY") || isErrno(err, "EEXIST") || isErrno(err, "EPERM")) {
      throw new PublishError("publish", `index dir already present: ${to}`, err);
    }
    throw new PublishError("publish", `rename failed: ${from} -> ${to}`, err);
  }
}
function listStaleDirs(attDirParent, attId) {
  try {
    return import_node_fs7.default.readdirSync(attDirParent).filter((n) => n.startsWith(`${attId}.stale-`) && STALE_SUFFIX_RE.test(n)).sort();
  } catch {
    return [];
  }
}
function recoverIndexDir(paths, attId) {
  const parent = import_node_path9.default.dirname(paths.attDir);
  const journal = readJournal(paths.txRoot, attId);
  const stale = listStaleDirs(parent, attId);
  if (journal) {
    const genDir = import_node_path9.default.join(paths.genRoot, attId, journal.gen);
    if (import_node_fs7.default.existsSync(genDir)) {
      const liveHasMeta = import_node_fs7.default.existsSync(import_node_path9.default.join(paths.attDir, "meta.json"));
      if (!liveHasMeta) {
        try {
          if (import_node_fs7.default.existsSync(paths.attDir)) rmQuiet(paths.attDir);
          renameIntoPlace(genDir, paths.attDir);
          clearJournal(paths.txRoot, attId);
          for (const s of stale) rmQuiet(import_node_path9.default.join(parent, s));
          return true;
        } catch {
        }
      } else {
        rmQuiet(genDir);
        clearJournal(paths.txRoot, attId);
      }
    } else {
      clearJournal(paths.txRoot, attId);
    }
  }
  if (!import_node_fs7.default.existsSync(import_node_path9.default.join(paths.attDir, "meta.json")) && stale.length) {
    const newest = stale[stale.length - 1];
    try {
      if (import_node_fs7.default.existsSync(paths.attDir)) rmQuiet(paths.attDir);
      import_node_fs7.default.renameSync(import_node_path9.default.join(parent, newest), paths.attDir);
      for (const s of stale) if (s !== newest) rmQuiet(import_node_path9.default.join(parent, s));
      return true;
    } catch {
    }
  } else {
    for (const s of stale) rmQuiet(import_node_path9.default.join(parent, s));
  }
  return false;
}
function discardStaged(paths, attId) {
  clearJournal(paths.txRoot, attId);
  try {
    const root = import_node_path9.default.join(paths.genRoot, attId);
    for (const name of import_node_fs7.default.readdirSync(root)) {
      if (GEN_DIR_RE.test(name)) rmQuiet(import_node_path9.default.join(root, name));
    }
  } catch {
  }
}
function publishIndex(input) {
  const { attId, meta, chunks, fullText, paths } = input;
  const frames = input.frames ?? [];
  throwIfAborted(input.signal);
  const chunkCount = Number(meta.chunkCount ?? chunks.length);
  if (!Number.isInteger(chunkCount) || chunkCount < 0 || chunkCount !== chunks.length) {
    throw new PublishError("invalid-meta", `meta.chunkCount (${String(meta.chunkCount)}) != chunks array (${chunks.length})`);
  }
  for (const f of frames) {
    const rel = String(f?.file ?? "");
    if (!rel || rel.includes("..") || import_node_path9.default.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
      throw new PublishError("invalid-frames", `frame path ${rel || "(empty)"} escapes the index dir`);
    }
  }
  const seq = Date.now();
  const genName = `g${seq}-${import_node_crypto5.default.randomBytes(4).toString("hex")}`;
  const genDir = import_node_path9.default.join(paths.genRoot, attId, genName);
  rmQuiet(genDir);
  import_node_fs7.default.mkdirSync(genDir, { recursive: true });
  const files = [];
  try {
    input.fault?.("stage-full");
    files.push({ rel: "full.txt", ...durableWrite(import_node_path9.default.join(genDir, "full.txt"), fullText ?? "") });
    input.fault?.("stage-chunks");
    const jsonl = chunks.map((c) => JSON.stringify(c)).join("\n") + (chunks.length ? "\n" : "");
    files.push({ rel: "chunks.jsonl", ...durableWrite(import_node_path9.default.join(genDir, "chunks.jsonl"), jsonl) });
    const movedFrames = [];
    let frameCount = 0;
    try {
      for (const f of frames) {
        throwIfAborted(input.signal);
        const src = import_node_path9.default.join(paths.attDir, f.file);
        const dst = import_node_path9.default.join(genDir, f.file);
        if (!import_node_fs7.default.existsSync(src)) {
          throw new PublishError("missing-frame-file", `keyframe ${f.file} is not on disk`);
        }
        import_node_fs7.default.mkdirSync(import_node_path9.default.dirname(dst), { recursive: true });
        try {
          import_node_fs7.default.renameSync(src, dst);
        } catch (err) {
          if (!isErrno(err, "EXDEV")) throw err;
          import_node_fs7.default.copyFileSync(src, dst);
        }
        movedFrames.push({ from: src, to: dst });
        frameCount++;
      }
    } catch (err) {
      for (const m of movedFrames) {
        try {
          import_node_fs7.default.mkdirSync(import_node_path9.default.dirname(m.from), { recursive: true });
          if (import_node_fs7.default.existsSync(m.to)) import_node_fs7.default.renameSync(m.to, m.from);
        } catch {
        }
      }
      throw err;
    }
    input.fault?.("stage-meta");
    files.push({ rel: "meta.json", ...durableWrite(import_node_path9.default.join(genDir, "meta.json"), JSON.stringify(meta, null, 2)) });
    input.fault?.("validate");
    const check = validateGen(genDir, meta, chunks);
    if (!check.ok) throw new PublishError("staged-validation", check.reason ?? "staged generation invalid");
    throwIfAborted(input.signal);
    input.fault?.("journal");
    writeJournal(paths.txRoot, { v: 1, attId, seq, gen: genName, files, startedAt: seq });
    const parent = import_node_path9.default.dirname(paths.attDir);
    import_node_fs7.default.mkdirSync(parent, { recursive: true });
    const staleName = `${attId}.stale-${seq}`;
    const hadDir = import_node_fs7.default.existsSync(paths.attDir);
    const hadLive = hadDir && import_node_fs7.default.existsSync(import_node_path9.default.join(paths.attDir, "meta.json"));
    if (hadDir) renameIntoPlace(paths.attDir, import_node_path9.default.join(parent, staleName));
    input.fault?.("after-aside");
    try {
      renameIntoPlace(genDir, paths.attDir);
    } catch (err) {
      if (hadDir && !import_node_fs7.default.existsSync(import_node_path9.default.join(paths.attDir, "meta.json"))) {
        try {
          import_node_fs7.default.renameSync(import_node_path9.default.join(parent, staleName), paths.attDir);
        } catch {
        }
      }
      throw err;
    }
    input.fault?.("after-switch");
    if (hadDir) rmQuiet(import_node_path9.default.join(parent, staleName));
    clearJournal(paths.txRoot, attId);
    try {
      import_node_fs7.default.rmdirSync(import_node_path9.default.join(paths.genRoot, attId));
    } catch {
    }
    return { seq, chunkCount, frameCount };
  } catch (err) {
    if (err instanceof FaultAbort) throw err;
    rmQuiet(genDir);
    if (err instanceof PublishError) throw err;
    throw new PublishError("write", `staged write failed: ${err?.message ?? String(err)}`, err);
  }
}

// D:/Projects/WebUI/WebUI/lib/server/attachindex/store.ts
var ROOT = import_node_path10.default.join(process.cwd(), ".data", "attach-index");
var GEN_ROOT = import_node_path10.default.join(ROOT, ".gen");
var TX_ROOT = import_node_path10.default.join(ROOT, ".tx");
var ATT_RE = /^att_[a-z0-9]{4,32}$/;
function publishPaths(attId) {
  return { attDir: indexDir(attId), genRoot: GEN_ROOT, txRoot: TX_ROOT };
}
function indexDir(attId) {
  if (!ATT_RE.test(attId)) throw new Error(`invalid attachment id: ${attId}`);
  return import_node_path10.default.join(ROOT, attId);
}
function framesDir(attId) {
  return import_node_path10.default.join(indexDir(attId), "frames");
}
function hasIndex(attId) {
  try {
    const dir = indexDir(attId);
    if (import_node_fs8.default.existsSync(import_node_path10.default.join(dir, "meta.json"))) return true;
    return recoverIndexDir(publishPaths(attId), attId) && import_node_fs8.default.existsSync(import_node_path10.default.join(dir, "meta.json"));
  } catch {
    return false;
  }
}
function atomicWrite(file, data) {
  durableWrite(file, data);
}
function writeIndex(attId, meta, chunks, fullText, signal) {
  const paths = publishPaths(attId);
  try {
    publishIndex({
      attId,
      meta,
      chunks,
      fullText,
      frames: meta.frames ?? [],
      paths,
      signal
    });
  } catch (err) {
    if (err instanceof PublishError) throw new Error(String(err.message));
    throw err;
  }
  if (!meta.frames?.length) {
    try {
      import_node_fs8.default.rmSync(import_node_path10.default.join(indexDir(attId), "frames"), { recursive: true, force: true });
    } catch {
    }
  }
  cacheDelete(attId);
  shownDelete(attId);
}
var indexLocks = /* @__PURE__ */ new Map();
async function withIndexWriteLock(attId, fn) {
  if (!ATT_RE.test(attId)) throw new Error(`invalid attachment id: ${attId}`);
  const prev = indexLocks.get(attId);
  const run = (prev ? prev.catch(() => void 0) : Promise.resolve()).then(fn);
  const tail = run.then(() => void 0, () => void 0);
  indexLocks.set(attId, tail);
  try {
    return await run;
  } finally {
    if (indexLocks.get(attId) === tail) indexLocks.delete(attId);
  }
}
var cache = /* @__PURE__ */ new Map();
function cacheDelete(attId) {
  cache.delete(attId);
}
function removeIndex(attId) {
  try {
    if (!ATT_RE.test(attId)) return;
    cacheDelete(attId);
    removeUpload(attId);
    shownDelete(attId);
    discardStaged(publishPaths(attId), attId);
    try {
      import_node_fs8.default.rmSync(indexDir(attId), { recursive: true, force: true });
      for (const stale of import_node_fs8.default.readdirSync(ROOT).filter((n) => n.startsWith(`${attId}.stale-`))) {
        import_node_fs8.default.rmSync(import_node_path10.default.join(ROOT, stale), { recursive: true, force: true });
      }
    } catch {
    }
  } catch {
  }
}
var UPLOAD_ROOT = import_node_path10.default.join(process.cwd(), ".data", "uploads");
function storeUpload(srcTmp, attId, ext) {
  if (!ATT_RE.test(attId)) throw new Error(`invalid attachment id: ${attId}`);
  import_node_fs8.default.mkdirSync(UPLOAD_ROOT, { recursive: true });
  const safeExt = (ext ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const dest = import_node_path10.default.join(UPLOAD_ROOT, attId + (safeExt ? "." + safeExt : ""));
  try {
    import_node_fs8.default.renameSync(srcTmp, dest);
  } catch (err) {
    if (err?.code !== "EXDEV") throw err;
    import_node_fs8.default.copyFileSync(srcTmp, dest);
    import_node_fs8.default.rmSync(srcTmp, { force: true });
  }
  return dest;
}
function uploadPath(attId) {
  if (!ATT_RE.test(attId)) return null;
  try {
    for (const f of import_node_fs8.default.readdirSync(UPLOAD_ROOT)) {
      if (f === attId || f.startsWith(attId + ".")) return import_node_path10.default.join(UPLOAD_ROOT, f);
    }
  } catch {
  }
  return null;
}
function removeUpload(attId) {
  const p = uploadPath(attId);
  if (p) {
    try {
      import_node_fs8.default.rmSync(p, { force: true });
    } catch {
    }
  }
}
function sweepOrphanUploads(maxAgeMs = 15 * 60 * 1e3) {
  let files;
  try {
    files = import_node_fs8.default.readdirSync(UPLOAD_ROOT);
  } catch {
    return 0;
  }
  let removed = 0;
  const now = Date.now();
  for (const f of files) {
    const attId = f.split(".")[0];
    if (!ATT_RE.test(attId) || hasIndex(attId)) continue;
    const p = import_node_path10.default.join(UPLOAD_ROOT, f);
    let age = 0;
    try {
      age = now - import_node_fs8.default.statSync(p).mtimeMs;
    } catch {
      continue;
    }
    if (age < maxAgeMs) continue;
    try {
      import_node_fs8.default.rmSync(p, { force: true });
      removed++;
    } catch {
    }
  }
  return removed;
}
var SHOWN_FILE = import_node_path10.default.join(ROOT, ".shown.json");
var SHOWN_LOCK = `${SHOWN_FILE}.lock`;
var SHOWN_LOCK_WAIT_MS = 500;
var SHOWN_LOCK_STALE_MS = 2e3;
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
    }
  }
}
function shownLockOwnerFile() {
  return import_node_path10.default.join(SHOWN_LOCK, "owner");
}
function acquireShownLock() {
  const token = `${process.pid.toString(16)}-${Math.random().toString(36).slice(2, 10)}`;
  const deadline = Date.now() + SHOWN_LOCK_WAIT_MS;
  for (; ; ) {
    try {
      import_node_fs8.default.mkdirSync(ROOT, { recursive: true });
      import_node_fs8.default.mkdirSync(SHOWN_LOCK);
      try {
        import_node_fs8.default.writeFileSync(shownLockOwnerFile(), token, "utf8");
      } catch {
      }
      return { token };
    } catch (err) {
      const code = err.code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") return null;
      let mtimeMs = 0;
      try {
        mtimeMs = import_node_fs8.default.statSync(SHOWN_LOCK).mtimeMs;
      } catch {
        continue;
      }
      if (Date.now() - mtimeMs > SHOWN_LOCK_STALE_MS) {
        try {
          import_node_fs8.default.rmSync(SHOWN_LOCK, { recursive: true, force: true });
        } catch {
          return null;
        }
        continue;
      }
      if (Date.now() >= deadline) return null;
      sleepSync(5);
    }
  }
}
function releaseShownLock(lock) {
  try {
    let owner = "";
    try {
      owner = import_node_fs8.default.readFileSync(shownLockOwnerFile(), "utf8").trim();
    } catch {
      owner = "";
    }
    if (owner && owner !== lock.token) return;
    import_node_fs8.default.rmSync(SHOWN_LOCK, { recursive: true, force: true });
  } catch {
  }
}
function withShownLock(mutate) {
  const lock = acquireShownLock();
  if (lock) {
    try {
      const map2 = readShownMap();
      if (mutate(map2)) atomicWrite(SHOWN_FILE, JSON.stringify(map2));
    } finally {
      releaseShownLock(lock);
    }
    return;
  }
  const map = readShownMap();
  if (mutate(map)) atomicWrite(SHOWN_FILE, JSON.stringify(map));
}
function readShownMap() {
  try {
    const raw = JSON.parse(import_node_fs8.default.readFileSync(SHOWN_FILE, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}
function shownDelete(attId) {
  try {
    const prefix = `${attId}|`;
    withShownLock((map) => {
      const hit = attId in map || Object.keys(map).some((k) => k.startsWith(prefix));
      if (!hit) return false;
      delete map[attId];
      for (const k of Object.keys(map)) {
        if (k.startsWith(prefix)) delete map[k];
      }
      return true;
    });
  } catch {
  }
}

// D:/Projects/WebUI/WebUI/lib/server/attachindex/build.ts
function throwIfAborted2(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  const e = new Error("The user aborted this request.");
  e.name = "AbortError";
  throw e;
}
async function buildAttachmentIndex(input) {
  throwIfAborted2(input.signal);
  const chunks = input.segments?.length ? chunkSegments(input.segments) : chunkText(input.fullText);
  if (!chunks.length) throw new Error("Nothing to index \u2014 the content is empty.");
  throwIfAborted2(input.signal);
  let embed = null;
  let embedNote;
  try {
    const vecs = await embedTexts(chunks.map((c) => c.text), input.signal);
    chunks.forEach((c, i) => {
      c.vec = vecs[i] ?? [];
    });
    const dim = chunks.find((c) => c.vec?.length)?.vec.length ?? 0;
    const missing = chunks.filter((c) => !c.vec?.length).length;
    const wrongDim = chunks.filter((c) => c.vec?.length && c.vec.length !== dim).length;
    if (dim > 0 && missing === 0 && wrongDim === 0) {
      embed = {
        model: EMBED_MODEL_ID,
        revision: embedRevision(),
        dim,
        normalized: EMBED_NORMALIZED,
        fingerprint: embedFingerprint(dim)
      };
    } else {
      embedNote = missing ? `${missing}/${chunks.length} chunks have no embedding` : `stored vector dimensions disagree (${dim} expected)`;
    }
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    chunks.forEach((c) => {
      c.vec = [];
    });
    embedNote = `embeddings unavailable (${err?.message ?? String(err)})`;
  }
  throwIfAborted2(input.signal);
  const { blocks, text: spine } = buildSpine(chunks);
  const meta = {
    attId: input.attId,
    name: input.name,
    category: input.category,
    createdAt: Date.now(),
    durationSec: input.durationSec,
    chunkCount: chunks.length,
    spine,
    spineBlocks: blocks,
    frames: input.frames ?? [],
    ...input.observations && input.observations.length ? { observations: input.observations } : {},
    ...input.timeline ? { timeline: input.timeline } : {},
    ...embed ? { embed } : {}
  };
  writeIndex(input.attId, meta, chunks, input.fullText, input.signal);
  return { chunkCount: chunks.length, spine, embed, embedNote };
}

// D:/Projects/WebUI/WebUI/lib/server/attachindex/timeline.ts
var import_node_crypto6 = __toESM(require("node:crypto"));
var import_node_fs9 = __toESM(require("node:fs"));
var import_node_path11 = __toESM(require("node:path"));
var PROBE_TEXT_CAP = 64 * 1024;
var HASH_SKIP_BYTES = 8 * 1024 * 1024 * 1024;
var TIMELINE_RECORD_DIRNAME = "timeline";
var TIMELINE_MAX_OBSERVATIONS = 200;
var TIMELINE_MAX_SPANS = 32;
var TIMELINE_CUT_THRESHOLD = 0.35;
var TIMELINE_SCAN_TIMEOUT_SEC = 45;
var TIMELINE_MAX_WINDOWS = 12;
var TIMELINE_INIT_DEADLINE_MS = 3e4;
var TIMELINE_SCENES_DEADLINE_MS = 9e4;
var FRAME_OCR_CAPABILITY = "video.frame_ocr";
var FRAME_OCR_DEADLINE_MS = 18e4;
var FRAME_OCR_MAX_FRAMES = 12;
var FRAME_OCR_LANGUAGE_ENV = DOCUMENT_OCR_LANGUAGE_ENV;
var DURATION_RE = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/;
var STREAM_RE = /Stream\s+#(\d+):(\d+)(?:\[[^\]]{1,16}\])?(?:\(([^)]{1,16})\))?\s*:\s*([A-Za-z][A-Za-z0-9]*)/g;
var STREAM_START_RE = /start:?\s+(-?\d+(?:\.\d+)?)/;
var ROTATION_DEG_RE = /rotation of\s+(-?\d+(?:\.\d+)?)\s*degrees/;
var ROTATION_TAG_RE = /\brotate\s*[:=]\s*(-?\d+)\b/;
var KNOWN_STREAM_TYPES = /* @__PURE__ */ new Set(["video", "audio", "subtitle", "data"]);
function parseMediaProbe(probeText) {
  const text = (probeText ?? "").slice(0, PROBE_TEXT_CAP);
  const dur = DURATION_RE.exec(text);
  const durationSec = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + parseFloat(dur[3]) : 0;
  const heads = [];
  const re = new RegExp(STREAM_RE.source, "g");
  let m;
  while ((m = re.exec(text)) !== null) {
    heads.push({
      index: m.index,
      end: re.lastIndex,
      fileIndex: Number(m[1]),
      streamIndex: Number(m[2]),
      tag: (m[3] ?? "").trim(),
      type: (m[4] ?? "").toLowerCase()
    });
  }
  const streams = [];
  const subtitleTracks = [];
  const streamStartOffsets = {};
  heads.forEach((h, i) => {
    const tailEnd = i + 1 < heads.length ? heads[i + 1].index : Math.min(text.length, h.end + 4e3);
    const tail = text.slice(h.end, tailEnd);
    const language = /^[a-z]{3}$/i.test(h.tag) ? h.tag.toLowerCase() : "";
    const type = KNOWN_STREAM_TYPES.has(h.type) ? h.type : "other";
    let startSec = null;
    const startMatch = STREAM_START_RE.exec(tail);
    if (startMatch) {
      const value = Number(startMatch[1]);
      if (Number.isFinite(value)) {
        startSec = value;
        streamStartOffsets[`${type}:${h.streamIndex}`] = value;
      }
    }
    streams.push({ fileIndex: h.fileIndex, streamIndex: h.streamIndex, type, language, startSec });
    if (type === "subtitle") {
      subtitleTracks.push(language || `stream ${h.fileIndex}:${h.streamIndex}`);
    }
  });
  let rotationDeg = 0;
  const rot = ROTATION_DEG_RE.exec(text) ?? ROTATION_TAG_RE.exec(text);
  if (rot) {
    const value = Number(rot[1]);
    if (Number.isFinite(value)) rotationDeg = value;
  }
  return {
    durationSec: Number.isFinite(durationSec) ? durationSec : 0,
    streams,
    hasAudioTrack: streams.some((s) => s.type === "audio"),
    subtitleTracks,
    rotationDeg,
    streamStartOffsets
  };
}
function abortError2(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error("the caller cancelled the media baseline");
  err.name = "AbortError";
  return err;
}
async function sha256File(filePath, opts = {}) {
  if (opts.signal?.aborted) throw abortError2(opts.signal);
  const stat = import_node_fs9.default.statSync(filePath);
  const fallback = `size${stat.size}m${Math.round(stat.mtimeMs)}`;
  if (!stat.isFile() || stat.size > HASH_SKIP_BYTES) return { hash: fallback, algorithm: "size+mtime" };
  const hash = import_node_crypto6.default.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = import_node_fs9.default.createReadStream(filePath);
    stream.on("data", (chunk) => {
      if (opts.signal?.aborted) {
        stream.destroy();
        reject(abortError2(opts.signal));
        return;
      }
      hash.update(chunk);
    });
    stream.on("error", (err) => reject(err));
    stream.on("close", () => resolve());
  });
  if (opts.signal?.aborted) throw abortError2(opts.signal);
  return { hash: hash.digest("hex"), algorithm: "sha256" };
}
function envelopePayload(envelope) {
  const result = envelope.result;
  const payload = result?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  return payload;
}
function toSpans(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2) continue;
    const a = Number(item[0]);
    const b = Number(item[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    out.push([a, b]);
    if (out.length >= TIMELINE_MAX_SPANS) break;
  }
  return out;
}
function toCoverage(raw) {
  const c = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const examined = toSpans(c.examined);
  const total = c.total_source === void 0 || c.total_source === null ? null : Number(c.total_source);
  return {
    units: typeof c.units === "string" ? c.units.slice(0, 32) : "seconds",
    totalSec: total !== null && Number.isFinite(total) ? total : null,
    examinedSec: Math.round(examined.reduce((sum, [a, b]) => sum + Math.max(0, b - a), 0) * 100) / 100,
    complete: c.complete === true,
    examined,
    unexamined: toSpans(c.skipped),
    note: typeof c.note === "string" ? c.note.slice(0, 400) : ""
  };
}
function measuredPrefixEnd(value, durationSec, measured) {
  if (!measured || typeof value === "boolean") return 0;
  const end = Number(value);
  const duration = Number(durationSec);
  if (!Number.isFinite(end) || !Number.isFinite(duration)) return 0;
  return Math.min(Math.max(end, 0), Math.max(duration, 0));
}
function sceneObservations(cuts, boundarySec, threshold, options2 = {}) {
  const boundaryMeasured = options2.boundaryMeasured !== false;
  const sorted = [...new Set(
    cuts.map((c) => Number(c)).filter((c) => Number.isFinite(c) && c >= 0 && (boundarySec <= 0 || c <= boundarySec)).map((c) => Math.round(c * 1e3) / 1e3)
  )].sort((a, b) => a - b);
  const starts = boundaryMeasured ? sorted.length ? sorted : [0] : sorted;
  const out = [];
  for (let i = 0; i < starts.length && out.length < TIMELINE_MAX_OBSERVATIONS; i++) {
    const start = starts[i];
    const end = !boundaryMeasured ? start : i + 1 < starts.length ? starts[i + 1] : boundarySec > 0 ? Math.round(boundarySec * 1e3) / 1e3 : start;
    if (end < start) continue;
    out.push({
      start,
      end,
      kind: "scene",
      text: "",
      frame_ref: "",
      audio_state: "unknown",
      provider: `ffmpeg:scene-threshold-${threshold}`
    });
  }
  return out;
}
var FRAME_OCR_TEXT_CAP = 4e3;
var frameNum = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
function interpretFrameOcr(envelope, language, maxObservations = TIMELINE_MAX_OBSERVATIONS) {
  const empty = {
    state: "not_attempted",
    reason: "",
    language,
    planned: 0,
    decoded: 0,
    recognised: 0,
    glyphFree: 0,
    unresolved: 0,
    engine: "",
    readAt: [],
    observations: []
  };
  if (envelope === null) {
    return {
      ...empty,
      state: "not_configured",
      reason: "this deployment has no capability route, so no frame was decoded or read"
    };
  }
  if (envelope.state !== "ready") {
    const reason = envelope.error?.reason ?? envelope.state;
    const message = envelope.error?.message ?? `the frame OCR job ended in state ${envelope.state}`;
    return {
      ...empty,
      state: envelope.state === "cancelled" ? "cancelled" : "failed",
      reason: `${reason}: ${message}`.slice(0, 240)
    };
  }
  const payload = envelopePayload(envelope);
  const counts = payload?.stage_counts && typeof payload.stage_counts === "object" ? payload.stage_counts : null;
  if (!counts) {
    return {
      ...empty,
      state: "failed",
      reason: "contract_mismatch: the frame OCR job reported success with no stage counts, which is refused rather than counted as a video with no text on screen"
    };
  }
  const report = payload?.ocr && typeof payload.ocr === "object" ? payload.ocr : {};
  const blocks = Array.isArray(payload?.blocks) ? payload.blocks : [];
  const observations = [];
  const readAt = [];
  for (const entry of blocks) {
    const block = entry && typeof entry === "object" ? entry : {};
    const start = typeof block.start === "number" && Number.isFinite(block.start) ? block.start : NaN;
    const text = typeof block.text === "string" ? block.text.trim() : "";
    if (!(start >= 0) || !text) continue;
    const engine = typeof block.engine === "string" ? block.engine : "";
    const code = typeof block.language_code === "string" && block.language_code.trim() ? block.language_code.trim() : language;
    let provider = `tesseract${engine ? `@${engine}` : ""}/${code || "unknown"}`;
    let kept = text;
    if (kept.length > FRAME_OCR_TEXT_CAP) {
      kept = kept.slice(0, FRAME_OCR_TEXT_CAP);
      provider += `:truncated@${FRAME_OCR_TEXT_CAP}`;
    }
    readAt.push(start);
    observations.push({
      start,
      end: typeof block.end === "number" && Number.isFinite(block.end) ? block.end : start,
      kind: "ocr",
      text: kept,
      frame_ref: typeof block.frame_digest === "string" ? `frame:${block.frame_digest}` : "",
      audio_state: "unknown",
      provider,
      confidence: typeof block.confidence === "number" && Number.isFinite(block.confidence) ? block.confidence : null
    });
    if (observations.length >= maxObservations) break;
  }
  return {
    state: "ok",
    reason: "",
    language: typeof payload?.language === "string" && payload.language ? payload.language : language,
    planned: frameNum(counts.planned),
    decoded: frameNum(counts.decoded),
    recognised: frameNum(counts.recognised),
    glyphFree: frameNum(counts.glyph_free),
    unresolved: frameNum(counts.unresolved),
    engine: typeof report.engine === "string" ? report.engine : "",
    readAt,
    observations
  };
}
async function buildTimeline(input) {
  const run = input.runJob ?? mlJob;
  const probe = parseMediaProbe(input.probeText);
  const durationSec = input.durationSec > 0 ? input.durationSec : probe.durationSec;
  if (input.signal?.aborted) return null;
  let identity;
  try {
    identity = await sha256File(input.srcPath, { signal: input.signal });
  } catch {
    return null;
  }
  const scratchRoot = input.scratchRoot ?? import_node_path11.default.join(process.cwd(), ".data", "tmp", "timelines");
  const scratchDir = import_node_path11.default.join(scratchRoot, `${input.attId}-${import_node_crypto6.default.randomBytes(4).toString("hex")}`);
  const dropScratch = () => {
    try {
      import_node_fs9.default.rmSync(scratchDir, { recursive: true, force: true });
    } catch {
    }
  };
  try {
    import_node_fs9.default.mkdirSync(scratchDir, { recursive: true });
  } catch {
    return null;
  }
  const meta = {
    source_id: input.attId,
    source_hash: identity.hash,
    duration: durationSec,
    streams: probe.streams.map((s) => ({
      file: s.fileIndex,
      stream: s.streamIndex,
      type: s.type,
      language: s.language,
      start: s.startSec
    })),
    rotation_deg: probe.rotationDeg,
    has_audio_track: probe.hasAudioTrack,
    subtitle_tracks: probe.subtitleTracks,
    stream_start_offsets: probe.streamStartOffsets
  };
  const init = await run(
    "video.timeline",
    { root: scratchDir, op: "init", meta },
    { deadlineMs: TIMELINE_INIT_DEADLINE_MS, signal: input.signal }
  );
  if (!init) return dropScratch(), null;
  const initPayload = init.error ? null : envelopePayload(init);
  let record = initPayload && initPayload.record && typeof initPayload.record === "object" ? initPayload.record : null;
  let reply = initPayload && typeof initPayload.reply === "string" ? initPayload.reply : "";
  if (!record) return dropScratch(), null;
  const sceneScan = {
    state: "not_attempted",
    reason: "",
    scannedSec: 0,
    truncated: false,
    /** Whether the scanned prefix ffmpeg reported is a measurement at all. */
    prefixMeasured: false
  };
  let observations = [];
  let cutTimes = [];
  if (input.detectCuts !== false && durationSec > 0) {
    if (input.signal?.aborted) return dropScratch(), null;
    const threshold = input.cutThreshold ?? TIMELINE_CUT_THRESHOLD;
    const videoOffset = Object.entries(probe.streamStartOffsets).find(([key]) => key.startsWith("video:"))?.[1] ?? 0;
    const scenes = await run(
      "video.scenes",
      {
        duration: durationSec,
        source: import_node_path11.default.resolve(input.srcPath),
        detect_cuts: true,
        cut_threshold: threshold,
        scan_timeout_s: input.scanTimeoutSec ?? TIMELINE_SCAN_TIMEOUT_SEC,
        max_windows: input.maxWindows ?? TIMELINE_MAX_WINDOWS,
        stream_start_offset: Number.isFinite(videoOffset) ? videoOffset : 0
      },
      { deadlineMs: TIMELINE_SCENES_DEADLINE_MS, signal: input.signal }
    );
    if (scenes === null) {
      sceneScan.state = "not_configured";
      sceneScan.reason = "this deployment has no capability route";
    } else if (scenes.error) {
      sceneScan.state = "failed";
      sceneScan.reason = `${scenes.error.reason}: ${scenes.error.message}`.slice(0, 240);
    } else {
      const payload = envelopePayload(scenes);
      const scan = payload?.cut_scan && typeof payload.cut_scan === "object" ? payload.cut_scan : null;
      if (!scan) {
        sceneScan.state = "no_scan";
        sceneScan.reason = "the scenes job returned no cut_scan";
      } else {
        sceneScan.state = scan.ok === true ? "ok" : "failed";
        sceneScan.reason = scan.ok === true ? "" : String(scan.error ?? "the cut scan failed").slice(0, 240);
        sceneScan.truncated = scan.truncated === true;
        sceneScan.prefixMeasured = scan.prefix_measured === true;
        const scanCompleted = scan.ok === true && scan.truncated !== true;
        const measuredPrefix = measuredPrefixEnd(scan.scanned_seconds, durationSec, sceneScan.prefixMeasured);
        const boundarySec = scanCompleted ? durationSec : measuredPrefix;
        sceneScan.scannedSec = scanCompleted ? durationSec : measuredPrefix;
        const boundaryMeasured = scanCompleted || measuredPrefix > 0;
        cutTimes = (Array.isArray(scan.cuts) ? scan.cuts : []).filter((c) => typeof c === "number" && Number.isFinite(c));
        observations = sceneObservations(
          Array.isArray(scan.cuts) ? scan.cuts : [],
          boundaryMeasured ? boundarySec : durationSec,
          Number(scan.threshold) || threshold,
          { boundaryMeasured }
        );
      }
    }
  }
  const scanHappened = sceneScan.state === "ok";
  if (scanHappened || observations.length > 0) {
    if (input.signal?.aborted) return dropScratch(), null;
    const scanCompleted = sceneScan.state === "ok" && !sceneScan.truncated;
    const examinedUntil = scanCompleted ? durationSec : measuredPrefixEnd(sceneScan.scannedSec, durationSec, sceneScan.prefixMeasured);
    const coverage = {
      examined: examinedUntil > 0 ? [[0, examinedUntil]] : [],
      // What the scan never read, stated as a span instead of hidden by an
      // empty list: the next, deeper pass starts from here. An unmeasured prefix
      // leaves the ENTIRE source listed, which is the honest reading of "we do not
      // know how far the decoder got".
      skipped: (() => {
        if (durationSec <= 0) return [];
        if (examinedUntil >= durationSec) return [];
        return [[
          Math.round(examinedUntil * 1e3) / 1e3,
          Math.round(durationSec * 1e3) / 1e3
        ]];
      })(),
      units: "seconds",
      total_source: durationSec > 0 ? durationSec : null,
      complete: false,
      note: scanCompleted ? "scene-cut scan of the video track decoded the whole stream; transcript and keyframe coverage is recorded by the extractor as separate stages" : sceneScan.prefixMeasured ? `scene-cut scan decoded a measured ${examinedUntil}s prefix; the remainder is unexamined, and transcript/keyframe coverage is recorded separately` : "scene-cut scan stopped early with UNMEASURED decoder progress, so no span is claimed as examined; cut timestamps below are point evidence only"
    };
    const observe = await run(
      "video.timeline",
      {
        root: scratchDir,
        op: "observe",
        source_hash: identity.hash,
        stage: "scene-cuts",
        observations,
        coverage
      },
      { deadlineMs: TIMELINE_INIT_DEADLINE_MS, signal: input.signal }
    );
    const observePayload = observe && !observe.error ? envelopePayload(observe) : null;
    if (observePayload?.record && typeof observePayload.record === "object") {
      record = observePayload.record;
      if (typeof observePayload.reply === "string") reply = observePayload.reply;
      sceneScan.state = sceneScan.state === "ok" ? "ok_recorded" : sceneScan.state;
    }
  }
  const frameRead = {
    state: "not_attempted",
    reason: "",
    language: "",
    planned: 0,
    decoded: 0,
    recognised: 0,
    glyphFree: 0,
    unresolved: 0,
    engine: "",
    readAt: []
  };
  if (input.readFrames !== false && durationSec > 0) {
    const language = (input.frameLanguage ?? process.env[FRAME_OCR_LANGUAGE_ENV] ?? "").trim();
    if (!language) {
      frameRead.state = "no_language";
      frameRead.reason = `no text language is configured (set ${FRAME_OCR_LANGUAGE_ENV}); the recogniser refuses to guess English, so on-screen text stays unread rather than becoming Latin noise`;
    } else if (input.signal?.aborted) {
      frameRead.state = "cancelled";
      frameRead.reason = "the request was aborted before any frame was decoded";
    } else {
      frameRead.language = language;
      const media = import_node_path11.default.resolve(input.srcPath);
      const framesJob = await run(
        FRAME_OCR_CAPABILITY,
        {
          path: media,
          root: import_node_path11.default.dirname(media),
          language,
          duration: durationSec,
          // Ask the backend to sample; do not re-implement its sampler here.
          plan: true,
          ...cutTimes.length ? { cuts: cutTimes.slice(0, TIMELINE_MAX_OBSERVATIONS) } : {},
          max_frames: input.maxFrames ?? FRAME_OCR_MAX_FRAMES
        },
        { deadlineMs: FRAME_OCR_DEADLINE_MS, signal: input.signal }
      );
      const read = interpretFrameOcr(framesJob, language);
      frameRead.state = read.state;
      frameRead.reason = read.reason;
      frameRead.language = read.language;
      frameRead.planned = read.planned;
      frameRead.decoded = read.decoded;
      frameRead.recognised = read.recognised;
      frameRead.glyphFree = read.glyphFree;
      frameRead.unresolved = read.unresolved;
      frameRead.engine = read.engine;
      frameRead.readAt = read.readAt;
      if (read.state === "ok" && (read.observations.length > 0 || read.glyphFree > 0)) {
        if (input.signal?.aborted) return dropScratch(), null;
        const frameObs = await run(
          "video.timeline",
          {
            root: scratchDir,
            op: "observe",
            source_hash: identity.hash,
            stage: "frame-ocr",
            observations: read.observations,
            coverage: {
              examined: read.readAt.map((t) => [t, t]),
              skipped: [[0, durationSec]],
              units: "seconds",
              total_source: durationSec,
              complete: false,
              // Zero-width instants: sampling N points reads N points, not the
              // timeline between them, so nothing here closes an interval.
              note: `frame OCR read ${read.recognised} of ${read.planned} sampled instant(s) with tesseract${read.engine ? ` ${read.engine}` : ""} in language ${read.language}; ${read.glyphFree} decoded frame(s) carried no glyph and ${read.unresolved} stayed unresolved. Sampled instants are point evidence: the rest of the timeline is unexamined, and on-screen TEXT is not an interpretation of the picture.`
            }
          },
          { deadlineMs: TIMELINE_INIT_DEADLINE_MS, signal: input.signal }
        );
        const framePayload = frameObs && !frameObs.error ? envelopePayload(frameObs) : null;
        if (framePayload?.record && typeof framePayload.record === "object") {
          record = framePayload.record;
          if (typeof framePayload.reply === "string") reply = framePayload.reply;
          frameRead.state = "ok_recorded";
        }
        observations = observations.concat(read.observations).slice(0, TIMELINE_MAX_OBSERVATIONS);
      }
    }
  }
  const recordMeta = record.meta && typeof record.meta === "object" ? record.meta : {};
  const summary = {
    sourceHash: identity.hash,
    hashAlgorithm: identity.algorithm,
    durationSec,
    streams: probe.streams,
    rotationDeg: probe.rotationDeg,
    hasAudioTrack: probe.hasAudioTrack,
    subtitleTracks: probe.subtitleTracks,
    streamStartOffsets: probe.streamStartOffsets,
    coverage: toCoverage(recordMeta.coverage),
    capability: "video.timeline",
    jobState: init.state,
    sceneScan,
    frameRead,
    recordDir: TIMELINE_RECORD_DIRNAME,
    updatedAt: Date.now()
  };
  return { scratchDir, observations, coverageReply: reply, summary };
}
function attachTimelineDir(attDir, scratchDir) {
  const target = import_node_path11.default.join(attDir, TIMELINE_RECORD_DIRNAME);
  try {
    if (import_node_fs9.default.existsSync(target)) import_node_fs9.default.rmSync(target, { recursive: true, force: true });
    import_node_fs9.default.mkdirSync(attDir, { recursive: true });
    import_node_fs9.default.renameSync(scratchDir, target);
    return true;
  } catch {
    const staged = `${target}.staged-${import_node_crypto6.default.randomBytes(3).toString("hex")}`;
    try {
      copyRecordTree(scratchDir, staged);
      import_node_fs9.default.renameSync(staged, target);
      import_node_fs9.default.rmSync(scratchDir, { recursive: true, force: true });
      return true;
    } catch {
      try {
        import_node_fs9.default.rmSync(staged, { recursive: true, force: true });
      } catch {
      }
      return false;
    }
  }
}
var RECORD_COPY_MAX_ENTRIES = 4096;
var RECORD_COPY_MAX_DEPTH = 6;
function copyRecordTree(from, to, depth = 0) {
  if (depth > RECORD_COPY_MAX_DEPTH) throw new Error("timeline record tree is too deep");
  const entries = import_node_fs9.default.readdirSync(from, { withFileTypes: true });
  if (entries.length > RECORD_COPY_MAX_ENTRIES) throw new Error("timeline record tree is too wide");
  import_node_fs9.default.mkdirSync(to, { recursive: true });
  for (const entry of entries) {
    const src = import_node_path11.default.join(from, entry.name);
    const dst = import_node_path11.default.join(to, entry.name);
    if (entry.isSymbolicLink()) throw new Error("timeline record must not contain links");
    if (entry.isDirectory()) copyRecordTree(src, dst, depth + 1);
    else import_node_fs9.default.copyFileSync(src, dst);
  }
}
function discardTimelineScratch(scratchDir) {
  try {
    import_node_fs9.default.rmSync(scratchDir, { recursive: true, force: true });
  } catch {
  }
}

// D:/Projects/WebUI/WebUI/lib/server/extract/index.ts
var ATT_ID_RE = /^att_[a-z0-9]{4,32}$/;
var PREVIEW_CHARS = 4e3;
function asSegments(segments) {
  return segments.map((s) => ({ text: s.text, start: s.start, end: s.end }));
}
async function cappedOrIndexed(name, category, att, raw, signal) {
  const clean = (raw ?? "").replace(/\r\n/g, "\n").trim();
  if (att && clean.length > TEXT_CHAR_LIMIT) {
    const indexed = await indexContent(name, category, att, clean, {}, signal);
    return { name, category, ...indexed, text: clean.slice(0, PREVIEW_CHARS), truncated: true };
  }
  return { name, category, ...cap(clean) };
}
async function indexContent(name, category, attId, fullText, extra = {}, signal) {
  const hadIndex = hasIndex(attId);
  try {
    const built = await withIndexWriteLock(
      attId,
      () => buildAttachmentIndex({
        attId,
        name,
        category,
        fullText,
        ...extra,
        signal
      })
    );
    return {
      indexed: true,
      chunkCount: built.chunkCount,
      spine: built.spine,
      ...built.embedNote ? { embedNote: built.embedNote } : {}
    };
  } catch (err) {
    const aborted = err?.name === "AbortError";
    if (aborted) {
      try {
        discardStaged(publishPaths(attId), attId);
      } catch {
      }
      throw err;
    }
    if (!hadIndex) removeIndex(attId);
    else {
      try {
        discardStaged(publishPaths(attId), attId);
      } catch {
      }
    }
    if (err?.code === "ENOSPC") {
      const msg = err.message ?? "";
      throw new Error(`Out of disk space while indexing ${name} - free some space and retry (${msg})`);
    }
    throw err;
  }
}
async function deliverSpoken(name, category, att, outcome, signal) {
  const asr = outcome.asr;
  if (!asr.text) {
    const level2 = asr.audioLevel;
    const measured = typeof level2.max_volume_db === "number" ? `the track was decoded and measured at ${level2.max_volume_db.toFixed(1)} dBFS peak, at or below the ${typeof level2.noise_floor_db === "number" ? level2.noise_floor_db.toFixed(0) : "configured"} dBFS noise floor, so no speech could exist in it` : asr.note || "no audible speech was present";
    throw new Error(`No speech detected in ${name}: ${measured}`);
  }
  const note = speechEngineNote(asr);
  const coverage = asr.complete ? "" : `
[speech coverage: ${asr.examined.length} decoded span(s) over ${asr.durationSec.toFixed(1)}s; ${asr.unexamined.length} interval(s) were never decoded, so the absence of speech there is unproven]`;
  const transcript = `${note}
${asr.text}${coverage}`;
  const durationSec = asr.durationSec;
  if (att && transcript.length > TEXT_CHAR_LIMIT) {
    const indexed = await indexContent(
      name,
      category,
      att,
      transcript,
      { segments: asSegments(asr.segments), ...durationSec > 0 ? { durationSec } : {} },
      signal
    );
    return {
      name,
      category,
      ...indexed,
      transcript: transcript.slice(0, PREVIEW_CHARS),
      truncated: true,
      ...durationSec > 0 ? { durationSec } : {}
    };
  }
  const capped = cap(transcript);
  return {
    name,
    category,
    transcript: capped.text,
    truncated: capped.truncated,
    ...durationSec > 0 ? { durationSec } : {}
  };
}
function cap(text, limit = TEXT_CHAR_LIMIT) {
  const clean = (text ?? "").replace(/\r\n/g, "\n").trim();
  if (clean.length <= limit) return { text: clean, truncated: false };
  return { text: clean.slice(0, limit), truncated: true };
}
var TMP_DIR3 = import_node_path12.default.join(process.cwd(), ".data", "tmp");
var TEXT_READ_BYTES = 2 * 1024 * 1024;
var MAX_PARSED_BYTES = 512 * 1024 * 1024;
function readHead(srcPath, maxBytes) {
  const fd = import_node_fs10.default.openSync(srcPath, "r");
  try {
    const size = import_node_fs10.default.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.allocUnsafe(len);
    import_node_fs10.default.readSync(fd, buf, 0, len, 0);
    return { buf, partial: size > len };
  } finally {
    import_node_fs10.default.closeSync(fd);
  }
}
function transformText(category, text) {
  return category === "rtf" ? rtfToText(text) : category === "notebook" ? notebookText(text) : text;
}
function encodingNote(dec) {
  return dec.lossy ? `[encoding: this file is not valid UTF-8 \u2014 decoded as ${dec.encoding}, so some characters may be wrong]

` : "";
}
function textLikeResult(name, category, dec, partial) {
  const capped = cap(transformText(category, dec.text));
  return {
    name,
    category,
    text: capped.text ? encodingNote(dec) + capped.text : capped.text,
    truncated: capped.truncated || partial
  };
}
async function extractFileFromPath(name, srcPath, attId, mime, signal, opts) {
  let category = classifyFile(name, mime);
  const ext = fileExtension(name).toLowerCase();
  const att = attId && ATT_ID_RE.test(attId) ? attId : void 0;
  const sniffed = sniffMagic(readHead(srcPath, 64).buf);
  if (sniffed && sniffed.category !== category) {
    if (sniffed.strong || category === "unknown" || category === "text" && !sniffed.strong && sniffed.category === "archive") {
      category = sniffed.category;
    }
  }
  switch (category) {
    case "text":
    case "rtf":
    case "notebook": {
      const size = import_node_fs10.default.statSync(srcPath).size;
      if (att && size > TEXT_READ_BYTES) {
        const dec2 = decodeText(import_node_fs10.default.readFileSync(srcPath));
        const body = transformText(category, dec2.text).replace(/\r\n/g, "\n").trim();
        if (!body) return { name, category, text: "", truncated: false };
        const clean = encodingNote(dec2) + body;
        const indexed = await indexContent(name, category, att, clean, {}, signal);
        return { name, category, ...indexed, text: clean.slice(0, PREVIEW_CHARS), truncated: true };
      }
      const { buf, partial } = readHead(srcPath, TEXT_READ_BYTES);
      const dec = decodeText(buf);
      if (att && !partial) {
        const clean = encodingNote(dec) + transformText(category, dec.text).replace(/\r\n/g, "\n").trim();
        if (clean.length > TEXT_CHAR_LIMIT) {
          const indexed = await indexContent(name, category, att, clean, {}, signal);
          return { name, category, ...indexed, text: clean.slice(0, PREVIEW_CHARS), truncated: true };
        }
      }
      return textLikeResult(name, category, dec, partial);
    }
    case "pdf":
    case "office":
    case "archive":
    case "legacy": {
      const size = import_node_fs10.default.statSync(srcPath).size;
      if (size > MAX_PARSED_BYTES) {
        throw new Error(
          `${name} is too large to read as a ${category} document (limit ${sizeLimitLabel(MAX_PARSED_BYTES)})`
        );
      }
      const buf = import_node_fs10.default.readFileSync(srcPath);
      if (category === "pdf") {
        let ts = null;
        let tsFail = null;
        try {
          ts = await pdfText(buf);
        } catch (err) {
          tsFail = err;
        }
        const cap2 = await readDocumentViaCapability(srcPath, {
          ...opts?.runJob ? { runJob: opts.runJob } : {},
          ...signal ? { signal } : {}
        });
        if (cap2.state === "ready") {
          const merged = mergePdfUnits(ts ?? { pages: 0, perPage: [], pagesWithoutText: [] }, cap2.doc);
          if (merged.refusal) throw new Error(`${name}: ${merged.refusal}`);
          const mergedResult = await cappedOrIndexed(name, category, att, merged.text, signal);
          return { ...mergedResult, pages: merged.pages, coverageNote: merged.coverageNote };
        }
        if (!ts) {
          if (cap2.state === "none") throw tsFail;
          throw new Error(
            `${name}: ${tsFail instanceof Error ? tsFail.message : String(tsFail)} ` + capabilityBlockerLine(cap2)
          );
        }
        const { text: text2, pages, pagesWithoutText } = ts;
        if (!text2.trim()) {
          if (pages > 0) {
            const capOcrSentence = cap2.state === "unavailable" ? `${capabilityBlockerLine(cap2)} ` : "No OCR engine is installed, so their contents cannot be read as text; ";
            throw new Error(
              `${name} has no text layer \u2014 all ${pages} page(s) are scanned images. ` + capOcrSentence + `send the page you care about as an image and the vision model can read it.`
            );
          }
          throw new Error("No readable text found in this PDF");
        }
        let full = text2;
        if (pagesWithoutText.length) {
          const listed = pagesWithoutText.length <= 15 ? pagesWithoutText.join(", ") : pagesWithoutText.length + " pages";
          full = `[PDF coverage: ${pages - pagesWithoutText.length} of ${pages} page(s) carry a text layer; image-only (scanned) pages: ${listed} \u2014 those pages are NOT readable here (no OCR engine)]

` + text2;
        }
        const r = await cappedOrIndexed(name, category, att, full, signal);
        return {
          ...r,
          pages,
          ...cap2.state === "unavailable" ? { coverageNote: capabilityBlockerLine(cap2) } : {}
        };
      }
      if (category === "office") {
        let tsOffice = "";
        let officeFail = null;
        try {
          tsOffice = officeText(buf, ext);
        } catch (err) {
          officeFail = err;
        }
        const cap2 = await readDocumentViaCapability(srcPath, {
          ...opts?.runJob ? { runJob: opts.runJob } : {},
          ...signal ? { signal } : {}
        });
        if (cap2.state === "ready") {
          const merged = mergeOfficeText(tsOffice, cap2.doc);
          if (merged.refusal) throw new Error(`${name}: ${merged.refusal}`);
          const mergedResult = await cappedOrIndexed(name, category, att, merged.text, signal);
          return { ...mergedResult, ...merged.pages ? { pages: merged.pages } : {}, coverageNote: merged.coverageNote };
        }
        if (officeFail !== null) {
          if (cap2.state === "none") throw officeFail;
          throw new Error(
            `${name}: ${officeFail instanceof Error ? officeFail.message : String(officeFail)} ` + capabilityBlockerLine(cap2)
          );
        }
        if (!tsOffice.trim()) {
          throw new Error(
            "No readable text found in this document" + (cap2.state === "unavailable" ? ` ${capabilityBlockerLine(cap2)}` : "")
          );
        }
        return await cappedOrIndexed(name, category, att, tsOffice, signal);
      }
      if (category === "archive") {
        const arcExt = sniffed && sniffed.category === "archive" ? "zip" : ext;
        return await cappedOrIndexed(name, category, att, await archiveText(buf, arcExt, name), signal);
      }
      const text = extractStrings(buf);
      if (!text.trim()) throw new Error("No readable text found in this file");
      return await cappedOrIndexed(
        name,
        category,
        att,
        "[legacy binary format: text recovered by scanning raw bytes for printable runs \u2014 layout, formatting, and non-printable-encoded characters are lost; treat as a partial recovery]\n\n" + text
      );
    }
    case "image": {
      const img = await imageToDataUrlFromPath(srcPath, { signal });
      return {
        name,
        category,
        dataUrl: img.dataUrl,
        pages: img.pages,
        ...img.frames ? { frames: img.frames } : {}
      };
    }
    case "audio": {
      const sp = await transcribeViaCapability(srcPath, {
        ...opts?.runJob ? { runJob: opts.runJob } : {},
        ...signal ? { signal } : {}
      });
      if (sp.state === "ready" || sp.state === "silence") {
        return await deliverSpoken(name, category, att, sp, signal);
      }
      if (sp.state === "unavailable" && sp.structural) {
        throw new Error(`${name}: ${sp.message}`);
      }
      if (sp.state === "unavailable" && sp.reason === "cancelled") {
        throw new Error("The user aborted this request.");
      }
      try {
        const dec = await decodeAudioPcmFile(srcPath, { signal });
        try {
          const durationSec = dec.samples / 16e3;
          const { text, segments } = durationSec <= 90 ? await transcribePcmSegments(readPcmRange(dec.file, 0, dec.samples), { signal }) : await transcribePcmFile(dec.file, dec.samples, { signal });
          const note = asrCapabilityNote();
          const blocker = sp.state === "unavailable" ? speechBlockerLine(sp) + " " : "";
          if (!text) {
            throw new Error(
              "No speech detected in this audio file" + (note ? ` ${note}` : "")
            );
          }
          const transcript = [blocker, note, text].filter(Boolean).join("\n");
          if (att && transcript.length > TEXT_CHAR_LIMIT) {
            const indexed = await indexContent(name, category, att, transcript, {
              segments: asSegments(segments),
              durationSec
            }, signal);
            return {
              name,
              category,
              ...indexed,
              transcript: transcript.slice(0, PREVIEW_CHARS),
              truncated: true,
              durationSec
            };
          }
          return { name, category, transcript, ...cap(transcript), durationSec };
        } finally {
          try {
            import_node_fs10.default.rmSync(dec.file, { force: true });
          } catch {
          }
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        if (sp.state === "unavailable") {
          throw new Error(
            `${err instanceof Error ? err.message : String(err)} ${speechBlockerLine(sp)}`
          );
        }
        throw err;
      }
    }
    case "video": {
      const { frames, durationSec } = await videoFramesFromPath(srcPath, { signal });
      let probeText = null;
      const probeOnce = async () => {
        if (probeText === null) probeText = await probeInfo(srcPath, { signal });
        return probeText;
      };
      const buildBaseline = async () => {
        if (!att) return null;
        try {
          return await buildTimeline({
            attId: att,
            srcPath,
            probeText: await probeOnce(),
            durationSec,
            signal
          });
        } catch {
          return null;
        }
      };
      const publishBaseline = async (attId2, baseline) => {
        try {
          await withIndexWriteLock(attId2, async () => {
            if (!attachTimelineDir(indexDir(attId2), baseline.scratchDir)) {
              discardTimelineScratch(baseline.scratchDir);
            }
          });
        } catch {
          discardTimelineScratch(baseline.scratchDir);
        }
      };
      const kfPromise = att ? videoKeyframesFromPath(srcPath, framesDir(att), { signal }).catch(() => null) : Promise.resolve(null);
      let transcript;
      let segments = [];
      let speechIssue = null;
      const sp = await transcribeViaCapability(srcPath, {
        ...opts?.runJob ? { runJob: opts.runJob } : {},
        ...signal ? { signal } : {}
      });
      let speechEngine = null;
      let pythonAsr = null;
      if (sp.state === "ready") {
        transcript = sp.asr.text || void 0;
        segments = sp.asr.segments.map((s) => ({ text: s.text, start: s.start, end: s.end }));
        pythonAsr = sp.asr;
        speechEngine = "python";
        if (!transcript) speechIssue = "the speech backend decoded its audio track and found no speech in it";
      } else if (sp.state === "silence") {
        const level2 = sp.asr.audioLevel;
        speechIssue = `no speech was detected in its audio track, which was decoded and measured at ${typeof level2.max_volume_db === "number" ? level2.max_volume_db.toFixed(1) + " dBFS" : "the noise floor"} (a measured verdict, not an inference)`;
        speechEngine = "python";
      } else if (sp.state === "unavailable" && sp.reason === "cancelled") {
        throw new Error("The user aborted this request.");
      } else if (sp.state === "unavailable" && sp.structural) {
        speechIssue = /0 audio streams/i.test(sp.message) ? "it has no audio track (ffprobe found 0 audio streams)" : sp.message;
        speechEngine = "python";
      } else try {
        speechEngine = "typescript";
        const dec = await decodeAudioPcmFile(srcPath, { signal });
        try {
          const spokenDur = dec.samples / 16e3;
          const r = spokenDur <= 90 ? await transcribePcmSegments(readPcmRange(dec.file, 0, dec.samples), { signal }) : await transcribePcmFile(dec.file, dec.samples, { signal });
          transcript = r.text || void 0;
          segments = r.segments;
          if (!transcript) speechIssue = "no speech was detected in its audio track";
        } finally {
          try {
            import_node_fs10.default.rmSync(dec.file, { force: true });
          } catch {
          }
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        const info = await probeOnce();
        speechIssue = /^\s*Stream\s+#\d+:\d+[^\r\n]*Audio/m.test(info) ? `its audio track could not be read (${err?.message ?? "decode failed"})` : "it has no audio track";
      }
      const key = await kfPromise;
      const note = speechEngine === "typescript" ? asrCapabilityNote() : "";
      if (transcript && note) transcript = `${note}
${transcript}`;
      if (transcript && pythonAsr) {
        transcript = `${speechEngineNote(pythonAsr)}
${transcript}`;
      }
      if (!transcript) {
        if (att && key && key.length > 0) {
          const keyframes = key.map((f) => ({ at: f.at, file: "frames/" + f.name }));
          const coverageNote = `Video "${name}"${durationSec > 0 ? ` (${Math.round(durationSec)}s)` : ""}: ${speechIssue ?? "its spoken content could not be read"}. Its visual content WAS read: keyframes were sampled at ${keyframes.length} moment(s) across its timeline, each carrying its video timestamp, so questions about what is ON SCREEN at one of those moments can be answered from them; what happens between, before or after the sampled moments was never examined and cannot be claimed. Questions about what is SPOKEN cannot.`;
          const baseline = await buildBaseline();
          const indexed = await indexContent(name, category, att, coverageNote, {
            durationSec,
            frames: keyframes,
            ...baseline ? { observations: baseline.observations, timeline: baseline.summary } : {}
          }, signal);
          if (baseline) await publishBaseline(att, baseline);
          return {
            name,
            category,
            ...indexed,
            frames,
            durationSec,
            text: coverageNote,
            truncated: false,
            coverageNote
          };
        }
        if (att) try {
          import_node_fs10.default.rmSync(framesDir(att), { recursive: true, force: true });
        } catch {
        }
        return { name, category, frames, durationSec };
      }
      if (att && transcript.length > TEXT_CHAR_LIMIT) {
        const keyframes = (key ?? []).map(
          (f) => ({ at: f.at, file: "frames/" + f.name })
        );
        const baseline = await buildBaseline();
        const indexed = await indexContent(name, category, att, transcript, {
          segments: asSegments(segments),
          durationSec,
          frames: keyframes,
          ...baseline ? { observations: baseline.observations, timeline: baseline.summary } : {}
        }, signal);
        if (baseline) await publishBaseline(att, baseline);
        return {
          name,
          category,
          ...indexed,
          frames,
          durationSec,
          transcript: transcript.slice(0, PREVIEW_CHARS),
          truncated: true
        };
      }
      if (att) try {
        import_node_fs10.default.rmSync(framesDir(att), { recursive: true, force: true });
      } catch {
      }
      const capped = cap(transcript);
      return { name, category, frames, durationSec, transcript: capped.text, truncated: capped.truncated };
    }
    default:
      throw new Error("Unsupported file type: " + (ext ? "." + ext : name));
  }
}

// D:/Projects/WebUI/WebUI/app/api/files/extract/route.ts
var import_node_fs11 = __toESM(require("node:fs"));
var import_node_path13 = __toESM(require("node:path"));
var import_node_crypto7 = require("node:crypto");
var import_node_stream = require("node:stream");
var import_promises = require("node:stream/promises");
var log3 = childLogger("api/files/extract");
var runtime = "nodejs";
var dynamic = "force-dynamic";
var revalidate = 0;
var TMP_DIR4 = import_node_path13.default.join(process.cwd(), ".data", "tmp");
var uploadsSwept = false;
function safeName(raw) {
  const base = import_node_path13.default.basename((raw ?? "").trim()).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
  return (base || "upload").slice(0, 240);
}
function tmpPathFor(name) {
  import_node_fs11.default.mkdirSync(TMP_DIR4, { recursive: true });
  const ext = fileExtension(name).toLowerCase().replace(/[^a-z0-9]/g, "");
  return import_node_path13.default.join(TMP_DIR4, "u_" + (0, import_node_crypto7.randomBytes)(6).toString("hex") + (ext ? "." + ext : ""));
}
async function POST(req) {
  const name = safeName(req.nextUrl.searchParams.get("name"));
  const attRaw = req.nextUrl.searchParams.get("att");
  const att = attRaw && /^att_[a-z0-9]{4,32}$/.test(attRaw) ? attRaw : void 0;
  let tmp = null;
  try {
    if (!req.body) {
      return import_server.NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }
    tmp = tmpPathFor(name);
    const src = import_node_stream.Readable.fromWeb(req.body);
    let size = 0;
    src.on("data", (chunk) => {
      size += chunk.length;
    });
    await (0, import_promises.pipeline)(src, import_node_fs11.default.createWriteStream(tmp));
    if (size === 0) {
      return import_server.NextResponse.json({ error: "File is empty" }, { status: 400 });
    }
    if (!uploadsSwept) {
      uploadsSwept = true;
      try {
        sweepOrphanUploads();
      } catch {
      }
    }
    const mime = req.headers.get("content-type") ?? void 0;
    const result = await extractFileFromPath(name, tmp, att, mime, req.signal);
    if (att) {
      try {
        storeUpload(tmp, att, fileExtension(name));
        tmp = null;
      } catch {
      }
    }
    return import_server.NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Extraction failed";
    log3.error({ file: name }, `extraction failed: ${msg}`);
    return import_server.NextResponse.json({ error: msg }, { status: 422 });
  } finally {
    if (tmp) {
      try {
        import_node_fs11.default.rmSync(tmp, { force: true });
      } catch {
      }
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  POST,
  dynamic,
  revalidate,
  runtime
});
