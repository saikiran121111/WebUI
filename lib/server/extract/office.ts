import { readZipDetailed, ZipEntry, ZipLimits } from "./zip";

/** Decode + strip XML tags down to readable text. */
function xmlToText(xml: string): string {
  return xml
    .replace(/<w:tab[^>]*\/>/g, "\t")
    .replace(/<a:br\s*\/>|<w:br\s*\/>/g, "\n")
    .replace(/<\/w:p>|<\/a:p>|<\/text:p>|<\/text:h>|<\/html:br>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEnt(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}

function textsFromTags(xml: string, tag: RegExp): string {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = tag.exec(xml)) !== null) out.push(m[1]);
  return out.join("\n");
}

/** Shared-string table entries — rich-text runs inside <si> are concatenated. */
function sharedStrings(xml: string): string[] {
  const out: string[] = [];
  const siRe = /<si>([\s\S]*?)<\/si>|<si\/>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml)) !== null) {
    const inner = m[1] ?? "";
    out.push(
      [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
        .map((t) => decodeEnt(t[1]))
        .join(""),
    );
  }
  return out;
}

/** Worksheet XML → `REF=value` lines, row by row (D25: cells, not dictionaries). */
function worksheetText(xml: string, shared: string[]): string {
  const lines: string[] = [];
  const rowRe = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(xml)) !== null) {
    const body = rm[1] ?? "";
    const cells: string[] = [];
    const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm: RegExpExecArray | null;
    while ((cm = cRe.exec(body)) !== null) {
      const attrs = cm[1] || "";
      const inner = cm[2] ?? "";
      const ref = /r="([A-Za-z]+\d+)"/.exec(attrs)?.[1] ?? "?";
      const t = /t="([^"]+)"/.exec(attrs)?.[1] ?? "n";
      let val = "";
      if (t === "s") {
        const raw = (/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "").trim();
        const idx = parseInt(raw, 10);
        val = Number.isFinite(idx) && shared[idx] !== undefined
          ? shared[idx]
          : `(shared string #${raw || "?"} missing)`;
      } else if (t === "inlineStr") {
        val = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeEnt(x[1])).join("");
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        if (v !== undefined) val = decodeEnt(v.trim());
        else {
          const f = /<f[^>]*>([\s\S]*?)<\/f>/.exec(inner)?.[1];
          if (f !== undefined) val = "=" + decodeEnt(f);
        }
        if (t === "b") val = val === "1" ? "TRUE" : "FALSE";
      }
      if (val !== "") cells.push(`${ref}=${val.replace(/\s+/g, " ")}`);
    }
    if (cells.length) lines.push(cells.join("\t"));
  }
  return lines.join("\n");
}

/**
 * Resolve a .rels Target (relative, "../"-style, or "/"-absolute) to candidate
 * package paths. Real producers disagree about the base: the OPC spec resolves
 * relative to the SOURCE PART's folder ("xl/"), but very common writers
 * (python-pptx, openpyxl, WPS) emit targets relative to the .rels FILE's
 * folder ("xl/_rels/") — the widespread "../slides/slide1.xml" only lands back
 * inside ppt/ under that second reading. Both bases are candidates; callers
 * pick the one that EXISTS in the package, falling back to the spec-correct
 * one so a genuinely missing part is announced at its spec path.
 */
function relTargets(partDir: string, relsDir: string, target: string): string[] {
  const norm = (base: string): string => {
    const path = target.startsWith("/") ? target.slice(1) : base + target;
    const out: string[] = [];
    for (const seg of path.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") out.pop();
      else out.push(seg.replace(/%20/g, " "));
    }
    return out.join("/");
  };
  const a = norm(partDir), b = norm(relsDir);
  return a === b ? [a] : [a, b];
}

/** Map sheet part paths → display names + document order (workbook.xml + rels). */
function sheetOrder(entries: ZipEntry[], str: (e: ZipEntry) => string):
    { path: string; name: string }[] | null {
  const wb = entries.find((e) => e.name === "xl/workbook.xml");
  if (!wb) return null;
  const rels = entries.find((e) => e.name === "xl/_rels/workbook.xml.rels");
  const relMap = new Map<string, string[]>();
  if (rels) {
    for (const rm of str(rels).matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
      const id = /Id="([^"]+)"/.exec(rm[1])?.[1];
      const target = /Target="([^"]+)"/.exec(rm[1])?.[1];
      if (!id || !target) continue;
      relMap.set(id, relTargets("xl/", "xl/_rels/", target));
    }
  }
  const order: { path: string; name: string }[] = [];
  for (const sm of str(wb).matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const name = /name="([^"]*)"/.exec(sm[1])?.[1];
    const rid = /r:id="([^"]+)"/.exec(sm[1])?.[1];
    if (!name || !rid) continue;
    const cands = relMap.get(rid);
    if (!cands) continue;
    const path = cands.find((c) => entries.some((e) => e.name === c)) ?? cands[0];
    order.push({ path, name: decodeEnt(name) });
  }
  return order.length ? order : null;
}

