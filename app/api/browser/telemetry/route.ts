/**
 * Sanitized browser-agent telemetry snapshot (lib/browser/telemetry.ts).
 * Counters + bounded latency stats only — never URLs, page text, form
 * values, or anything identifying. Read by tests (zero-screenshot
 * assertions) and the diagnostics view.
 */
import { NextResponse } from "next/server";
import { browserTelemetrySnapshot } from "@/lib/browser/telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: true, telemetry: browserTelemetrySnapshot() });
}
