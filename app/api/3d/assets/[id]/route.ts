/**
 * Polls an asset job's status. The response carries only opaque URLs and
 * progress — never credentials. When a preview stage succeeds, the provider
 * adapter auto-starts the PBR refine stage here and hands the client the
 * next job id (download calls pollJob with autoRefine disabled instead).
 */
import { NextRequest, NextResponse } from "next/server";
import { getActiveProvider } from "../../../../../lib/three3d/providers/index";
import { pollJob } from "../../../../../lib/three3d/providers/meshy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  if (!getActiveProvider()) {
    return NextResponse.json({ error: "No 3D generation provider is configured." }, { status: 503 });
  }
  try {
    const view = await pollJob(decodeURIComponent(params.id), { autoRefine: true });
    return NextResponse.json(view);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "status request failed";
    const status = message.startsWith("unknown asset job id") ? 400 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
