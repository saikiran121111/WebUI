import { readZip, ZipEntry } from "./zip";

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

function textsFromTags(xml: string, tag: RegExp): string {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = tag.exec(xml)) !== null) out.push(m[1]);
  return out.join("\n");
}

/**
 * Extract readable text from Office Open XML, ODF, and EPUB containers.
 * All are ZIP files holding XML parts.
 */
export function officeText(buf: Buffer, ext: string): string {
  const entries = readZip(buf);
  const find = (re: RegExp) => entries.filter(e => re.test(e.name));
  const str = (e: ZipEntry) => e.data.toString("utf8");

  switch (ext) {
    case "docx": {
      const parts = [
        ...entries.filter(e => /^word\/(document|footnotes|endnotes)\.xml$/.test(e.name)),
        ...find(/^word\/(header|footer)\d*\.xml$/),
      ];
      return parts.map(e => xmlToText(str(e))).filter(Boolean).join("\n\n");
    }
    case "xlsx":
    case "xlsm": {
      const out: string[] = [];
      const shared = entries.find(e => e.name === "xl/sharedStrings.xml");
      if (shared) out.push(textsFromTags(str(shared), /<t[^>]*>([^<]*)<\/t>/g));
      for (const e of find(/^xl\/worksheets\/sheet\d+\.xml$/)) {
        out.push(textsFromTags(str(e), /<is><t[^>]*>([^<]*)<\/t><\/is>/g));
      }
      // P5B honest chart labeling: a spreadsheet can carry visuals that text
      // extraction cannot read — native chart parts (sometimes WITH cached
      // series values), or plain media images that are just pictures of
      // charts (how xlsxEngine embeds its Chromium-rendered PNGs, and how
      // many third-party tools save them). Without an explicit inventory the
      // model knows nothing is there and invents values; with it, each visual
      // is labelled exactly as far as its readability goes.
      const labels: string[] = [];
      for (const e of find(/^xl\/charts\/chart\d+\.xml$/).sort((a, b) => a.name.localeCompare(b.name))) {
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
      const media = find(/^xl\/media\/[^/]+$/);
      if (media.length) {
        labels.push(
          `${media.length} embedded image(s) in xl/media: image-only visuals (photos OR pictures of charts — not distinguishable from metadata); there is NO readable data behind them`,
        );
      }
      if (labels.length) out.push(labels.join("\n"));
      return out.filter(Boolean).join("\n");
    }
    case "pptx": {
      const slides = find(/^ppt\/slides\/slide\d+\.xml$/)
        .sort((a, b) => a.name.localeCompare(b.name));
      return slides.map(e => xmlToText(str(e))).filter(Boolean).join("\n\n");
    }
    case "odt":
    case "ods":
    case "odp": {
      const content = entries.find(e => e.name === "content.xml");
      return content ? xmlToText(str(content)) : "";
    }
    case "epub": {
      const pages = find(/\.(xhtml|html)$/).sort((a, b) => a.name.localeCompare(b.name));
      return pages.map(e => xmlToText(str(e))).filter(Boolean).join("\n\n");
    }
    default:
      return "";
  }
}
