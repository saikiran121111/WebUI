import { NextRequest } from "next/server";
import { parseSpec, fileResponse, engineError } from "@/lib/documents/http";
import { renderPdf } from "@/lib/documents/pdfEngine";
import { resumeHtml } from "@/lib/documents/resumeHtml";
import { normalizeResume } from "@/lib/documents/schemas";

export const runtime = "nodejs";

/** POST { spec } → A4 PDF. Accepts either raw printable HTML or a resume spec. */
export async function POST(req: NextRequest) {
  const parsed = await parseSpec(req);
  if (!parsed.ok) return parsed.res;
  try {
    let html: string;
    const spec = parsed.spec;
    if (typeof spec === "string") {
      html = spec;
    } else {
      const resume = normalizeResume(spec);
      if (!resume) return engineError(new Error("Invalid pdf/resume spec."));
      html = resumeHtml(resume);
    }
    const out = await renderPdf(html, typeof (spec as { filename?: string })?.filename === "string" ? (spec as { filename: string }).filename : "document");
    return fileResponse(out.buffer, out.contentType, out.filename);
  } catch (err) {
    return engineError(err);
  }
}
