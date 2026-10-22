import { NextResponse } from "next/server";
import { getSettings, updateSettings, clearSettings } from "../../../lib/server/settings";

export async function GET() {
  return NextResponse.json({ settings: getSettings() });
}

export async function PUT(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const patch: Parameters<typeof updateSettings>[0] = {};
  if (typeof body.llm_api_url === "string" && body.llm_api_url.trim()) {
    patch.llm_api_url = body.llm_api_url.trim();
  }
  if (typeof body.llm_api_key === "string") {
    patch.llm_api_key = body.llm_api_key;
  }
  // Auto-compact threshold (the chat UI's own setting — server persists it,
  // never reads it into the LLM path).
  const ct = body.compact_thresholds;
  if (ct && typeof ct === "object" && "auto" in ct && "tokens" in ct) {
    const auto = (ct as { auto?: unknown }).auto;
    const tokens = (ct as { tokens?: unknown }).tokens;
    patch.compact_thresholds = {
      auto: auto === 1 ? 1 : 0,
      tokens: typeof tokens === "number" && Number.isFinite(tokens)
        ? Math.max(0, Math.round(tokens))
        : 0,
    };
  }
  const settings = updateSettings(patch);
  return NextResponse.json({ settings });
}

export async function DELETE() {
  clearSettings();
  return NextResponse.json({ ok: true });
}
