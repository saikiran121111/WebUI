/**
 * Developer-facing Decision Engine endpoint (spec Phase 3):
 * POST {message, conversationHistory?} -> DecisionEnvelope JSON.
 * The chat route uses the same lib/decision/client path internally; this
 * route exists for testing/inspection (tests/test-decision-router.mjs).
 */
import { NextRequest, NextResponse } from "next/server";
import { getDecision } from "../../../lib/decision/client";
import { childLogger } from "../../../lib/server/logger";
import { logDecisionTable } from "../../../lib/server/decision-log";

const log = childLogger("api/decision");

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const message = typeof body === "object" && body !== null ? (body as { message?: unknown }).message : undefined;
  if (typeof message !== "string" || !message.trim()) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }
  const history = typeof body === "object" && body !== null && Array.isArray((body as { conversationHistory?: unknown }).conversationHistory)
    ? (body as { conversationHistory: { role: string; content: string }[] }).conversationHistory
    : [];

  const t0 = Date.now();
  const env = await getDecision(message, history);
  logDecisionTable(log, { input: message, env, totalMs: Date.now() - t0 });
  return NextResponse.json(env);
}
