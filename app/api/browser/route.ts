/**
 * The browser agent's single control surface — the only execution entry
 * point for fenced ```browser_api payloads (components/render/
 * BrowserApiBlock.tsx POSTs the fence body verbatim).
 *
 * Extended semantic protocol ONLY: there is no legacy panel/coordinate
 * surface, no built-in WebUI browser, and no right-panel mirror. The
 * server-side session drives the user's own installed OS browser
 * (lib/browser/interactiveBrowser.ts); targeting, the fallback ladder,
 * challenge holds, server-side consequential gating, and sanitized
 * telemetry all live in lib/browser/browserActions.
 *
 * Responses carry the server-authoritative `engine` so the client never
 * guesses which browser answered. 200 = action executed; 422 = refused
 * or failed (the body's error/errorClass feed the model's next turn).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runExtendedAction } from "@/lib/browser/interactiveBrowser";
import {
  BATCHABLE,
  type BrowserApiAction,
} from "@/lib/browser/browserToolProtocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ── POST: one fenced browser_api action ─────────────────────────────────── */

/** Semantic target selectors — mirrors BrowserTargetFields bounds. */
const targetShape = {
  ref: z.string().trim().min(1).max(40).optional(),
  selector: z.string().trim().max(500).optional(),
  role: z.string().trim().max(40).optional(),
  name: z.string().trim().max(200).optional(),
  label: z.string().trim().max(200).optional(),
  // Visible-text target (weak-DOM pages). Doubles as fill/press content
  // aliases in the executor; the semantic locator owns the meaning.
  text: z.string().trim().min(1).max(200).optional(),
  snapshotId: z.number().int().positive().optional(),
};

const FieldSchema = z
  .object({
    ...targetShape,
    // Values pass through transiently; they are never stored server-side.
    value: z.string().max(1000).optional(),
    checked: z.boolean().optional(),
  })
  .strict();

const keysField = z.array(z.string().min(1).max(20)).max(40).optional();

const StepSchema = z
  .object({
    action: z.enum(BATCHABLE as [string, ...string[]]),
    url: z.string().trim().max(2048).optional(),
    value: z.string().max(1000).optional(),
    checked: z.boolean().optional(),
    keys: keysField,
    ...targetShape,
  })
  .strict();

const ActionSchema = z.enum([
  "click",
  "navigate",
  "snapshot",
  "fill",
  "select",
  "check",
  "hover",
  "press",
  "keyboard_nav",
  "fill_form",
  "batch",
  "resume_task",
  "authorize_browser_access",
]);

const ExtendedSchema = z
  .object({
    action: ActionSchema,
    ...targetShape,
    url: z.string().trim().max(2048).optional(),
    value: z.string().max(1000).optional(),
    checked: z.boolean().optional(),
    keys: keysField,
    fields: z.array(FieldSchema).max(32).optional(),
    submitMode: z.enum(["prepare_only", "submit"]).optional(),
    steps: z.array(StepSchema).max(8).optional(),
    // Advisory ONLY — the server enforces gating via its own grant state.
    confirmConsequential: z.boolean().optional(),
  })
  .strict();

export async function POST(req: NextRequest): Promise<NextResponse> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  let parsed: z.infer<typeof ExtendedSchema>;
  try {
    parsed = ExtendedSchema.parse(raw);
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid browser_api action payload (extended semantic protocol only)" },
      { status: 400 },
    );
  }
  const result = await runExtendedAction(parsed as unknown as BrowserApiAction);
  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
}
