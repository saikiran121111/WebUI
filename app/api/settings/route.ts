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
  const settings = updateSettings(patch);
  return NextResponse.json({ settings });
}

export async function DELETE() {
  clearSettings();
  return NextResponse.json({ ok: true });
}
