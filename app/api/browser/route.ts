/**
 * Browser Panel RPC proxy (Browser Use, Phase 3). POST {commandType,
 * session_id, turn_id, payload} → the Rust browser engine's command RPC
 * at `/api/ruke/browser/command`; the answer is forwarded verbatim (the
 * wire contract — `{"ok":true,"data":…}` / HTTP-200 typed errors — is
 * Rust's, not this route's).
 *
 * The bridge secret is injected SERVER-side (internalSecretHeaders): the
 * browser never sees it and cannot set it. When the Rust backend is not
 * running (RUKE_RUST_BACKEND unset) this route answers an honest 503 —
 * there is no TS browser subsystem, and faking one would be a lie
 * (Rule 18 / no-placeholder law).
 */
import { NextRequest, NextResponse } from "next/server";
import {
  internalSecretHeaders,
  rustEnabled,
  rustProxy,
} from "../../../lib/server/rustProxy";

export async function POST(req: NextRequest) {
  if (rustEnabled()) {
    return rustProxy(req, "/api/ruke/browser/command", {
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
