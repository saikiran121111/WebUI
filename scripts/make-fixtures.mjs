/**
 * Generates the attachment fixtures used by tests/file-reading.spec.ts.
 *
 * Every fixture carries its own marker string (READABLE-MARKER-<EXT>-7QX9) so a
 * passing test proves the model actually read that specific file, rather than
 * guessing a shared answer. Audio fixtures are real synthesized speech and
 * carry a spoken codeword instead ("zephyr"), because that is what a
 * transcription test can reliably check.
 *
 * All tooling used here lives inside this codebase (node_modules): ffmpeg for
 * media, 7za for bz2/xz/7z. Windows' own speech synthesizer produces the audio.
 *
 * Run: node scripts/make-fixtures.mjs
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "fixtures");
const TMP = path.join(ROOT, ".data", "tmp", "fixtures");

const FFMPEG = path.join(ROOT, "node_modules", "ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const SEVENZ = path.join(ROOT, "node_modules", "7zip-bin", "win", "x64", "7za.exe");
const FONT = "C\\:/Windows/Fonts/arial.ttf";

const manifest = [];

function markerFor(ext) {
  const tag = ext.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return `READABLE-MARKER-${tag}-7QX9`;
}

function write(name, data) {
  const p = path.join(OUT, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return p;
}

function add(name, category, expect, note) {
  manifest.push({ file: name, category, expect, ...(note ? { note } : {}) });
}

function skip(name, category, note) {
  manifest.push({ file: null, name, category, skip: true, note });
}

/* ── tiny binary writers (no external deps) ──────────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/** Uncompressed (stored) ZIP — readZip in lib/server/extract reads these. */
function zip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), "utf8");
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 8); // flags
    lh.writeUInt16LE(0, 10); // method: stored
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    local.push(lh, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 10); // method: stored
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += lh.length + name.length + data.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cdBuf, eocd]);
}

/**
 * ustar archive — read by tarMembers() in lib/server/extract/archives.ts and
 * validated against GNU tar. The checksum field is 8 bytes at 148 and is
 * treated as spaces while summing, which is what real readers expect; writing
 * it any wider spills into the typeflag byte at 156.
 */
