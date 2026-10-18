import { NextRequest } from "next/server";
import { parseSpec, fileResponse, engineError } from "@/lib/documents/http";
import { buildXlsx } from "@/lib/documents/xlsxEngine";

export const runtime = "nodejs";

/** POST { spec: XlsxSpec } → .xlsx. 422 + formulaErrors if recalc finds any error. */
export async function POST(req: NextRequest) {
  const parsed = await parseSpec(req);
  if (!parsed.ok) return parsed.res;
  try {
    const out = await buildXlsx(parsed.spec);
    return fileResponse(out.buffer, out.contentType, out.filename);
  } catch (err) {
    return engineError(err);
  }
}
