import { NextRequest } from "next/server";
import { parseSpec, fileResponse, engineError } from "@/lib/documents/http";
import { buildPptx } from "@/lib/documents/pptxEngine";

export const runtime = "nodejs";

/** POST { spec: PptxSpec } → .pptx with OOXML Morph transitions injected. */
export async function POST(req: NextRequest) {
  const parsed = await parseSpec(req);
  if (!parsed.ok) return parsed.res;
  try {
    const out = await buildPptx(parsed.spec);
    return fileResponse(out.buffer, out.contentType, out.filename);
  } catch (err) {
    return engineError(err);
  }
}
