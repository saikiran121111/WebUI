/**
 * Level-5 fallback: visual grounding — ONE transient screenshot of the
 * live page is read by the LOCAL vision model (the same multimodal
 * transport as lib/web-search/vision-prepass.ts — no cloud vision, no new
 * dependency) to locate a target the DOM could not describe.
 *
 * Hard rules enforced here:
 *  - exactly ONE screenshot per grounding attempt, never continuous
 *    capture, never for OS engines (they never call this path);
 *  - output must pass a strict coordinate schema; anything malformed →
 *    refusal, never a guessed click;
 *  - LOW confidence or MULTIPLE plausible matches → refuse (return
 *    {ok:false, refused:true}) rather than act;
 *  - the screenshot is a transient in-memory buffer — never persisted,
 *    never logged, never sent anywhere except the local model endpoint.
 *
 * Deterministic tests set RUKE_VISION_MOCK=1 and a `__vision_mock__`
 * global inside the fixture page; the mock adapter reads it without any
 * model call (labeled env "mock").
 */
import type { Page } from "playwright";
import { childLogger } from "@/lib/server/logger";
import {
  registerTitleCall,
  unregisterTitleCall,
} from "@/lib/server/inference-busy";
import {
  MAIN_LLM_ENDPOINT,
  LLM_API_KEY,
  THINKING_OFF_BODY,
  extractJsonObject,
} from "@/lib/web-search/llm-json";

const log = childLogger("browser/visual-grounding");

const MIN_CONFIDENCE = 0.55;

export interface GroundTarget {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GroundingResult {
  ok: boolean;
  target?: GroundTarget;
  label?: string;
  confidence?: number;
  /** True when grounding refused to act (ambiguous / low-confidence). */
  refused?: boolean;
  error?: string;
}

const GROUND_SYSTEM =
  "You are a visual-grounding engine for a browser agent. You receive ONE " +
  "screenshot and a plain-language goal. Locate the single UI element that " +
  "matches the goal and reply with ONLY a JSON object: " +
  '{"label": "short element description", "x": <left px>, "y": <top px>, ' +
  '"width": <px>, "height": <px>, "confidence": <0..1>}. ' +
  "Coordinates are CSS pixels from the image's top-left. If the goal is " +
  'ambiguous or you are not confident, reply {"refused": true}. Never invent coordinates.';

function validateGrounding(
  raw: Record<string, unknown>,
  imgW: number,
  imgH: number,
): GroundingResult {
  if (raw.refused === true) {
    return { ok: false, refused: true, error: "model refused (ambiguous)" };
  }
  const x = Number(raw.x), y = Number(raw.y), w = Number(raw.width), h = Number(raw.height);
  const conf = Number(raw.confidence);
  const finite = [x, y, w, h].every((n) => Number.isFinite(n));
  if (!finite) return { ok: false, refused: true, error: "non-numeric coordinates" };
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > imgW + 2 || y + h > imgH + 2) {
    return { ok: false, refused: true, error: "coordinates outside image bounds" };
  }
  if (!Number.isFinite(conf) || conf < MIN_CONFIDENCE) {
    return { ok: false, refused: true, error: `confidence ${conf} below threshold` };
  }
  return {
    ok: true,
    target: { x, y, width: w, height: h },
    label: String(raw.label ?? "").slice(0, 120),
    confidence: conf,
  };
}

/**
 * Real adapter: multimodal JSON completion against the local endpoint —
 * identical etiquette to vision-prepass (single slot, new user turn
 * aborts, never throws). The screenshot data: URL comes from the caller
 * (which owns the Page handle; grounding stays page-agnostic and
 * unit-testable).
 */
async function defaultVisionAdapter(
  imageDataUrl: string,
  goal: string,
  imgW: number,
  imgH: number,
): Promise<GroundingResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45_000);
  registerTitleCall(ctrl);
  try {
    const body: Record<string, unknown> = {
      model: "default",
      stream: false,
      temperature: 0,
      max_tokens: 300,
      ...THINKING_OFF_BODY,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: GROUND_SYSTEM },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                `Goal: ${goal.replace(/\s+/g, " ").slice(0, 300)}\n` +
                `Image is ${imgW}x${imgH} CSS px. Locate the element or refuse.`,
            },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ],
    };
    const res = await fetch(MAIN_LLM_ENDPOINT(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + LLM_API_KEY(),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, refused: true, error: `vision endpoint ${res.status}` };
    const data: any = await res.json().catch(() => null);
    const msg = data?.choices?.[0]?.message ?? {};
    const content = typeof msg.content === "string" ? msg.content : "";
    const reasoning = typeof msg.reasoning_content === "string" ? msg.reasoning_content : "";
    const rawJson = extractJsonObject(content) ?? extractJsonObject(reasoning);
    if (!rawJson) return { ok: false, refused: true, error: "no JSON object from vision model" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      return { ok: false, refused: true, error: "unparseable grounding JSON" };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, refused: true, error: "grounding payload not an object" };
    }
    return validateGrounding(parsed as Record<string, unknown>, imgW, imgH);
  } catch (e) {
    log.warn({ err: String(e).slice(0, 120) }, "visual grounding call failed");
    return { ok: false, refused: true, error: "vision call failed" };
  } finally {
    clearTimeout(timer);
    unregisterTitleCall(ctrl);
  }
}

/**
 * Mock adapter (tests): reads the fixture page's `__vision_mock__` global.
 * Fixture contract: `{x,y,width,height,label,confidence}` for a hit,
 * `{refused:true}` or `{multiple:true}` for a refusal case. The caller
 * (browserActions) performs the single screenshot + telemetry; the mock
 * here never reads pixels — it only supplies deterministic coordinates.
 */
export async function mockGroundFromPage(
  page: Page,
): Promise<GroundingResult> {
  try {
    const mock = await page.evaluate(() => {
      const g = (window as unknown as { __vision_mock__?: unknown }).__vision_mock__;
      return g && typeof g === "object" ? (g as Record<string, unknown>) : null;
    });
    if (!mock) return { ok: false, refused: true, error: "fixture set no __vision_mock__" };
    if (mock.refused === true) return { ok: false, refused: true, error: "fixture: ambiguous visual target" };
    if (mock.multiple === true) return { ok: false, refused: true, error: "fixture: multiple plausible targets" };
    const r = validateGrounding(
      { ...mock, confidence: Number(mock.confidence ?? 1) },
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    );
    return r;
  } catch (e) {
    return { ok: false, refused: true, error: String(e).slice(0, 160) };
  }
}

export function visionMockEnabled(): boolean {
  return process.env.RUKE_VISION_MOCK === "1";
}

export { defaultVisionAdapter as visionGroundAdapter, validateGrounding };