/** Presentation slide order: sldIdLst document order resolved through rels (D26). */
function slideOrder(entries: ZipEntry[], str: (e: ZipEntry) => string): ZipEntry[] | null {
  const pres = entries.find((e) => e.name === "ppt/presentation.xml");
  const rels = entries.find((e) => e.name === "ppt/_rels/presentation.xml.rels");
  const slides = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name));
  if (!pres || !rels || !slides.length) return null;
  const relMap = new Map<string, string[]>();
  for (const rm of str(rels).matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const id = /Id="([^"]+)"/.exec(rm[1])?.[1];
    const target = /Target="([^"]+)"/.exec(rm[1])?.[1];
    if (!id || !target) continue;
    relMap.set(id, relTargets("ppt/", "ppt/_rels/", target));
  }
  const lst = /<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/.exec(str(pres))?.[1] ?? "";
  const ordered: ZipEntry[] = [];
  const used = new Set<string>();
  for (const sm of lst.matchAll(/<p:sldId\b([^>]*?)\/?>/g)) {
    const rid = /r:id="([^"]+)"/.exec(sm[1])?.[1];
    let e: ZipEntry | undefined;
    for (const c of rid ? relMap.get(rid) ?? [] : []) {
      e = slides.find((s) => s.name === c);
      if (e) break;
    }
    if (e && !used.has(e.name)) { ordered.push(e); used.add(e.name); }
  }
  // Slides the presentation lists AFTER it, plus orphans → append by number.
  const rest = slides.filter((s) => !used.has(s.name))
    .sort((a, b) => (parseInt(/\d+/.exec(a.name)?.[0] ?? "0", 10) - parseInt(/\d+/.exec(b.name)?.[0] ?? "0", 10)));
  return ordered.length ? [...ordered, ...rest] : null;
}

function integrityNote(corrupt: string[]): string {
  if (!corrupt.length) return "";
  return `[integrity: ${corrupt.length} package part(s) failed their stored CRC checksum and were skipped: ${corrupt.join(", ")}]`;
}

const XLSX_INCLUDE = (name: string) =>
  /^xl\/(sharedStrings|workbook)\.xml$/.test(name) ||
  /^xl\/_rels\/workbook\.xml\.rels$/.test(name) ||
  /^xl\/worksheets\/sheet\d+\.xml$/.test(name) ||
  /^xl\/charts\/chart\d+\.xml$/.test(name);

/**
 * Extract readable text from Office Open XML, ODF, and EPUB containers.
 * All are ZIP files holding XML parts.
 *
 * D25: xlsx used to dump the shared-STRING DICTIONARY — cell contents lost
 * their positions, duplicate strings appeared once, and unused strings read as
 * if they were data. Cells are now parsed per worksheet with coordinates,
 * shared + inline strings, formula text when no cached value exists, and
 * sheet names/document order from workbook.xml.
 * D26: slide order comes from presentation.xml's sldIdLst (lexical filename
 * sort produced 1,10,11,2…); numeric sort is the fallback.
 * Parts are filtered before inflation (a workbook's media never enters
 * memory), and parts failing their CRC check are skipped with an explicit
 * integrity line rather than silently trusted (D27/I11).
 *
 * P5B honest chart labeling stays: native charts (cached values "not expanded
 * here"), picture-only chart images, and embedded media are each labelled
 * exactly as far as their readability goes so the model never infers values
 * from a picture.
 */
