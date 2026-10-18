/**
 * Shared plumbing for the /api/documents/* download routes: parse the fence
 * spec from the request body, return a file download, and map engine errors
 * to a typed error contract (422 + error list for recalc failures).
 */
import { NextRequest, NextResponse } from "next/server";
import { XlsxRecalcError } from "./xlsxEngine";

export async function parseSpec(req: NextRequest): Promise<{ ok: true; spec: unknown } | { ok: false; res: NextResponse }> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { ok: false, res: NextResponse.json({ error: "Body must be JSON." }, { status: 400 }) };
  }
  const spec = (body && typeof body === "object" && "spec" in body) ? (body as { spec: unknown }).spec : body;
  return { ok: true, spec };
}

export function fileResponse(data: Buffer | string, contentType: string, filename: string): NextResponse {
  return new NextResponse(data instanceof Uint8Array ? new Uint8Array(data) : data, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
      "Cache-Control": "no-store",
    },
  });
}

export function engineError(err: unknown): NextResponse {
  if (err instanceof XlsxRecalcError) {
    return NextResponse.json({ error: err.message, formulaErrors: err.details }, { status: 422 });
  }
  const message = err instanceof Error ? err.message : String(err);
  const status = /invalid|did not validate/i.test(message) ? 422 : 500;
  return NextResponse.json({ error: message }, { status });
}
