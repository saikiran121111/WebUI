import { NextRequest } from "next/server";
import { parseSpec, fileResponse, engineError } from "@/lib/documents/http";
import { buildPowerbi } from "@/lib/documents/powerbiEngine";
import { dataQualityHeaders } from "@/lib/documents/dataQuality";

export const runtime = "nodejs";

/** POST { spec: PowerbiSpec } → .pbip.zip (PBIP project + embedded .pbit). */
export async function POST(req: NextRequest) {
  const parsed = await parseSpec(req);
  if (!parsed.ok) return parsed.res;
  try {
    const out = await buildPowerbi(parsed.spec);
    return fileResponse(out.buffer, out.contentType, out.filename, dataQualityHeaders(out.datasetIssues.length,
      out.datasetIssues.slice(0, 8).map((i) => i.column + " row " + i.row + " " + i.reason).join("; ")));
  } catch (err) {
    return engineError(err);
  }
}
