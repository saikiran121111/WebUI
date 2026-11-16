import { NextRequest } from "next/server";
import { parseSpec, fileResponse, engineError } from "@/lib/documents/http";
import { buildXlsx } from "@/lib/documents/xlsxEngine";
import { dataQualityHeaders } from "@/lib/documents/dataQuality";

export const runtime = "nodejs";

/** POST { spec: XlsxSpec } → .xlsx. 422 + formulaErrors if recalc finds any error. */
export async function POST(req: NextRequest) {
  const parsed = await parseSpec(req);
  if (!parsed.ok) return parsed.res;
  try {
    const out = await buildXlsx(parsed.spec);
    // F11: the workbook itself must not be the only place a fabricated-value
    // decision is invisible. The count rides in a header the preview can show.
    return fileResponse(out.buffer, out.contentType, out.filename, dataQualityHeaders(out.valueIssues.length,
      out.valueIssues.slice(0, 8).map((i) => i.cell + " " + i.reason).join("; ")));
  } catch (err) {
    return engineError(err);
  }
}
