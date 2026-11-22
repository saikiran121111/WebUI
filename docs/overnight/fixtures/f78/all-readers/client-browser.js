"use strict";
var rukeReader = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
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
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // D:/Projects/WebUI/WebUI/lib/files/docProcessor.ts
  var docProcessor_exports = {};
  __export(docProcessor_exports, {
    processAttachment: () => processAttachment,
    validateAttachment: () => validateAttachment
  });

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
  var ACCEPT_EXTENSIONS = Object.keys(EXT_CATEGORY).map((e) => "." + e).join(",") + ",Dockerfile,Makefile";

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

  // D:/Projects/WebUI/WebUI/lib/files/docProcessor.ts
  var MAX_IMAGE_SIDE = 1280;
  function kindFor(cat) {
    if (cat === "image") return "image";
    if (cat === "video") return "video";
    if (cat === "unknown") return "other";
    return "document";
  }
  function cap(text) {
    const clean = (text ?? "").replace(/\r\n/g, "\n").trim();
    if (clean.length <= TEXT_CHAR_LIMIT) return { text: clean, truncated: false };
    return { text: clean.slice(0, TEXT_CHAR_LIMIT), truncated: true };
  }
  function validateAttachment(file) {
    if (file.size === 0) throw new Error(`${file.name} is empty`);
    const category = classifyFile(file.name, file.type);
    return {
      id: "att_" + Math.random().toString(36).slice(2, 12),
      name: file.name,
      kind: kindFor(category),
      category,
      mime: file.type || "",
      size: file.size,
      status: "pending"
    };
  }
  async function processAttachment(file, base, signal) {
    const att = { ...base, status: "processing" };
    try {
      switch (att.category) {
        case "text": {
          if (file.size > TEXT_CHAR_LIMIT) return await extractOnServer(file, att, signal);
          const dec = decodeText(new Uint8Array(await file.arrayBuffer()));
          const capped = cap(dec.text);
          const note = dec.lossy ? `[encoding: this file is not valid UTF-8 \u2014 decoded as ${dec.encoding}, so some characters may be wrong]

` : "";
          return {
            ...att,
            text: capped.text ? note + capped.text : capped.text,
            truncated: capped.truncated,
            status: "ready"
          };
        }
        case "image":
          try {
            const { dataUrl, width, height, frames } = await encodeImage(file);
            return {
              ...att,
              dataUrl,
              width,
              height,
              ...frames?.length ? { frames } : {},
              status: "ready"
            };
          } catch {
            return await extractOnServer(file, att, signal);
          }
        default:
          return await extractOnServer(file, att, signal);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not read this file";
      console.warn("[attachment]", att.name, "-", message);
      return { ...att, status: "error", error: message };
    }
  }
  async function extractOnServer(file, att, signal) {
    const res = await fetch(
      `/api/files/extract?name=${encodeURIComponent(file.name)}&att=${encodeURIComponent(att.id)}`,
      {
        method: "POST",
        body: file,
        headers: { "content-type": file.type || "application/octet-stream" },
        ...signal ? { signal } : {}
      }
    );
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.error) {
      throw new Error(data?.error ?? `Extraction failed (${res.status})`);
    }
    const category = data.category ?? att.category;
    return {
      ...att,
      category,
      kind: kindFor(category),
      text: data.text,
      truncated: data.truncated,
      pages: data.pages,
      transcript: data.transcript,
      dataUrl: data.dataUrl,
      frames: data.frames,
      durationSec: data.durationSec,
      // Knowledge-index markers: the full content lives on the server, and the
      // chat route retrieves passages per question from these.
      indexed: data.indexed,
      indexId: data.indexed ? att.id : void 0,
      chunkCount: data.chunkCount,
      spine: data.spine,
      status: "ready"
    };
  }
  function encodeRegion(bitmap, y, h) {
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, h));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is unavailable in this browser");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, y, bitmap.width, h, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    if (dataUrl.length < 200) throw new Error("Image could not be encoded");
    return { dataUrl, width, height };
  }
  var MAX_STRIP_FRAMES = 8;
  async function encodeImage(file) {
    const bitmap = await createImageBitmap(file);
    try {
      const overview = encodeRegion(bitmap, 0, bitmap.height);
      let frames;
      if (bitmap.height > bitmap.width * 2.5 && bitmap.height > MAX_IMAGE_SIDE) {
        const stripH = Math.max(1, Math.min(bitmap.height, Math.round(bitmap.width * 1.5)));
        const step = Math.max(1, Math.round(stripH * 0.9));
        frames = [];
        for (let y = 0; y < bitmap.height && frames.length < MAX_STRIP_FRAMES; y += step) {
          const h = Math.min(stripH, bitmap.height - y);
          if (h < 64 && frames.length > 1) break;
          frames.push({ dataUrl: encodeRegion(bitmap, y, h).dataUrl, at: frames.length + 1 });
          if (y + h >= bitmap.height) break;
        }
        if (!frames.length) frames = void 0;
      }
      return { ...overview, ...frames ? { frames } : {} };
    } finally {
      bitmap.close?.();
    }
  }
  return __toCommonJS(docProcessor_exports);
})();
