import { BLOCKED_REASON } from "./types";

/**
 * Modality filter: a skill that REQUIRES an external image/video generation
 * service (DALL-E, Midjourney, Stable Diffusion, ComfyUI, Sora, Runway, Flux
 * text-to-image/video, ...) can never run against a local text-only model, so
 * it gets blocked at index time. Skills that draw with CODE (Three.js, WebGL,
 * Canvas, SVG — e.g. the isometric anatomy illustration pipeline) are allowed.
 */

/** Unambiguous external-generation signals: block regardless of anything else. */
const STRONG_BLOCK_PATTERNS: RegExp[] = [
  /d[\s-]*all[\s-]*e\b/i,
  /\bmidjourney\b/i,
  /\bstable diffusion\b/i,
  /\bcomfy[\s-]?ui\b/i,
  /\bsora(?:\s?[\d2])?\b/i,
  /\brunway(?:\s?ml\d?)?\b/i,
  /\badobe firefly\b/i,
  /\bfirefly\b/i,
  /\bgoogle imagen\b/i,
  /\bimagen\b/i,
  /\bleonardo(?:\.ai| labs)?\b/i,
  /\bseedream\b/i,
  /\bkling(?:\s?ai)?\b/i,
  /\bveo\s?[\d23]\b/i,
  /\bpika(?:\s?labs)?\b/i,
  /\bflux(?:\.1)?[\s-](?:dev|schnell|pro|kontext)\b/i,
  /\btext[\s-]*to[\s-]*(?:image|video|animation)\b/i,
  /\bimage generation (?:api|model|service|tool|endpoint|provider)\b/i,
  /\bvideo generation (?:api|model|service|tool|endpoint|provider)\b/i,
];

/**
 * Ambiguous signals: only block when the skill is NOT code-driven visuals.
 * "generate images" inside a Three.js/Canvas skill means rendering with code,
 * not calling an external generation service — so these stay weak.
 */
const WEAK_BLOCK_PATTERNS: RegExp[] = [
  /\bimage generation\b/i,
  /\bvideo generation\b/i,
  /\b(?:generate|generating|generates) (?:ai[\s-])?(?:an? )?(?:images?|videos?|clips?|pictures?|footage|thumbnails?)\b/i,
];

/** Code-driven visual skills stay allowed. */
const CODE_VIZ_ALLOW =
  /\bthree(?:\.?js)?\b|\bwebgl\b|\bwebgpu\b|\bglsl\b|\bshaders?\b|\bcanvas\b|\bsvgs?\b|\bd3(?:\.?js)?\b|\bprocedural\b|\bisometric\b|\bdiagrams?\b|\bcharts?\b/i;

/** Returns BLOCKED_REASON when the skill needs an external media-generation API. */
export function detectBlockedReason(skillMarkdown: string): string | null {
  if (STRONG_BLOCK_PATTERNS.some((pattern) => pattern.test(skillMarkdown))) return BLOCKED_REASON;
  if (CODE_VIZ_ALLOW.test(skillMarkdown)) return null;
  if (WEAK_BLOCK_PATTERNS.some((pattern) => pattern.test(skillMarkdown))) return BLOCKED_REASON;
  return null;
}
