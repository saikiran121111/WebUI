import { NextRequest, NextResponse } from "next/server";
import { parseSpec, fileResponse, engineError } from "@/lib/documents/http";
import { buildPptx } from "@/lib/documents/pptxEngine";
import { pptxSpecIssues } from "@/lib/documents/schemas";

export const runtime = "nodejs";

/** POST { spec: PptxSpec } → native .pptx (editable content + native motion).
 * The spec is validated at this boundary before the engine sees it (finding
 * 8): invalid specs return a clear 4xx instead of reaching the builder. */
export async function POST(req: NextRequest) {
  const parsed = await parseSpec(req);
  if (!parsed.ok) return parsed.res;
  const issues = pptxSpecIssues(parsed.spec);
  if (issues.length) {
    return NextResponse.json(
      { error: "Invalid presentation spec: " + issues.slice(0, 4).join("; ") },
      { status: 422 },
    );
  }
  try {
    const out = await buildPptx(parsed.spec);
    return fileResponse(out.buffer, out.contentType, out.filename);
  } catch (err) {
    return engineError(err);
  }
}
