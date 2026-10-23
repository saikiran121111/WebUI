/**
 * Vision-to-Search entity pre-pass (Fix 2).
 *
 * When the user attaches a screenshot AND the turn triggers web search,
 * the MAIN vision model reads the image BEFORE the query planner runs and
 * extracts searchable entities — person full name, handle/username, job
 * title, company name, school, location, visible URLs/headlines. The
 * planner then anchors SERP queries on those entities
 * (`"<Full Name>" "<Company>" site:linkedin.com/in/`) instead of searching
 * blindly on the text prompt alone.
 *
 * This is a multimodal twin of llm-json.ts's jsonCompletion(): same
 * thinking-off body, same hard timeout, same inference-slot registration
 * (a new user turn aborts it — the single local slot always belongs to
 * user traffic), same never-throw contract. It exists separately only
 * because jsonCompletion's messages are plain strings, and a vision call
 * needs a content PARTS array.
 */
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
} from "./llm-json";

const log = childLogger("web-search/vision-prepass");

export interface VisionEntityResult {
  /** Concise searchable entity strings (names, companies, handles, places). */
  entities: string[];
  /** URLs literally visible in the image. */
  urls: string[];
  /** Short verbatim text readable in the image (headlines, bio lines). */
  imageText: string;
}

const VISION_SYSTEM =
  "You are an entity-extraction engine attached to a local AI assistant. " +
  "The user attached one or more screenshots. Read the image(s) and extract " +
  "ALL searchable entities: person full name, handle/username, job title, " +
  "company name, school, location, and any visible URLs or headlines. " +
  'Reply with ONLY a JSON object: {"entities": ["...", ...], "urls": ["...", ...], "imageText": "short verbatim readable text from the image"}';

/**
 * One multimodal pass over the attached image(s). Returns entity hints
 * ([] on ANY failure — a broken pre-pass must never break the turn; the
 * pipeline then plans from the text prompt alone).
 */
export async function runVisionEntityPrepass(
  imageDataUrls: string[],
  userPrompt: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<VisionEntityResult> {
  const empty: VisionEntityResult = { entities: [], urls: [], imageText: "" };
  const images = imageDataUrls.filter(
    (u) => typeof u === "string" && u.startsWith("data:image/"),
  );
  if (images.length === 0) return empty;

  const timeoutMs = opts.timeoutMs ?? 60_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  registerTitleCall(ctrl);

  const contentParts: unknown[] = [
    {
      type: "text",
      text:
        "User's request for context (the image belongs to it): " +
        userPrompt.replace(/\s+/g, " ").slice(0, 400) +
        "\n\nExtract the searchable entities from the attached image(s). " +
        "Keep entities short and exact (as they appear in the image).",
    },
    ...images.slice(0, 3).map((url) => ({ type: "image_url", image_url: { url } })),
  ];

  const body: Record<string, unknown> = {
    model: "default",
    stream: false,
    temperature: 0,
    max_tokens: 600,
    ...THINKING_OFF_BODY,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: VISION_SYSTEM },
      { role: "user", content: contentParts },
    ],
  };

  const started = Date.now();
  try {
    const res = await fetch(MAIN_LLM_ENDPOINT(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + LLM_API_KEY(),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      log.warn({ status: res.status }, "vision pre-pass non-200");
      return empty;
    }
    const data: any = await res.json().catch(() => null);
    const msg = data?.choices?.[0]?.message ?? {};
    const content = typeof msg.content === "string" ? msg.content : "";
    const reasoning = typeof msg.reasoning_content === "string" ? msg.reasoning_content : "";
    const raw = extractJsonObject(content) ?? extractJsonObject(reasoning);
    if (!raw) {
      log.warn({ ms: Date.now() - started }, "vision pre-pass returned no JSON object");
      return empty;
    }
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return empty;
    }
    const norm = (arr: unknown): string[] =>
      Array.isArray(arr)
        ? arr
            .map((s) => String(s ?? "").trim())
            .filter((s) => s.length >= 2 && s.length <= 160)
        : [];
    const out: VisionEntityResult = {
      entities: norm(parsed?.entities).slice(0, 10),
      urls: norm(parsed?.urls).filter((u) => /^https?:\/\//i.test(u)).slice(0, 5),
      imageText: String(parsed?.imageText ?? "").trim().slice(0, 400),
    };
    log.info(
      { ms: Date.now() - started, entities: out.entities.length },
      "vision pre-pass complete",
    );
    return out;
  } catch (err: unknown) {
    const name = (err as Error)?.name;
    log.warn(
      {
        ms: Date.now() - started,
        err: name === "AbortError" ? `timeout/abort (${timeoutMs}ms)` : (err as Error).message,
      },
      "vision pre-pass failed",
    );
    return empty;
  } finally {
    clearTimeout(timer);
    unregisterTitleCall(ctrl);
  }
}
