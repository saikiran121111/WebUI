import { NextRequest, NextResponse } from "next/server";
import { extractFile } from "../../../../lib/server/extract";
import { MAX_ATTACHMENT_BYTES } from "../../../../lib/files/extensions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Whisper / ffmpeg work can run long; keep the handler out of any caching layer.
export const revalidate = 0;

/**
 * POST a file (multipart, field name "file") and get back whatever content can
 * be read out of it: text, transcript, image/frames as data URLs.
 *
 * The browser handles plain text and decodable images itself; everything else
 * comes here, where the extraction tooling bundled in node_modules runs.
 */
export async function POST(req: NextRequest) {
  let name = "upload";
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file || typeof file.arrayBuffer !== "function") {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }
    name = file.name || name;
    if (!file.size) return NextResponse.json({ error: "File is empty" }, { status: 400 });
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return NextResponse.json(
        { error: `File is larger than ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB` },
        { status: 413 },
      );
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const result = await extractFile(name, bytes);
    return NextResponse.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Extraction failed";
    console.error("[api/files/extract]", name, "-", msg);
    return NextResponse.json({ error: msg }, { status: 422 });
  }
}
