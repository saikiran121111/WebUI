/**
 * Browser Panel socket ticket (Browser Use, Phase 3). POST (no body) →
 * proxied to Rust `/api/ruke/browser/ws-ticket`, bridge-authed
 * server-side; the panel receives `{ws_url, ticket, ttl_ms}`.
 *
 * The panel dials `ws_url` DIRECTLY against the loopback Rust server —
 * Next cannot proxy a WebSocket upgrade (rustProxy strips `upgrade`).
 * The ticket is what gates that handshake (plus the Rust-side Origin
 * allowlist); it is one-shot and short-lived, so it is safe for it to
 * live in the page's memory. Never logged here, never persisted.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  internalSecretHeaders,
  rustEnabled,
  rustProxy,
} from "../../../../lib/server/rustProxy";

export async function POST(req: NextRequest) {
  if (rustEnabled()) {
    return rustProxy(req, "/api/ruke/browser/ws-ticket", {
      extraHeaders: internalSecretHeaders(),
    });
  }
  return NextResponse.json(
    {
      ok: false,
      error_code: "browser_context_unavailable",
      message:
        "the browser engine runs inside the Rust backend; start `npm run dev` " +
        "(the supervisor sets RUKE_RUST_BACKEND=1) to use the Browser Panel",
    },
    { status: 503 },
  );
}
