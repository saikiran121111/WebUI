/**
 * Browser policy proxy (Browser Use, Phase 9). GET → Rust
 * `/api/ruke/browser/policy` returns the persisted facet rules
 * (`{"rules":{host:{facet:decision}}}`); PUT `{host,facet,decision}`
 * saves one rule or `{clear:host}` forgets a domain — answers are
 * forwarded verbatim (the wire contract is Rust's). The human-facing
 * "manage sites" UI rides this hop (settings surface lands with the
 * Phase-14 runtime pass).
 *
 * Bridge secret injected SERVER-side like every other internal hop;
 * honest 503 when the Rust backend is not running (no fake TS policy
 * store — Rule 18).
 */
import { NextRequest, NextResponse } from "next/server";
import {
  internalSecretHeaders,
  rustEnabled,
  rustProxy,
} from "../../../../lib/server/rustProxy";

function unavailable() {
  return NextResponse.json(
    {
      ok: false,
      error_code: "browser_context_unavailable",
      message:
        "the browser engine runs inside the Rust backend; start `npm run dev` " +
        "(the supervisor sets RUKE_RUST_BACKEND=1) to manage browser permissions",
    },
    { status: 503 },
  );
}

export async function GET(_req: NextRequest) {
  if (rustEnabled()) {
    return rustProxy(_req, "/api/ruke/browser/policy", {
      extraHeaders: internalSecretHeaders(),
    });
  }
  return unavailable();
}

export async function PUT(req: NextRequest) {
  if (rustEnabled()) {
    return rustProxy(req, "/api/ruke/browser/policy", {
      extraHeaders: internalSecretHeaders(),
    });
  }
  return unavailable();
}
