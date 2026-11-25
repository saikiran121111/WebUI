import { NextRequest } from "next/server";
import { parseSpec, fileResponse, engineError } from "@/lib/documents/http";
import { buildXlsx } from "@/lib/documents/xlsxEngine";
import {
  dataQualityHeaders,
  CHART_FAILURE_COUNT_HEADER,
  CHART_FAILURE_SAMPLE_HEADER,
} from "@/lib/documents/dataQuality";

export const runtime = "nodejs";

/** POST { spec: XlsxSpec } → .xlsx. 422 + formulaErrors if recalc finds any error. */
export async function POST(req: NextRequest) {
  const parsed = await parseSpec(req);
  if (!parsed.ok) return parsed.res;
  try {
    const out = await buildXlsx(parsed.spec);
    // F11: the workbook itself must not be the only place a fabricated-value
    // decision is invisible. The count rides in a header the preview can show.
    // F77: chart renders that failed are counted the same way — a workbook
    // missing chart images never reports as a plain success.
    return fileResponse(out.buffer, out.contentType, out.filename, {
      ...dataQualityHeaders(out.valueIssues.length,
        out.valueIssues.slice(0, 8).map((i) => i.cell + " " + i.reason).join("; ")),
      ...(out.chartFailures.length
        ? {
            [CHART_FAILURE_COUNT_HEADER]: String(out.chartFailures.length),
            [CHART_FAILURE_SAMPLE_HEADER]: encodeURIComponent(
              out.chartFailures.slice(0, 4).map((f) => f.title + ": " + f.reason).join("; ").replace(/[^\x20-\x7E]/g, "?").slice(0, 512),
            ),
          }
        : {}),
    });
  } catch (err) {
    return engineError(err);
  }
}
