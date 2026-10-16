/**
 * Streams a finished asset to the browser. OBJ is packaged server-side into
 * a zip with its MTL + texture sidecars (rewritten to local names) so the
 * download actually opens textured — formats the provider did not produce
 * for this job answer 409 with a clear reason instead of an empty file.
 */
import { NextRequest, NextResponse } from "next/server";
import { getActiveProvider } from "../../../../../../lib/three3d/providers/index";
import { fetchArtifact, pollJob, MESHY_FORMATS } from "../../../../../../lib/three3d/providers/meshy";
import type { AssetFormat } from "../../../../../../lib/three3d/providers/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  if (!getActiveProvider()) {
    return NextResponse.json({ error: "No 3D generation provider is configured." }, { status: 503 });
  }

  const format = (req.nextUrl.searchParams.get("format") ?? "glb") as AssetFormat;
  if (!MESHY_FORMATS.includes(format)) {
    return NextResponse.json({ error: `unsupported format "${format}"` }, { status: 400 });
  }
  const rawName = req.nextUrl.searchParams.get("name") ?? "asset";
  const baseName = rawName.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "asset";

  try {
    const view = await pollJob(decodeURIComponent(params.id), { autoRefine: false });
    if (view.status !== "succeeded") {
      return NextResponse.json(
        { error: `job is ${view.status}${view.error ? `: ${view.error}` : " — not downloadable yet"}` },
        { status: 409 },
      );
    }
    const artifact = await fetchArtifact(view, format, baseName);
    return new Response(Buffer.from(artifact.data), {
      status: 200,
      headers: {
        "Content-Type": artifact.contentType,
        "Content-Disposition": `attachment; filename="${artifact.filename}"`,
        "Content-Length": String(artifact.data.byteLength),
        "Cache-Control": "no-cache",
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "download failed";
    const status = message.includes("no ") ? 409 : message.startsWith("unknown asset job id") ? 400 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
