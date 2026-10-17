/**
 * Fence auto-repair helpers (pure, client-safe).
 *
 * A broken ```anatomy / ```scene3d / ```cad fence is the model's mistake,
 * and only the model can fix it. These helpers locate the broken fence
 * inside an assistant message, phrase its exact error as a repair request,
 * and splice the corrected fence back into the same bubble — so the user
 * sees the finished visual instead of a validation error they cannot act on.
 */
import { anatomySpecSchema } from "../anatomy/anatomySchema";
import { parseJsonFence } from "./schemas";
import { normalizeScene3d } from "../three3d/normalizeScene";
import { normalizeCad } from "../cad/normalizeCad";

/** Silent repair rounds per message before the honest error fallback stays. */
export const MAX_FENCE_REPAIRS = 2;

export interface BrokenFence {
  /** Exact validation message to feed back to the model. */
  error: string;
  /** Index in the message content where the fence body starts. */
  bodyStart: number;
  /** Index just past the fence body (at the closing ``` or content end). */
  bodyEnd: number;
  /** False when the fence was cut off mid-stream (no closing ```). */
  closed: boolean;
  /** Fence language tag; absent on anatomy fences (legacy contract). */
  lang?: string;
}

/**
 * Every fence of `lang` in `content` whose body `check` rejects. `check`
 * returns the exact error string or null when the body is loadable. An
 * unclosed fence runs to the end of content (stream truncated).
 */
function scanBrokenFences(
  content: string,
  lang: string,
  check: (body: string) => string | null,
  tagLang: boolean,
): BrokenFence[] {
  // Fence opener: ```lang (plus any attrs) up to its newline — or end of
  // content, covering a stream truncated right after the language tag.
  const open = new RegExp("```" + lang + "[^\\n]*(?:\\n|$)", "g");
  const broken: BrokenFence[] = [];
  let m: RegExpExecArray | null;
  while ((m = open.exec(content))) {
    const bodyStart = m.index + m[0].length;
    const close = content.indexOf("```", bodyStart);
    const closed = close >= 0;
    const bodyEnd = closed ? close : content.length;
    const error = check(content.slice(bodyStart, bodyEnd).trim());
    if (error) broken.push(tagLang ? { error, bodyStart, bodyEnd, closed, lang } : { error, bodyStart, bodyEnd, closed });
    if (!closed) break;
    open.lastIndex = close + 3;
  }
  return broken;
}

/** Every ```anatomy fence in `content` that the renderer would reject. */
export function findBrokenAnatomyFences(content: string): BrokenFence[] {
  return scanBrokenFences(content, "anatomy", body => {
    const parsed = parseJsonFence(body, anatomySpecSchema);
    return parsed.ok ? null : parsed.error;
  }, false);
}

/**
 * Broken 3D/CAD fences, checked against the SAME normalizers the viewer
 * blocks use — a fence only counts as broken when the viewer itself would
 * refuse to mount it. Anatomy fences keep their strict schema check.
 */
export function findBrokenRenderFences(content: string): BrokenFence[] {
  return [
    ...findBrokenAnatomyFences(content),
    ...scanBrokenFences(content, "scene3d", body => {
      const r = normalizeScene3d(body);
      return r.ok ? null : r.error;
    }, true),
    ...scanBrokenFences(content, "cad", body => {
      const r = normalizeCad(body);
      return r.ok ? null : r.error;
    }, true),
  ];
}

/**
 * The user turn that shows the model its own exact error. Wording matters:
 * naming the contract is what makes the model re-emit a valid fence on the
 * repair turn.
 */
export function fenceRepairRequest(broken: BrokenFence): string {
  const lang = broken.lang ?? "anatomy";
  if (lang === "anatomy") {
    return (
      "Your previous anatomy illustration fence failed validation: " + broken.error +
      " — fix that exact problem and re-emit the COMPLETE corrected fence now. " +
      "Output ONLY the corrected fence in one ```anatomy block: no prose, no explanation, no other changes."
    );
  }
  return fenceFixRequest(lang, broken.error);
}

/** Generic repair prompt for any fence language (```threejs / ```scene3d / ```cad …). */
export function fenceFixRequest(lang: string, error: string): string {
  return (
    "Your previous ```" + lang + " fence failed to load in the viewer: " + error +
    " — fix that exact problem and re-emit the COMPLETE corrected fence now. " +
    "Output ONLY the corrected fence in one ```" + lang + " block: no prose, no explanation, no other changes."
  );
}

/** Locate the first fence of `lang` in `content`, or null when absent. */
export function findFenceByLang(content: string, lang: string): { bodyStart: number; bodyEnd: number; closed: boolean; body: string } | null {
  const open = new RegExp("```" + lang + "[^\\n]*(?:\\n|$)").exec(content);
  if (!open) return null;
  const bodyStart = open.index + open[0].length;
  const close = content.indexOf("```", bodyStart);
  const closed = close >= 0;
  const bodyEnd = closed ? close : content.length;
  return { bodyStart, bodyEnd, closed, body: content.slice(bodyStart, bodyEnd).trim() };
}

/**
 * The first fence body of `lang` in a repair reply, or null when the model
 * answered with prose — a description of the fix is not a fix.
 */
export function extractFenceBody(reply: string, lang: string): string | null {
  const match = new RegExp("```" + lang + "[^\\n]*\\n([\\s\\S]*?)(?:```|$)").exec(reply);
  if (!match) return null;
  const body = match[1].trim();
  return body.length > 0 ? body : null;
}

export function extractAnatomyFenceBody(reply: string): string | null {
  return extractFenceBody(reply, "anatomy");
}

/** Replace the broken fence's body in `content` with the corrected one. */
export function applyFenceRepair(content: string, broken: BrokenFence, correctedBody: string): string {
  const prefix = content.slice(0, broken.bodyStart);
  if (broken.closed) return prefix + correctedBody + "\n" + content.slice(broken.bodyEnd);
  // The original fence never closed (stream truncated): close the repaired one.
  return prefix + correctedBody + "\n```";
}
