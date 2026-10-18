import { NextRequest } from "next/server";
import { parseSpec, fileResponse, engineError } from "@/lib/documents/http";
import { buildDocx } from "@/lib/documents/docxEngine";

export const runtime = "nodejs";

/** POST { spec: DocxSpec } → .docx (charts screenshotted at 2x, temps cleaned). */
export async function POST(req: NextRequest) {
  const parsed = await parseSpec(req);
  if (!parsed.ok) return parsed.res;
  try {
    const out = await buildDocx(parsed.spec);
    return fileResponse(out.buffer, out.contentType, out.filename);
  } catch (err) {
    return engineError(err);
  }
}
