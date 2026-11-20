import { getDocumentProxy, extractText } from "unpdf";

/**
 * PDF → plain text. Uses the pdf.js build bundled inside node_modules (unpdf)
 * so extraction never depends on a system-installed poppler/xpdf binary.
 *
 * I06: a scanned PDF has no text layer at all — reporting its (empty)
 * extraction as a completed read is a lie. The page loop now reports WHICH
 * pages carry text so coverage is explicit, and an all-empty PDF raises an
 * honest error naming the real option (send the page as an image). There is
 * no OCR engine installed and this module does not pretend otherwise.
 */
export interface PdfText {
  text: string;
  pages: number;
  /**
   * Per-page text in 1-based order (index 0 is page 1). The merge layer needs
   * PER-PAGE evidence: a joined blob cannot say which page produced nothing,
   * and "N pages had no text" is a count, not a statement about which ones.
   */
  perPage: string[];
  /** 1-based page numbers whose text layer is empty. */
  pagesWithoutText: number[];
}

export async function pdfText(buf: Buffer): Promise<PdfText> {
  const doc = await getDocumentProxy(new Uint8Array(buf));
  try {
    const { text, totalPages } = await extractText(doc, { mergePages: false });
    const perPage: string[] = Array.isArray(text) ? text.map((p) => String(p)) : [String(text)];
    const pages = totalPages || perPage.length;
    const pagesWithoutText: number[] = [];
    perPage.forEach((p, i) => {
      if (!p.trim()) pagesWithoutText.push(i + 1);
    });
    return { text: perPage.join("\n\n").trim(), pages, perPage, pagesWithoutText };
  } finally {
    await (doc as any).destroy?.();
  }
}
