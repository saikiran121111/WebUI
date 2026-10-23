/**
 * Interactive login browser control surface (Part 3).
 *
 * The right Browser panel POSTs one zod-validated action per user input
 * (click / type / scroll / navigate / back / reload), and reports the
 * sign-in hand-off with `done_login` — which copies the persistent
 * profile's cookies into the extraction pool so the AI's next read of the
 * authenticated tab succeeds. Headful Chromium stays project-scoped in
 * `.data/browser-profile`; zero paid APIs.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { interact, type InteractiveAction } from "@/lib/browser/interactiveBrowser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ActionSchema = z
  .object({
    action: z.enum(["start", "click", "type", "scroll", "navigate", "back", "reload", "done_login"]),
    x: z.number().finite().min(-100000).max(100000).optional(),
    y: z.number().finite().min(-100000).max(100000).optional(),
    dy: z.number().finite().optional(),
    // Sign-in fields are short; cap keeps a chatty client from flooding keys.
    text: z.string().max(2000).optional(),
    submit: z.boolean().optional(),
    url: z.string().trim().max(2048).optional(),
  })
  .strict();

export async function POST(req: NextRequest): Promise<NextResponse> {
  let parsed: z.infer<typeof ActionSchema>;
  try {
    parsed = ActionSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: "invalid action payload" }, { status: 400 });
  }
  const action: InteractiveAction = {
    action: parsed.action,
    ...(parsed.x !== undefined ? { x: parsed.x } : {}),
    ...(parsed.y !== undefined ? { y: parsed.y } : {}),
    ...(parsed.dy !== undefined ? { dy: parsed.dy } : {}),
    ...(parsed.text !== undefined ? { text: parsed.text } : {}),
    ...(parsed.submit !== undefined ? { submit: parsed.submit } : {}),
    ...(parsed.url !== undefined ? { url: parsed.url } : {}),
  };
  const status = await interact(action);
  return NextResponse.json(status, { status: status.ok ? 200 : 422 });
}
