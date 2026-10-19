import { NextRequest, NextResponse } from "next/server";
import { extractFileFromPath } from "../../../../lib/server/extract";
import { fileExtension } from "../../../../lib/files/extensions";
import { childLogger } from "../../../../lib/server/logger";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const log = childLogger("api/files/extract");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Whisper / ffmpeg work can run long; keep the handler out of any caching layer.
export const revalidate = 0;

const TMP_DIR = path.join(process.cwd(), ".data", "tmp");

/** Keep only a safe base name — the client sends the picked file's name. */
function safeName(raw: string | null): string {
  const base = path
    .basename((raw ?? "").trim())
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
  return (base || "upload").slice(0, 240);
}

function tmpPathFor(name: string): string {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const ext = fileExtension(name).toLowerCase().replace(/[^a-z0-9]/g, "");
  return path.join(TMP_DIR, "u_" + randomBytes(6).toString("hex") + (ext ? "." + ext : ""));
}

/**
 * POST a file's raw bytes (filename via ?name=) and get back whatever content
 * can be read out of it: text, transcript, image/frames as data URLs.
 *
 * The browser handles plain text and decodable images itself; everything else
 * comes here, where the extraction tooling bundled in node_modules runs.
 *
 * This is a local app, so the body is streamed straight to a scratch file and
 * ffmpeg/whisper read the media from that path — a multi-GB video uploads and
 * extracts without ever being buffered whole in memory. (The browser cannot
 * hand over the original file's absolute path, so the bytes still cross the
 * local HTTP boundary once — but the file on disk is never moved or touched.)
 *
 * There is no size cap: the stream is unbounded, and the only real limit is
 * free disk space for the scratch file.
 */
export async function POST(req: NextRequest) {
  const name = safeName(req.nextUrl.searchParams.get("name"));
  let tmp: string | null = null;
  try {
    if (!req.body) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    tmp = tmpPathFor(name);
    const src = Readable.fromWeb(req.body as never);
    let size = 0;
    src.on("data", (chunk: Buffer) => { size += chunk.length; });
    await pipeline(src, fs.createWriteStream(tmp));

    if (size === 0) {
      return NextResponse.json({ error: "File is empty" }, { status: 400 });
    }

    const result = await extractFileFromPath(name, tmp);
    return NextResponse.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Extraction failed";
    log.error({ file: name }, `extraction failed: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 422 });
  } finally {
    if (tmp) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    }
  }
}
