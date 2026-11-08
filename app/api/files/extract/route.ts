import { NextRequest, NextResponse } from "next/server";
import { extractFileFromPath } from "../../../../lib/server/extract";
import { storeUpload, sweepOrphanUploads } from "../../../../lib/server/attachindex/store";
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

/** Durable-upload sweep runs once per server process, lazily, cheaply. */
let uploadsSwept = false;

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
  // The client's attachment id keys the on-disk knowledge index for oversized
  // content. Anything malformed is dropped — extraction just falls back to the
  // classic capped path and nothing is ever written outside the index root.
  const attRaw = req.nextUrl.searchParams.get("att");
  const att = attRaw && /^att_[a-z0-9]{4,32}$/.test(attRaw) ? attRaw : undefined;
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

    if (!uploadsSwept) {
      uploadsSwept = true;
      try { sweepOrphanUploads(); } catch { /* best effort */ }
    }

    // I09: the browser-reported MIME is a fallback for meaningless extensions;
    // the extractor ALSO magic-sniffs the bytes, so a renamed file still gets
    // the reader its actual format needs.
    const mime = req.headers.get("content-type") ?? undefined;
    const result = await extractFileFromPath(name, tmp, att, mime);

    // I26: keep the original bytes durable, keyed by the attachment id, so a
    // follow-up question ("more frames from section 3", "another audio window")
    // can re-extract from disk instead of demanding a re-upload. The scratch
    // file is MOVED (same-volume rename), never copied.
    if (att) {
      try {
        storeUpload(tmp, att, fileExtension(name));
        tmp = null; // ownership moved — the finally block must not delete it
      } catch { /* best effort: the extraction result is already produced */ }
    }
    return NextResponse.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Extraction failed";
    log.error({ file: name }, `extraction failed: ${msg}`);
    // I26: a failed re-extraction must NOT wipe the PREVIOUS working index or
    // durable upload — partial-build cleanup is indexContent's job (it only
    // cleans an index that did not exist before the failed run). The scratch
    // file itself is removed in the finally block below.
    return NextResponse.json({ error: msg }, { status: 422 });
  } finally {
    if (tmp) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    }
  }
}
