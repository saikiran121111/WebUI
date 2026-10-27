import { NextRequest, NextResponse } from "next/server";
import { llmApiUrl, llmApiKey } from "../../../lib/server/settings";
import { rustEnabled, rustProxy } from "../../../lib/server/rustProxy";

/**
 * Custom stats endpoint backing the composer token meter.
 * Proxies the inference server's own informational endpoints so the browser
 * never learns the model URL or key. Zero inference cost — these are status
 * reads, not completions.
 *
 *   GET /api/model-stats          → { ok, model_alias, n_ctx, total_slots }
 *   GET /api/model-stats?live=1   → { ok, processing, prompt_tokens, n_ctx }
 *
 * Upstream unreachable (or not llama.cpp) → { ok: false } with a 200, so the
 * client can show an honest empty state instead of an error toast.
 */

const UPSTREAM_TIMEOUT_MS = 3000;

function upstreamOrigin(): string | null {
  try {
    return new URL(llmApiUrl()).origin;
  } catch {
    return null;
  }
}

async function fetchUpstream(path: string): Promise<unknown | null> {
  const origin = upstreamOrigin();
  if (!origin) return null;
  try {
    const key = llmApiKey();
    const res = await fetch(origin + path, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  if (rustEnabled()) return rustProxy(req, "/api/ruke/model-stats");
  if (req.nextUrl.searchParams.get("live") === "1") {
    const slots = await fetchUpstream("/slots");
    if (!Array.isArray(slots)) return NextResponse.json({ ok: false });
    const slot: Record<string, unknown> =
      slots.find((s) => s && typeof s === "object" && s.is_processing === true) ??
      slots[0] ??
      {};
    return NextResponse.json({
      ok: true,
      processing: slot.is_processing === true,
      prompt_tokens: typeof slot.n_prompt_tokens === "number" ? slot.n_prompt_tokens : null,
      n_ctx: typeof slot.n_ctx === "number" ? slot.n_ctx : null,
    });
  }

  const props = await fetchUpstream("/props");
  if (!props || typeof props !== "object") return NextResponse.json({ ok: false });
  const p = props as Record<string, unknown>;
  const genSettings: Record<string, unknown> =
    p.default_generation_settings && typeof p.default_generation_settings === "object"
      ? (p.default_generation_settings as Record<string, unknown>)
      : {};
  return NextResponse.json({
    ok: true,
    model_alias: typeof p.model_alias === "string" ? p.model_alias : null,
    n_ctx: typeof genSettings.n_ctx === "number" ? genSettings.n_ctx : null,
    total_slots: typeof p.total_slots === "number" ? p.total_slots : null,
  });
}
