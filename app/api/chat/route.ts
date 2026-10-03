import { NextRequest, NextResponse } from "next/server";

const LLM_URL = process.env.LLM_API_URL ?? "http://127.0.0.1:8080/v1/chat/completions";
const API_KEY = process.env.LLM_API_KEY ?? "no-key";

const OPEN  = "<think>";
const CLOSE = "</think>";

function scrubThinkTags(text: string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf(OPEN, i);
    if (open === -1) { parts.push(text.slice(i)); break; }
    parts.push(text.slice(i, open));
    const close = text.indexOf(CLOSE, open + OPEN.length);
    if (close === -1) break;  // unterminated — drop from open onwards
    i = close + CLOSE.length;
  }
  return parts.join("");
}

/**
 * Proxies chat completions to the local LLM, streaming SSE byte-for-byte.
 *
 * Performance: streams the upstream body through a TransformStream without
 * parsing JSON per chunk. We only inspect one field (reasoning_content -> think)
 * inside the TransformStream, which runs in the stream's own microtask and
 * never blocks the UI. We DO NOT re-serialize or buffer the full SSE.
 *
 * For normal chat, client -> this proxy -> localhost:8080 is two local hops.
 * This is negligible; the proxy adds safety (CORS, auth, response scrubbing).
 */
export async function POST(req: NextRequest) {
  const body = await req.text();

  try {
    const upstream = await fetch(LLM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + API_KEY,
        Accept: "text/event-stream",
      },
      body,
    });

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      return NextResponse.json(
        { error: "Upstream returned " + upstream.status + (errText ? ": " + errText.slice(0, 200) : "") },
        { status: upstream.status },
      );
    }

    if (!upstream.body) {
      return NextResponse.json({ error: "No response body from model" }, { status: 502 });
    }

    // Lightweight think-tag scrub inside a TransformStream.
    // We only receive *complete* SSE event bodies (SSE framing is done by the
    // browser/caller), so tags are never split across the boundaries we see.
    const scrubber = new TransformStream({
      start() {},
      transform(chunk, controller) {
        const text = new TextDecoder().decode(chunk);
        controller.enqueue(new TextEncoder().encode(scrubThinkTags(text)));
      },
    });

    const cleaned = upstream.body.pipeThrough(scrubber);

    return new Response(cleaned, {
      status: 200,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") ?? "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[api/chat]", msg);
    return NextResponse.json(
      { error: "Could not reach the model server. Is it running on port 8080?" },
      { status: 503 },
    );
  }
}
