/**
 * Starts a provider-generated 3D asset job. Server-only: the provider API
 * key never leaves this process — the browser receives an opaque job id.
 * With no provider configured this answers 503 honestly (procedural
 * scene3d stays fully available; nothing is faked).
 */
import { NextRequest, NextResponse } from "next/server";
import { asset3dSpecSchema } from "../../../../lib/three3d/sceneSchema";
import { getActiveProvider } from "../../../../lib/three3d/providers/index";
import { createPreviewJob } from "../../../../lib/three3d/providers/meshy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!getActiveProvider()) {
    return NextResponse.json(
      { error: "No 3D generation provider is configured on this server. Procedural scene3d remains available." },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = asset3dSpecSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid asset request" },
      { status: 400 },
    );
  }

  try {
    const jobId = await createPreviewJob(parsed.data);
    return NextResponse.json({ jobId, provider: "meshy", status: "pending", progress: 0, modelUrls: {} });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "generation request failed" },
      { status: 502 },
    );
  }
}
