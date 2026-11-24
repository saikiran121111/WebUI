/**
 * F71 - macro-enabled OOXML (.docm/.dotm/.pptm/.potm/.ppsm/.xltm/.xlam) are
 * Office containers, not archives.
 *
 * The live defect: macro-1.docm fell through the extension map into the
 * ARCHIVE branch, so the delivered body was a raw zip-member dump of package
 * XML — the real document body never reached the model, and the turn spent
 * its whole budget web-searching around an 86k-token XML blob.
 *
 * Laws:
 *  1. classifyFile maps the whole macro-enabled OOXML family to "office"
 *     (its non-macro twins are already "office"; a macro twin is the same
 *     ZIP+XML container plus a vbaProject.bin part);
 *  2. the TS OOXML reader reads a .docm body and a .pptm slide body through
 *     the SAME part paths as the plain format, and the macro part is never
 *     read as text;
 *  3. the production extract seam delivers the document body for a .docm —
 *     category "office", body present, no archive member dump — with the
 *     capability backend offline (state "none"), so the TS reader serves it;
 *  4. ACCEPT_EXTENSIONS (the upload boundary) offers the macro formats.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { ACCEPT_EXTENSIONS, classifyFile } from "../../lib/files/extensions";
import { officeText } from "../../lib/server/extract/office";
import { extractFileFromPath } from "../../lib/server/extract";
import type { RunJob } from "../../lib/server/extract/document-capability";

const FIXTURES = path.join(process.cwd(), "docs", "overnight", "fixtures", "f78", "all-readers");

describe("F71 macro-enabled OOXML routing", () => {
  it("classifies the macro-enabled OOXML family as office", () => {
    for (const name of ["a.docm", "a.dotm", "a.pptm", "a.potm", "a.ppsm", "a.xltm", "a.xlam", "a.xlsm"]) {
      expect(classifyFile(name), name).toBe("office");
    }
  });

  it("the upload boundary offers the macro formats", () => {
    for (const ext of [".docm", ".dotm", ".pptm", ".potm", ".ppsm", ".xltm", ".xlam"]) {
      expect(ACCEPT_EXTENSIONS.split(","), ext).toContain(ext);
    }
  });

  it("the TS OOXML reader reads the docm word body, macro part unread", () => {
    const buf = fs.readFileSync(path.join(FIXTURES, "macro-word.docm"));
    const text = officeText(buf, "docm");
    expect(text).toContain("Section alpha reports 118 and 271 as the pair.");
    expect(text).toContain("The macro-bearing body text ends here.");
    expect(text).not.toContain("vbaProject");
  });

  it("the TS OOXML reader reads the pptm slide body", () => {
    const buf = fs.readFileSync(path.join(FIXTURES, "macro-deck.pptm"));
    const text = officeText(buf, "pptm");
    expect(text).toContain("Slide one carries the value 90210.");
  });

  it("production extract of a docm delivers the body, not an archive dump", async () => {
    const offline: RunJob = async () => null;
    const r: any = await extractFileFromPath(
      "macro-word.docm",
      path.join(FIXTURES, "macro-word.docm"),
      "att_f71docm",
      undefined,
      undefined,
      { runJob: offline },
    );
    expect(r.category).toBe("office");
    expect(r.text).toContain("Section alpha reports 118 and 271 as the pair.");
    // The archive-member dump shape the bug produced.
    expect(r.text).not.toContain("--- member:");
    expect(r.text).not.toContain("[Content_Types].xml");
  });
});
