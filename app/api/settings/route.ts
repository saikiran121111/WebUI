import { NextResponse } from "next/server";
import { getSettings, updateSettings, clearSettings } from "../../../lib/server/settings";
import { parseEngineValue } from "@/lib/browser/engineConfig";
import { closeInteractiveSession } from "@/lib/browser/interactiveBrowser";

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
  // Browser engine — the SERVER value is authoritative for every session.
  // Reject unknown values; tear down any live panel session on change so
  // the next action starts under the new engine (no mixed-engine sessions).
  if ("browser_engine" in body) {
    const engine =
      typeof body.browser_engine === "string"
        ? parseEngineValue(body.browser_engine)
        : undefined;
    if (!engine) {
      return NextResponse.json(
        { error: "browser_engine must be chrome, brave, edge, or firefox" },
        { status: 400 },
      );
    }
    patch.browser_engine = engine;
  }
  const engineChanged =
    patch.browser_engine !== undefined &&
    patch.browser_engine !== getSettings().browser_engine;
  const settings = updateSettings(patch);
  if (engineChanged) {
    try {
      await closeInteractiveSession();
    } catch {
      // A stale session dies with the engine switch regardless.
    }
  }
  return NextResponse.json({ settings });
}

export async function DELETE() {
  clearSettings();
  return NextResponse.json({ ok: true });
}