function tar(entries) {
  const blocks = [];
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), "utf8");
    const header = Buffer.alloc(512);
    header.write(e.name.slice(0, 99), 0, "utf8");
    header.write("0000644\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");      // uid
    header.write("0000000\0", 116, "ascii");      // gid
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124, "ascii"); // size
    header.write("00000000000\0", 136, "ascii");  // mtime
    header[156] = 0x30;                           // typeflag: regular file
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    header.fill(0x20, 148, 156);                  // blank the checksum field first
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    blocks.push(header, data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

/** Minimal one-page PDF with real xref offsets — pdf.js parses this. */
function pdf(lines) {
  const esc = s => s.replace(/([\\()])/g, "\\$1");
  const stream =
    "BT /F1 22 Tf 60 780 Td 30 TL\n" +
    lines.map(l => `(${esc(l)}) Tj T*`).join("\n") +
    "\nET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** MATLAB v4 char array — a real .mat the strings reader can recover text from. */
function matFile(text) {
  const header = Buffer.alloc(128, 0x20);
  header.write("MATLAB 4.0 Mat File, written by scripts/make-fixtures.mjs", 0, "ascii");
  const utf16 = Buffer.from(text, "utf16le");
  const mi = Buffer.alloc(20);
  mi.writeInt32LE(2, 0); // mxCHAR_CLASS
  mi.writeInt32LE(1, 4); // rows
  mi.writeInt32LE(text.length, 8); // cols
  mi.writeInt32LE(0, 12); // no imaginary part
  mi.writeInt32LE(utf16.length, 16);
  return Buffer.concat([header, mi, utf16]);
}

/**
 * Legacy .doc/.xls/.ppt: OLE2 compound file. Writing a genuine one needs a
 * proprietary-format writer we do not have, so these fixtures carry the real
 * OLE2 magic plus the text the way those formats store it (ASCII + UTF-16LE),
 * which is exactly what the strings extractor looks for.
 */
function oleFile(marker, label) {
  const magic = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const sectors = Buffer.alloc(512, 0);
  const ascii = Buffer.from(
    `\r\n${label}\r\nMarker: ${marker}\r\nThis legacy document carries its text as plain runs.\r\n`,
    "latin1",
  );
  const utf16 = Buffer.from(`Marker: ${marker}`, "utf16le");
  const tail = Buffer.alloc(256, 0x55);
  return Buffer.concat([magic, Buffer.alloc(8, 0), sectors, ascii, Buffer.alloc(64, 0), utf16, tail]);
}

/* ── ffmpeg / 7za / speech helpers ───────────────────────────────────────── */

function ff(args, opts = {}) {
  return execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    cwd: TMP,
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

function sevenz(args) {
  return execFileSync(SEVENZ, ["-y", ...args], { cwd: TMP, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * 7za can read .bz2 but cannot write one, so the fixture is compressed with
 * whatever bzip2 encoder is already on this machine (Git ships one, Python's
 * stdlib has another). This is fixture generation only — the app's own .bz2
 * reader still goes through the bundled 7za.
 */
function bzip2File(srcAbs, dstAbs) {
  try {
    fs.copyFileSync(srcAbs, dstAbs);
    execFileSync("bzip2", ["-9", "-f", dstAbs], { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch { /* fall through */ }
  for (const py of ["python", "python3"]) {
    try {
      execFileSync(py, ["-I", "-c",
        "import bz2,sys;open(sys.argv[2],'wb').write(bz2.compress(open(sys.argv[1],'rb').read()))",
        srcAbs, dstAbs], { stdio: ["ignore", "pipe", "pipe"] });
      return true;
    } catch { /* try the next one */ }
  }
  return false;
}

/**
 * NB: drawtext wants textfile= BEFORE fontfile= — the other order makes this
 * ffmpeg build claim both text and a text file were supplied.
 */
function drawText(textFile, { fontsize, color, box }) {
  return `drawtext=textfile=${textFile}:fontfile=${FONT}:fontsize=${fontsize}:fontcolor=${color}` +
    (box ? `:box=1:boxcolor=${box}:boxborderw=12` : "") +
    `:x=(w-text_w)/2:y=(h-text_h)/2`;
}

/** Raster image with the marker drawn on it, then converted to each format. */
function drawImage(out, { size, fontsize, lines, extra = [] }) {
  fs.writeFileSync(path.join(TMP, "draw.txt"), lines.join("\n"), "utf8");
  const filter = `color=c=white:s=${size},${drawText("draw.txt", { fontsize, color: "black" })}`;
  ff(["-f", "lavfi", "-i", filter, "-frames:v", "1", ...extra, out]);
  const p = path.join(TMP, out);
  if (!fs.existsSync(p) || fs.statSync(p).size < 64) throw new Error("image render failed: " + out);
  return fs.readFileSync(p);
}

/** Video clip with the marker burned in for the whole duration. */
function drawVideo(out, { marker, extra }) {
  fs.writeFileSync(path.join(TMP, "drawvid.txt"), marker, "utf8");
  // A slow animated gradient rather than testsrc: there is real motion, so the
  // extractor's frames genuinely come from different points in the clip, but
  // nothing competes with the marker for the model's attention.
  ff([
    "-f", "lavfi", "-i", "gradients=size=960x540:duration=6:rate=15:c0=0x101010:c1=0x282828:c2=0x181818",
    "-vf", drawText("drawvid.txt", { fontsize: 54, color: "white", box: "black" }),
    ...extra, out,
  ]);
  const p = path.join(TMP, out);
  if (!fs.existsSync(p) || fs.statSync(p).size < 256) throw new Error("video render failed: " + out);
  return fs.readFileSync(p);
}

/**
 * Real spoken audio through SAPI, Windows' built-in voice. System.Speech's
 * managed API has no SetWavOutputFile in this PowerShell, so the COM voice is
 * pointed at a file stream instead. Handles close when PowerShell exits.
 */
function speakWav(wavName, words) {
  const ps = path.join(TMP, "speak.ps1");
  fs.writeFileSync(
    ps,
    `$ErrorActionPreference = "Stop"\n` +
    `$fmt = New-Object -ComObject SAPI.SpFileStream\n` +
    `$fmt.Open("${path.join(TMP, wavName)}", 3)\n` +  // SSFMCreateForWrite
    `$v = New-Object -ComObject SAPI.SpVoice\n` +
    `$v.AudioOutputStream = $fmt\n` +
    `$v.Rate = -2\n` +
    `$v.Speak("${words}")\n`,
    "utf8",
  );
  execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const p = path.join(TMP, wavName);
  if (!fs.existsSync(p) || fs.statSync(p).size < 1000) throw new Error("speech synthesis produced no audio");
  return fs.readFileSync(p);
}

/** First real line of a failed tool's stderr — the useful part of a skip note. */
function why(err) {
  const lines = (err.stderr?.toString() || err.message || "")
    .split("\n").map(s => s.trim())
    .filter(Boolean).filter(l => !/fontconfig/i.test(l)); // that warning is always noise
  return (lines.find(l => /error|invalid|unsupported|no such/i.test(l)) || lines[0] || "unknown").slice(0, 90);
}

/* ── the fixtures ────────────────────────────────────────────────────────── */

function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });

  /* text / code / config / markup */
  const TEXT_EXTS = [
    "txt", "csv", "tsv", "md", "json", "jsonl", "xml", "html", "htm", "yaml", "yml",
    "toml", "ini", "log", "py", "js", "jsx", "ts", "tsx", "java", "c", "cpp", "h",
    "hpp", "cs", "go", "rs", "php", "rb", "swift", "kt", "kts", "scala", "sh", "bash",
    "zsh", "ps1", "bat", "cmd", "sql", "r", "m", "tex", "bib", "diff", "patch", "env",
    "conf", "cfg", "properties", "graphql", "gql", "proto", "dockerfile", "makefile",
    "tf", "hcl", "vue", "svelte", "astro",
  ];
  for (const ext of TEXT_EXTS) {
    const marker = markerFor(ext);
    // Dockerfile/Makefile are named the way real projects name them — a suffix
    // the classifier can actually see (a bare "fixture-dockerfile" has no extension).
    const name = ext === "dockerfile" ? "fixture.Dockerfile"
      : ext === "makefile" ? "fixture.Makefile"
      : `fixture-txt.${ext}`;
    write(name,
      `WebUI attachment fixture (.${ext})\n` +
      `Marker: ${marker}\n` +
      `If you can read this line, the .${ext} attachment path works end to end.\n`);
    add(name, "text", marker);
  }

  // SVG is text to our classifier, and the marker sits in a real <text> node.
  {
    const marker = markerFor("svg");
    write("fixture-image.svg",
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="120">\n` +
      `  <rect width="400" height="120" fill="white"/>\n` +
      `  <text x="20" y="70" font-size="26" fill="black">${marker}</text>\n</svg>\n`);
    add("fixture-image.svg", "text", marker);
  }

  /* RTF */
  {
    const marker = markerFor("rtf");
    write("fixture-doc.rtf",
      `{\\rtf1\\ansi\\deff0 {\\fonttbl{\\f0 Arial;}}\n` +
      `\\f0\\fs28 WebUI attachment fixture.\\par\n` +
      `Marker: {\\b ${marker}}\\par\n` +
      `This proves the RTF reader works.\\par}\n`);
    add("fixture-doc.rtf", "rtf", marker);
  }

  /* Jupyter notebook */
  {
    const marker = markerFor("ipynb");
    write("fixture-notebook.ipynb", JSON.stringify({
      cells: [
        { cell_type: "markdown", metadata: {}, source: [`# WebUI notebook fixture\n`, `Marker: ${marker}`] },
        { cell_type: "code", execution_count: 1, metadata: {}, outputs: [{ output_type: "stream", text: [`printed ${marker}\n`], name: "stdout" }], source: [`print("${marker}")`] },
      ],
      metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" }, language_info: { name: "python" } },
      nbformat: 4, nbformat_minor: 5,
    }, null, 1));
    add("fixture-notebook.ipynb", "notebook", marker);
  }

  /* PDF */
  {
    const marker = markerFor("pdf");
    write("fixture-doc.pdf", pdf([
      "WebUI attachment fixture (PDF)",
      `Marker: ${marker}`,
      "If you can read this, the PDF text layer was extracted.",
    ]));
    add("fixture-doc.pdf", "pdf", marker);
  }

  /* Office Open XML + ODF + EPUB */
  const officeDocs = {
    "fixture-doc.docx": ["[Content_Types].xml", "_rels/.rels", "word/document.xml"],
  };
  {
    const marker = markerFor("docx");
    write("fixture-doc.docx", zip([
      { name: "[Content_Types].xml", data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>` },
      { name: "_rels/.rels", data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
      { name: "word/document.xml", data: `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>WebUI attachment fixture (DOCX)</w:t></w:r></w:p><w:p><w:r><w:t>Marker: ${marker}</w:t></w:r></w:p></w:body></w:document>` },
    ]));
    add("fixture-doc.docx", "office", marker);
    void officeDocs;
  }
  for (const ext of ["xlsx", "xlsm"]) {
    const marker = markerFor(ext);
    write(`fixture-sheet.${ext}`, zip([
      { name: "[Content_Types].xml", data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>` },
      { name: "_rels/.rels", data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
      { name: "xl/workbook.xml", data: `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Sheet1" sheetId="1"/></sheets></workbook>` },
      { name: "xl/sharedStrings.xml", data: `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><t>WebUI attachment fixture (${ext.toUpperCase()})</t><t>Marker: ${marker}</t></sst>` },
      { name: "xl/worksheets/sheet1.xml", data: `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Marker: ${marker}</t></is></c></row></sheetData></worksheet>` },
    ]));
    add(`fixture-sheet.${ext}`, "office", marker);
  }
  {
    const marker = markerFor("pptx");
    write("fixture-slides.pptx", zip([
      { name: "[Content_Types].xml", data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>` },
      { name: "_rels/.rels", data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/slides/slide1.xml"/></Relationships>` },
      { name: "ppt/slides/slide1.xml", data: `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>WebUI attachment fixture (PPTX)</a:t></a:r></a:p><a:p><a:r><a:t>Marker: ${marker}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>` },
    ]));
    add("fixture-slides.pptx", "office", marker);
  }
  for (const ext of ["odt", "ods", "odp"]) {
    const marker = markerFor(ext);
    write(`fixture-office.${ext}`, zip([
      { name: "mimetype", data: `application/vnd.oasis.opendocument.${ext}` },
      { name: "content.xml", data: `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>WebUI attachment fixture (${ext.toUpperCase()})</text:p><text:p>Marker: ${marker}</text:p></office:text></office:body></office:document-content>` },
    ]));
    add(`fixture-office.${ext}`, "office", marker);
  }
  {
    const marker = markerFor("epub");
    write("fixture-book.epub", zip([
      { name: "mimetype", data: "application/epub+zip" },
      { name: "META-INF/container.xml", data: `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>` },
      { name: "OEBPS/content.opf", data: `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest></package>` },
      { name: "OEBPS/chapter.xhtml", data: `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><h1>WebUI attachment fixture (EPUB)</h1><p>Marker: ${marker}</p></body></html>` },
    ]));
    add("fixture-book.epub", "office", marker);
  }

  /* Legacy binary formats */
  for (const ext of ["doc", "xls", "ppt"]) {
    const marker = markerFor(ext);
    write(`fixture-legacy.${ext}`, oleFile(marker, `WebUI legacy fixture (.${ext})`));
    add(`fixture-legacy.${ext}`, "legacy", marker, "synthetic OLE2 container: no public writer exists for the legacy binary format");
  }
  {
    const marker = markerFor("mat");
    write("fixture-data.mat", matFile(`WebUI fixture. Marker: ${marker}`));
    add("fixture-data.mat", "legacy", marker);
  }

  /* Archives */
  {
    const marker = markerFor("zip");
    write("fixture-archive.zip", zip([
      { name: "README.txt", data: `WebUI archive fixture\nMarker: ${marker}\n` },
      { name: "data/notes.md", data: `Second member, also readable. Marker repeated: ${marker}\n` },
    ]));
    add("fixture-archive.zip", "archive", marker);
  }
  {
    const marker = markerFor("tar");
    write("fixture-archive.tar", tar([{ name: "README.txt", data: `WebUI archive fixture\nMarker: ${marker}\n` }]));
    add("fixture-archive.tar", "archive", marker);
  }
  {
    const marker = markerFor("gz");
    write("fixture-notes.gz", zlib.gzipSync(Buffer.from(`WebUI gzip fixture\nMarker: ${marker}\n`, "utf8")));
    add("fixture-notes.gz", "archive", marker);
  }
  {
    const marker = markerFor("tgz");
    write("fixture-archive.tgz", zlib.gzipSync(tar([{ name: "README.txt", data: `WebUI tar.gz fixture\nMarker: ${marker}\n` }])));
    add("fixture-archive.tgz", "archive", marker);
  }
  // .bz2 wraps a bare file (the extractor's single-file branch); .xz and .7z
  // wrap a tar (its tar-unwrap branch).
  // Named the way real ones are: the inner file's extension stays visible in
  // the outer name, because a bare bz2/xz stream does not store filenames.
  const compressed = [
    { fmt: "bz2", out: "fixture-notes.txt.bz2", wraps: "file" },
    { fmt: "xz", out: "fixture-archive.tar.xz", wraps: "tar" },
    { fmt: "7z", out: "fixture-archive.7z", wraps: "tar" },
  ];
  for (const { fmt, out, wraps } of compressed) {
    const marker = markerFor(fmt);
    try {
      const dst = path.join(TMP, "compressed." + fmt);
      if (wraps === "file") {
        const plain = path.join(TMP, "plain.txt");
        fs.writeFileSync(plain, `WebUI ${fmt} fixture\nMarker: ${marker}\n`, "utf8");
        if (!bzip2File(plain, dst)) {
          skip(out, "archive", "no bzip2 encoder available on this machine to build the fixture");
          continue;
        }
      } else {
        const inner = path.join(TMP, "inner.tar");
        fs.writeFileSync(inner, tar([{ name: "README.txt", data: `WebUI ${fmt} fixture\nMarker: ${marker}\n` }]));
        sevenz(["a", `-t${fmt}`, "compressed." + fmt, inner]);
      }
      write(out, fs.readFileSync(dst));
      add(out, "archive", marker);
    } catch (err) {
      skip(out, "archive", "could not create it: " + why(err));
    }
  }
  skip("fixture-archive.rar", "archive",
    "no .rar writer exists anywhere (proprietary); the unrar reader ships in the app but cannot be exercised by a generated file");

  /* Images */
  const imageJobs = [
    ["fixture-image.png", "png", ["-c:v", "png"], 900, 400, 40],
    ["fixture-image.jpg", "jpg", ["-c:v", "mjpeg", "-q:v", "2"], 900, 400, 40],
    ["fixture-image.jpeg", "jpeg", ["-c:v", "mjpeg", "-q:v", "2"], 900, 400, 40],
    ["fixture-image.gif", "gif", ["-c:v", "gif"], 900, 400, 40],
    ["fixture-image.bmp", "bmp", ["-c:v", "bmp"], 900, 400, 40],
    ["fixture-image.webp", "webp", ["-c:v", "libwebp"], 900, 400, 40],
    ["fixture-image.tif", "tif", ["-c:v", "tiff"], 900, 400, 40],
    ["fixture-image.tiff", "tiff", ["-c:v", "tiff"], 900, 400, 40],
    ["fixture-image.avif", "avif", ["-c:v", "libaom-av1", "-crf", "24", "-cpu-used", "8"], 640, 400, 34],
    // PNG-in-ico insists on rgba, so the pixel format has to be set explicitly.
    ["fixture-image.ico", "ico", ["-vf", "scale=256:256,format=rgba", "-c:v", "png"], 256, 256, 26],
  ];
  for (const [name, ext, extra, w, h, fontsize] of imageJobs) {
    const marker = markerFor(ext);
    const lines = ext === "ico"
      ? ["READABLE", "MARKER-ICO", "7QX9"]
      : [marker, "WebUI image attachment fixture"];
    try {
      write(name, drawImage(path.basename(name), { size: `${w}x${h}`, fontsize, lines, extra }));
      add(name, "image", ext === "ico" ? "READABLEMARKERICO7QX9" : marker);
    } catch (err) {
      skip(name, "image", "bundled ffmpeg could not encode it: " + why(err));
    }
  }
  skip("fixture-image.heic", "image",
    "the bundled ffmpeg build has no HEIF encoder and no HEIF demuxer; the app still tries it via ffmpeg and reports the failure");
  skip("fixture-image.heif", "image", "same as .heic — no encoder/demuxer in the bundled ffmpeg build");

  /* Audio — real synthesized speech, checked by the spoken codeword */
  const CODEWORD = "zephyr";
  const spoken = `The codeword is ${CODEWORD}. Remember, the codeword is ${CODEWORD}. ` +
    `This audio file tests the WebUI attachment reader.`;
  let speech = null;
  try {
    speech = speakWav("speech.wav", spoken);
  } catch (err) {
    console.error("speech synthesis failed:", err.message);
  }
  const audioJobs = [
    ["fixture-audio.wav", ["-c:a", "pcm_s16le"]],
    ["fixture-audio.mp3", ["-c:a", "libmp3lame", "-q:a", "4"]],
    ["fixture-audio.m4a", ["-c:a", "aac", "-f", "ipod"]],
    ["fixture-audio.aac", ["-c:a", "aac", "-f", "adts"]],
    ["fixture-audio.ogg", ["-c:a", "libvorbis"]],
    ["fixture-audio.flac", ["-c:a", "flac"]],
  ];
  for (const [name, extra] of audioJobs) {
    if (!speech) { skip(name, "audio", "Windows speech synthesis was unavailable"); continue; }
    try {
      fs.writeFileSync(path.join(TMP, "src.wav"), speech);
      ff(["-i", "src.wav", ...extra, path.basename(name)]);
      write(name, fs.readFileSync(path.join(TMP, name)));
      add(name, "audio", CODEWORD);
    } catch (err) {
      skip(name, "audio", "bundled ffmpeg could not encode it: " + why(err));
    }
  }

  /* Video — marker burned into every frame */
  const videoJobs = [
    ["fixture-video.mp4", ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast"]],
    ["fixture-video.mov", ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast"]],
    ["fixture-video.mkv", ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast"]],
    ["fixture-video.webm", ["-c:v", "libvpx-vp9", "-crf", "40", "-b:v", "0", "-cpu-used", "8"]],
    // h263 is capped near 4CIF, and downscaling the frame shrinks the burned-in
    // text with it — 704x576 keeps the marker big enough to read after scaling.
    ["fixture-video.3gp", ["-c:v", "h263", "-s", "704x576", "-pix_fmt", "yuv420p"]],
    ["fixture-video.mpeg", ["-c:v", "mpeg2video", "-pix_fmt", "yuv420p", "-q:v", "6"]],
    ["fixture-video.mpg", ["-c:v", "mpeg2video", "-pix_fmt", "yuv420p", "-q:v", "6"]],
  ];
  for (const [name, extra] of videoJobs) {
    const ext = name.split(".").pop();
    const marker = markerFor(ext);
    try {
      write(name, drawVideo(path.basename(name), { marker, extra }));
      add(name, "video", marker);
    } catch (err) {
      skip(name, "video", "bundled ffmpeg could not encode it: " + why(err));
    }
  }

  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.rmSync(TMP, { recursive: true, force: true });

  const generated = manifest.filter(m => m.file).length;
  const skipped = manifest.filter(m => !m.file);
  console.log(`fixtures: ${generated} generated in tests/fixtures/, ${skipped.length} skipped`);
  for (const s of skipped) console.log(`  skipped ${s.name} (${s.category}) — ${s.note}`);
}

main();
