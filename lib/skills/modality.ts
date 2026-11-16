/**
 * Modality filter: a skill that REQUIRES an external image/video generation
 * service can never run against this install, so it gets blocked at index
 * time. Skills that draw with CODE (Three.js, WebGL, Canvas, SVG) stay allowed.
 *
 * F20 (brief 2026-11-15): the previous law blocked on a bare BRAND MENTION,
 * which reproduced two false blocks -
 *   - "a CSV guide explaining why not to use Midjourney" -> blocked, and
 *   - "a text guide to Leonardo da Vinci"                -> blocked.
 * A name is not a capability requirement. The law is now evidence-shaped:
 *
 *   A. DECLARED (authoritative): the application-owned scenario metadata may
 *      state `requiredCapabilities`. If every declared capability is missing
 *      here, block; if all are available, allow. This is the supported place
 *      for a skill to state a requirement, and it is language-independent.
 *   B. PROTOCOL evidence anywhere in the body: an endpoint/URL path only a
 *      media-generation API has, a provider API-key variable, an HTTP client
 *      call to such a path, or an explicit "requires: image-generation" line.
 *   C. NAME + INSTRUCTION evidence, frame by frame: an unambiguous provider
 *      form (never a bare ambiguous word such as firefly/imagen/leonardo/
 *      sora/pika/kling/veo/runway/flux, which need a service affix) inside a
 *      frame that ALSO carries an operation on a media object.
 *   A frame in a negation / comparison / explanatory frame ("do not use",
 *   "instead of", "why not", "compared with", "explain") is DISCUSSION and
 *   never blocks on name evidence. The frame splitter is the reach test: a
 *   negation cannot cross a sentence boundary, so "Don't use Excel. Generate
 *   the image with Midjourney." still blocks.
 *   D. CAPABILITY phrasing with no vendor at all ("text-to-image", "generate
 *      images") blocks unless that same frame is code-driven visual work.
 *
 * Recorded limitation, not papered over: routes C and D are English-shaped.
 * A is authoritative and language-independent; B is protocol-shaped, so a
 * non-English skill states its requirement in metadata or shows its endpoint.
 * The safe direction of ambiguity is ALLOW (a false block silently removes a
 * working skill; a missed block only produces a typed runtime failure).
 */

import { BLOCKED_REASON } from "./types";

export type MediaGenerationCapability = "image-generation" | "video-generation";

export const MEDIA_GENERATION_CAPABILITIES: readonly MediaGenerationCapability[] = [
  "image-generation",
  "video-generation",
];

/** Capability ids this install can actually run (no media-generation adapter). */
export function availableMediaCapabilities(): readonly MediaGenerationCapability[] {
  return [];
}

/** Normalizes declared-capability spelling so "image generation" == "image-generation". */
function canonicalCapability(value: unknown): MediaGenerationCapability | null {
  const c = String(value ?? "")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-");
  if (/^(image|picture|illustration|photo|art)-(generation|generator|api)$/.test(c)) return "image-generation";
  if (/^(video|clip|footage|animation)-(generation|generator|api)$/.test(c)) return "video-generation";
  return null;
}

