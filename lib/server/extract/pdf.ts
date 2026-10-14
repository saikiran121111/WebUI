import { getDocumentProxy, extractText } from "unpdf";

/**
 * PDF → plain text. Uses the pdf.js build bundled inside node_modules (unpdf)
 * so extraction never depends on a system-installed poppler/xpdf binary.
 */
export async function pdfText(buf: Buffer): Promise<{ text: string; pages: number }> {
  const doc = await getDocumentProxy(new Uint8Array(buf));
  try {
    const { text, totalPages } = await extractText(doc, { mergePages: false });
    const pages = Array.isArray(text) ? text : [String(text)];
    return { text: pages.join("\n\n").trim(), pages: totalPages || pages.length };
  } finally {
    await (doc as any).destroy?.();
  }
}