export function officeText(buf: Buffer, ext: string): string {
  const limits: ZipLimits =
    ext === "xlsx" || ext === "xlsm"
      ? { include: XLSX_INCLUDE }
      : ext === "pptx"
        ? { include: (n) => /^ppt\/(presentation\.xml|slides\/slide\d+\.xml)$/.test(n) || n === "ppt/_rels/presentation.xml.rels" }
        : ext === "docx"
          ? { include: (n) => /^word\/((document|footnotes|endnotes)\.xml|(header|footer)\d*\.xml)$/.test(n) }
          : ext === "epub"
            ? { include: (n) => /\.(xhtml|html)$/.test(n) }
            : ext === "odt" || ext === "ods" || ext === "odp"
              ? { include: (n) => n === "content.xml" }
              : {};
  const zip = readZipDetailed(buf, limits);
  const entries = zip.entries;
  const find = (re: RegExp) => entries.filter((e) => re.test(e.name));
  const str = (e: ZipEntry) => e.data.toString("utf8");
  const good = (e: ZipEntry) => !e.corrupt;

  switch (ext) {
    case "docx": {
      const parts = [
        ...entries.filter((e) => /^word\/(document|footnotes|endnotes)\.xml$/.test(e.name) && good(e)),
        ...find(/^word\/(header|footer)\d*\.xml$/).filter(good),
      ];
      const body = parts.map((e) => xmlToText(str(e))).filter(Boolean).join("\n\n");
      const note = integrityNote(zip.corrupt);
      return [note, body].filter(Boolean).join("\n\n");
    }
    case "xlsx":
    case "xlsm": {
      const out: string[] = [];
      const sharedEntry = entries.find((e) => e.name === "xl/sharedStrings.xml" && good(e));
      const shared = sharedEntry ? sharedStrings(str(sharedEntry)) : [];
      const order = sheetOrder(entries.filter(good), str);
      let sheets: { e: ZipEntry; name: string }[];
      if (order) {
        sheets = order
          .map((o) => { const e = entries.find((x) => x.name === o.path && good(x)); return e ? { e, name: o.name } : null; })
          .filter((x): x is { e: ZipEntry; name: string } => !!x);
        // sheets referenced but missing from the package:
        for (const o of order) {
          if (!entries.some((x) => x.name === o.path)) {
            out.push(`### worksheet: ${o.name} — part ${o.path} is missing from the package`);
          }
        }
      } else {
        sheets = find(/^xl\/worksheets\/sheet\d+\.xml$/).filter(good)
          .sort((a, b) => (parseInt(/(\d+)/.exec(a.name)?.[1] ?? "0", 10) - parseInt(/(\d+)/.exec(b.name)?.[1] ?? "0", 10)))
          .map((e) => ({ e, name: "" }));
      }
      for (const { e, name } of sheets) {
        const body = worksheetText(str(e), shared);
        if (name) out.push(`### worksheet: ${name}\n${body}`.trim());
        else out.push(body); // no workbook.xml to name the sheet — bare rows keep the old exact output shape
      }
      // P5B honest chart labeling: a spreadsheet can carry visuals that text
      // extraction cannot read — native chart parts (sometimes WITH cached
      // series values), or plain media images that are just pictures of
      // charts (how xlsxEngine embeds its Chromium-rendered PNGs, and how
      // many third-party tools save them). Without an explicit inventory the
      // model knows nothing is there and invents values; with it, each visual
      // is labelled exactly as far as its readability goes.
      const labels: string[] = [];
      for (const e of find(/^xl\/charts\/chart\d+\.xml$/).filter(good).sort((a, b) => a.name.localeCompare(b.name))) {
        const xml = str(e);
        const title = /<c:title>[\s\S]*?<a:t>([^<]*)<\/a:t>/.exec(xml)?.[1]?.trim();
        const cached = /<c:(?:num|string)Cache/.test(xml);
        labels.push(
          `Chart${title ? ` "${title}"` : ""} (${e.name}): ` +
            (cached
              ? "native chart; the file caches its series values (not expanded here)"
              : "chart with NO cached data — only its picture exists for a text reader; do not infer values from it"),
        );
      }
      // Media lives WITHOUT inflation — the central directory names are enough
      // to count it (the parts are never read as text anyway).
      const media = zip.names.filter((n) => /^xl\/media\/[^/]+$/.test(n));
      if (media.length) {
        labels.push(
          `${media.length} embedded image(s) in xl/media: image-only visuals (photos OR pictures of charts — not distinguishable from metadata); there is NO readable data behind them`,
        );
      }
      if (labels.length) out.push(labels.join("\n"));
      const note = integrityNote(zip.corrupt);
      if (note) out.unshift(note);
      return out.filter(Boolean).join("\n\n");
    }
    case "pptx": {
      const ordered = slideOrder(entries.filter(good), str);
      const slides = ordered ??
        find(/^ppt\/slides\/slide\d+\.xml$/).filter(good)
          .sort((a, b) => (parseInt(/(\d+)/.exec(a.name)?.[1] ?? "0", 10) - parseInt(/(\d+)/.exec(b.name)?.[1] ?? "0", 10)));
      const body = slides.map((e) => xmlToText(str(e))).filter(Boolean).join("\n\n");
      const note = integrityNote(zip.corrupt);
      return [note, body].filter(Boolean).join("\n\n");
    }
    case "odt":
    case "ods":
    case "odp": {
      const content = entries.find((e) => e.name === "content.xml" && good(e));
      const body = content ? xmlToText(str(content)) : "";
      const note = integrityNote(zip.corrupt);
      return [note, body].filter(Boolean).join("\n\n");
    }
    case "epub": {
      const pages = find(/\.(xhtml|html)$/).filter(good).sort((a, b) => a.name.localeCompare(b.name));
      const body = pages.map((e) => xmlToText(str(e))).filter(Boolean).join("\n\n");
      const note = integrityNote(zip.corrupt);
      return [note, body].filter(Boolean).join("\n\n");
    }
    default:
      return "";
  }
}