/** (A) Requirements declared by the application-owned scenario metadata. */
export function declaredCapabilities(meta: unknown): MediaGenerationCapability[] {
  const raw = (meta as { requiredCapabilities?: unknown } | null)?.requiredCapabilities;
  if (!Array.isArray(raw)) return [];
  const out: MediaGenerationCapability[] = [];
  for (const entry of raw) {
    const c = canonicalCapability(entry);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/** (C-i) Brand forms that can ONLY name a media-generation service. */
const PROVIDER_FORM: RegExp[] = [
  /d[\s-]*all[\s-]*e\b/i,
  /\bmidjourney\b/i,
  /\bstable[\s-]*diffusion\b/i,
  /\bdiffusion[\s-]*xl\b/i,
  /\bcomfy[\s-]?ui\b/i,
  /\badobe[\s-]*firefly\b/i,
  /\brunway[\s-]*(?:ml|app|gen[23]?|[23])\b/i,
  /\bgoogle[\s-]*imagen\b/i,
  /\bleonardo\.ai\b/i,
  /\bleonardo[\s-]*labs\b/i,
  /\bseedream\b/i,
  /\brecraft\b/i,
  /\bideogram\b/i,
  /\bparti[\s-]*designs?\b/i,
  /\bflux[\s.-][12][\s-]*(?:dev|schnell|pro|kontext|flex|strong|fill|depth|redux)\b/i,
  /\bsora[\s-]*(?:[23]|two|turbo|sampler)\b/i,
  /\bveo[\s-]*[23]\b/i,
  /\bpika[\s-]*(?:labs|schema|1|2)\b/i,
  /\bkling[\s-]*(?:ai|[\d@][.\d]*)\b/i,
];

/** Ambiguous words: only a service/protocol affix in the same frame makes them an identity. */
const AMBIGUOUS_WORD: RegExp[] = [
  /\bfirefly\b/i,
  /\bimagen\b/i,
  /\bleonardo\b/i,
  /\bsora\b/i,
  /\bpika\b/i,
  /\bkling\b/i,
  /\bveo\b/i,
  /\brunway\b/i,
  /\bflux\b/i,
  /\bseedream\b/i,
  /\bdiffusion\b/i,
];
const SERVICE_QUALIFIER =
  /\b(?:api|apis|endpoint|endpoints|service|services|model|models|sdk|cli|tool|tools|provider|providers|engine|host|url|uri|key|keys|token|secret|hosted|cloud|server|workflow|workflows|pipeline|pipelines|prompt|prompts|imagine|upscale|img2img|txt2img|outpaint|inpaint|denoise|sampler|checkpoint|lora|discord|webhook|dashboard|website|account|subscription|credits)\b/i;

/** (D) Capability phrasing that names the capability itself, without a vendor. */
const CAPABILITY_STRONG: RegExp[] = [
  /\btext[\s-]*to[\s-]*(?:image|images|video|videos|animation)\b/i,
  /\bimage[\s-]*to[\s-]*(?:video|videos|animation)\b/i,
  /\b(?:image|video|picture|illustration|photo)[\s-]*generation[\s-]*(?:api|apis|model|models|service|services|tool|tools|endpoint|endpoints|provider|providers|engine|backend|worker|key)\b/i,
];
const CAPABILITY_WEAK: RegExp[] = [
  /\b(?:image|video)[\s-]*generation\b/i,
  /\b(?:generate|generates|generating|create|creates|creating|produce|produces|producing|render|renders|draw|draws)\s+(?:ai[\s-])?(?:an?\s+|the\s+)?(?:images?|videos?|clips?|footage|thumbnails?|illustrations?|banners?|logos?|hero)\b/i,
];

/** (B) Whole-document protocol evidence: what a real integration writes. */
const PROTOCOL_EVIDENCE: RegExp[] = [
  /https?:\/\/[^\s)"\x27<>]*(?:images?\/generations|videos?\/generations|text-to-image|text-to-video|img2img|txt2img|dream\/submit|imagine\/submit|generate\?)/i,
  /\b(?:post|put)\s+[^\n]{0,80}(?:images?\/generations|videos?\/generations|imagine\/submit|dream\/submit)/i,
  /\b(?:curl|wget|fetch\s*\(|axios\.post|requests\.(?:post|get)|httpx\.post|urllib)[^\n]{0,160}(?:images?\/generations|videos?\/generations|imagine\/submit|dream\/submit|\/imagine)/i,
  /\b(?:midjourney|stable[_-]?diffusion|stability[_-]?ai|comfyui|leonardo[_-]?ai|runway[_-]?ml|ideogram|replicate|flux|sora)[_-]?(?:api|access)?[_-]?(?:api[_-]?)?(?:key|token|secret|url|base)\b/i,
  /\b(?:image|video)[_-]?(?:generation)?[_-]?(?:api|endpoint)[_-]?(?:key|token|url|base)\b/i,
  /^[-\s*>#]*requires[\s-]*(?:capabilities|capability|media|external)?\s*:[^\n]{0,80}(?:image|video)[-\s]*generation/im,
  /\b(?:requires|needs|depend(?:s|ing)? on)[^\n]{0,60}\b(?:an?\s+)?(?:image|video)[-\s]*generation\b[^\n]{0,30}\b(?:api|service|model|provider|endpoint)\b/i,
];

/** (C-ii) operation frames - things one does TO/with a generation service. */
const OPERATION_FRAME =
  /\b(?:imagine|prompt|prompts|prompting|upscale|upscales|variations?|remix|outpaint|inpaint|img2img|txt2img|denoise|sampler|steps|seed|negative prompt|aspect ratio|--ar\b|workflow|workflows|pipeline|pipelines|sketch|generate|generates|generating|create|creates|creating|render|renders|draw|draws|paint|paints|send|sends|pipe|routes|feeds?|feed|upload|uploads|use|uses|using|run|runs|running|execute|executes|call|calls|invoke|invokes)\b/i;
/** (C-ii-b) an explicit dependency statement is also a requirement. */
const REQUIRE_FRAME =
  /\b(?:requires?|required|requirement|needs?|depending on|depends? on|depend on|prerequisite|prerequisites|install(?:ling)?|set up|setup of|must use|must have)\b/i;

const MEDIA_OBJECT_FRAME =
  /\b(?:images?|videos?|clips?|footage|pictures?|thumbnails?|illustrations?|logos?|posters?|frames?|artwork|photos?|icons?|banners?|hero|mockups?|assets?|scenes?|characters?|backgrounds?|sprites?|animation|portraits?|wallpapers?)\b/i;

/** (C-iii) talking ABOUT a service is not a requirement to run it. */
const DISCUSSION_FRAME =
  /\b(?:do not|don[\x27]t|dont|does not|doesn[\x27]t|doesnt|did not|didn[\x27]t|didnt|will not|won[\x27]t|cannot|can[\x27]t|cant|could not|couldn[\x27]t|should not|shouldn[\x27]t|would not|wouldn[\x27]t|never|no need|not need|not want|not use|not using|not to use|no use of|avoid(?:s|ing)?|without|refrain|skip(?:s|ping)?|refuse[sd]?|forbid(?:den)?|prohibit(?:ed)?|banned?|against|why not|why never|when not|what not|instead of|rather than|unlike|compared? (?:to|with)|comparison|versus|\bvs\b|alternative(?:s)?|explain(?:s|ing)?|discuss(?:es|ing)?|review(?:s|ing)?|critique|analyse[sd]?|analyze[sd]?|comparing|pros and cons|history|architectur\w*|paper|benchmark(?:s|ing)?|guide to avoiding)\b/i;

/** Code-driven visuals are NOT an external generation API. */
const CODE_VIZ =
  /\bthree(?:\.?js)?\b|\bwebgl\b|\bwebgpu\b|\bglsl\b|\bshaders?\b|\bcanvas\b|\bsvgs?\b|\bd3(?:\.?js)?\b|\bprocedural\b|\bisometric\b|\bdiagrams?\b|\bcharts?\b|\bmatplotlib\b|\bplotly\b|\breportlab\b|\bhtml[\s-]canvas\b/i;

/** Frame split without lookbehind, so the Rust port can mirror it exactly. */
export function capabilityFrames(markdown: string): string[] {
  return String(markdown ?? "")
    .replace(/\r\n?/g, "\n")
    .split(/[.!?;:\n|()\[\]#]+/)
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
}

/** Capability inference for the evidence routes that need a capability id. */
export function inferCapabilityFromBody(body: string): MediaGenerationCapability[] {
  const out: MediaGenerationCapability[] = [];
  if (
    /\bimage[-\s]*generat|\bimage[_-]generation|\bimages?[/-]generations?\b|\btext[\s-]*to[\s-]*images?\b|\bimg2img\b|\btxt2img\b|\bd[\s-]*all[\s-]*e\b|\bmidjourney\b|midjourney[_-]|\bstable[\s-]*diffusion\b|stable[_-]diffusion|\bdiffusion[\s-]*xl\b|\bcomfy[\s-]?ui\b|\bleonardo\.ai\b|\bideogram\b|\bseedream\b|\brecraft\b|\badobe[\s-]*firefly\b|\bgoogle[\s-]*imagen\b|\bflux[\s.-][12]\b|generate\s+(?:an?\s+)?images?\b/i.test(
      body,
    )
  )
    out.push("image-generation");
  if (
    /\bvideo[-\s]*generat|\bvideo[_-]generation|\bvideos?[/-]generations?\b|\btext[\s-]*to[\s-]*videos?\b|\bimage[\s-]*to[\s-]*video\b|\bsora[\s-]*(?:[23]|two|turbo)\b|\brunway[\s-]*(?:ml|[23])\b|\bveo[\s-]*[23]\b|\bpika[\s-]*(?:labs|1|2)\b|\bkling[\s-]*(?:ai|[\d@])/i.test(
      body,
    )
  )
    out.push("video-generation");
  return out;
}

/**
 * Returns BLOCKED_REASON when the skill genuinely needs an external media
 * generation service that this install cannot run; null otherwise.
 * `meta` is the application-owned scenario object (`requiredCapabilities`).
 */
export function detectBlockedReason(
  skillMarkdown: string,
  meta?: unknown,
  available: readonly MediaGenerationCapability[] = availableMediaCapabilities(),
): string | null {
  const body = String(skillMarkdown ?? "");
  if (!body.trim()) return null;

  // (A) Declared requirements are authoritative: application-owned metadata.
  const declared = declaredCapabilities(meta);
  if (declared.length) {
    return declared.some((c) => !available.includes(c)) ? BLOCKED_REASON : null;
  }

  const wanted = inferCapabilityFromBody(body);
  // Every capability the body names is runnable here -> nothing is missing.
  if (wanted.length && wanted.every((c) => available.includes(c))) return null;
  // An unknown capability plus a runnable media capability is not proof of a
  // missing requirement; we only block on an unknown capability when this
  // install cannot run ANY media generation.
  const unknownCapability = !wanted.length && available.length > 0;

  // (B) Hard protocol evidence - the integration itself, prose-independent.
  if (PROTOCOL_EVIDENCE.some((pattern) => pattern.test(body))) {
    return unknownCapability ? null : BLOCKED_REASON;
  }
  if (unknownCapability) return null;

  // (C) Name + instruction evidence, frame by frame. A bare brand mention in a
  // discussion/negation frame never blocks; the frame boundary is what lets a
  // negation reach (or fail to reach) the name.
  const frames = capabilityFrames(body);
  for (const frame of frames) {
    if (DISCUSSION_FRAME.test(frame)) continue;
    const strongName = PROVIDER_FORM.some((p) => p.test(frame));
    const ambiguousName = AMBIGUOUS_WORD.some((p) => p.test(frame));
    if (!strongName && !(ambiguousName && SERVICE_QUALIFIER.test(frame))) continue;
    if (
      (OPERATION_FRAME.test(frame) || REQUIRE_FRAME.test(frame)) &&
      (MEDIA_OBJECT_FRAME.test(frame) || strongName || SERVICE_QUALIFIER.test(frame))
    )
      return BLOCKED_REASON;
  }

  // (D) Capability phrasing with no vendor: a requirement unless that same
  // frame draws with code (Canvas/SVG/Three.js/matplotlib are not APIs).
  for (const frame of frames) {
    if (DISCUSSION_FRAME.test(frame)) continue;
    if (CAPABILITY_STRONG.some((p) => p.test(frame))) return BLOCKED_REASON;
    if (!CODE_VIZ.test(frame) && CAPABILITY_WEAK.some((p) => p.test(frame))) return BLOCKED_REASON;
  }
  return null;
}