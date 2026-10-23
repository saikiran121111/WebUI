/**
 * Screencast mirror stream for the interactive login browser (Part 3).
 *
 * SSE of `{frame:url,title,viewport}` — JPEG frames from CDP
 * `Page.startScreencast` plus live url/title, consumed by
 * components/RightBrowserPanel.tsx. Opening this stream LAUNCHES the
 * headful session on first use; the screencast itself only runs while a
 * client is subscribed (lib/browser/interactiveBrowser.subscribeMirror), so
 * an unwatched session costs no capture work on the laptop.
 */
import { type NextRequest } from "next/server";
import {
  ensureInteractiveSession,
  getLatestMirrorFrame,
  subscribeMirror,
} from "@/lib/browser/interactiveBrowser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const encoder = new TextEncoder();
  let unsub: () => void = () => {};
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    unsub();
    if (heartbeat) clearInterval(heartbeat);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* client vanished mid-write */
          cleanup();
        }
      };

      void (async () => {
        try {
          await ensureInteractiveSession();
        } catch (e) {
          send({ error: e instanceof Error ? e.message : String(e), url: "", title: "", width: 0, height: 0, ts: Date.now() });
        }
        const latest = getLatestMirrorFrame();
        if (latest) send(latest);
        unsub = subscribeMirror(send);
        heartbeat = setInterval(() => send({ ping: Date.now() }), 15_000);
      })();
    },
    cancel() {
      cleanup();
    },
  });

  req.signal.addEventListener("abort", () => {
    cleanup();
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
