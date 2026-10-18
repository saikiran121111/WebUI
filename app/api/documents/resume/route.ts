import { NextRequest } from "next/server";
import { parseSpec, fileResponse, engineError } from "@/lib/documents/http";
import { renderPdf } from "@/lib/documents/pdfEngine";
import { resumeHtml } from "@/lib/documents/resumeHtml";
import { normalizeResume } from "@/lib/documents/schemas";

export const runtime = "nodejs";

/** POST { spec: ResumeSpec } → ATS-friendly 1–2 page A4 PDF. */
export async function POST(req: NextRequest) {
  const parsed = await parseSpec(req);
  if (!parsed.ok) return parsed.res;
  try {
    const resume = normalizeResume(parsed.spec);
    if (!resume) return engineError(new Error("Invalid resume spec."));
    const out = await renderPdf(resumeHtml(resume), `${resume.basics.name}_Resume`);
    return fileResponse(out.buffer, out.contentType, out.filename);
  } catch (err) {
    return engineError(err);
  }
}
