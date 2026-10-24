/**
 * Six-layer recovery ladder for browser automation.
 *
 * When an action fails, we classify the FAILURE, then try strategies in
 * increasing cost/intrusion order:
 *
 *   1. semantic_dom        — act on the indexed ref map (zero screenshots)
 *   2. expanded_dom        — re-index with looser selectors (weak labels)
 *   3. frame_dom           — walk into iframes / open shadow roots
 *   4. keyboard            — Tab/arrows/Enter on focusable widgets
 *   5. visual_grounding    — ONE transient screenshot → local vision model
 *   6. authorized_alternative — ask for consent / use a structured path
 *   7. human_handoff       — stop, explain, hand the window to the user
 *
 * Security challenges are classified BEFORE escalation: a CAPTCHA, MFA
 * prompt, 403, or lockout goes STRAIGHT to human_handoff — we never
 * escalate against a security control (no bypass, no evasion, no
 * refresh loops). Ordinary UI failures never reach handoff without the
 * cheaper layers having been offered first.
 */

import type { ChallengeKind } from "./securityChallengeDetector";

export type BrowserStrategy =
  | "semantic_dom"
  | "expanded_dom"
  | "frame_dom"
  | "keyboard"
  | "visual_grounding"
  | "authorized_alternative"
  | "human_handoff";

export type FailureClass =
  | "target_not_found"
  | "stale_ref"
  | "ambiguous_target"
  | "iframe_barrier"
  | "shadow_dom_closed"
  | "canvas_only"
  | "security_challenge"
  | "rate_limit"
  | "login_required"
  | "consequential_blocked"
  | "action_failed"
  | "unknown";

export interface LadderDecision {
  /** Strategy to try next, or null when the ladder is exhausted. */
  strategy: BrowserStrategy | null;
  /** True when the task must wait for the human (handoff state). */
  handoff: boolean;
  /** Task waiting state to persist alongside the handoff. */
  waitingFor?: "waiting_for_user_action" | "waiting_for_login" | "waiting_for_confirmation";
  /** Human-readable reason when handoff is required. */
  reason?: string;
}

const FULL_LADDER: BrowserStrategy[] = [
  "semantic_dom",
  "expanded_dom",
  "frame_dom",
  "keyboard",
  "visual_grounding",
  "authorized_alternative",
  "human_handoff",
];

/** Strategies that apply for each failure class, cheapest first. */
export function strategiesForFailure(f: FailureClass): BrowserStrategy[] {
  switch (f) {
    case "stale_ref":
      return ["semantic_dom", "expanded_dom", "frame_dom", "keyboard", "human_handoff"];
    case "target_not_found":
    case "ambiguous_target":
      return ["expanded_dom", "frame_dom", "keyboard", "visual_grounding", "authorized_alternative", "human_handoff"];
    case "iframe_barrier":
      return ["frame_dom", "keyboard", "visual_grounding", "human_handoff"];
    case "shadow_dom_closed":
      return ["keyboard", "visual_grounding", "authorized_alternative", "human_handoff"];
    case "canvas_only":
      // Canvas UIs have no DOM targets at all — skip DOM layers entirely.
      return ["visual_grounding", "authorized_alternative", "human_handoff"];
    case "action_failed":
      return ["expanded_dom", "keyboard", "human_handoff"];
    case "unknown":
      return ["expanded_dom", "frame_dom", "keyboard", "human_handoff"];
    case "security_challenge":
    case "rate_limit":
    case "login_required":
    case "consequential_blocked":
      return ["authorized_alternative", "human_handoff"];
  }
}

/**
 * Pick the next strategy given what has ALREADY been attempted.
 * Security challenges short-circuit immediately to handoff (never
 * automated around); consequential-action blocks wait for confirmation.
 */
export function nextStrategy(
  failure: FailureClass,
  attempted: BrowserStrategy[],
  challenge?: ChallengeKind,
): LadderDecision {
  if (failure === "consequential_blocked") {
    return { strategy: "authorized_alternative", handoff: true, waitingFor: "waiting_for_confirmation" };
  }
  if (failure === "security_challenge") {
    const waitingFor =
      challenge === "mfa" || challenge === "login_wall" || challenge === "lockout"
        ? "waiting_for_login"
        : "waiting_for_user_action";
    return { strategy: "human_handoff", handoff: true, waitingFor };
  }

  const allowed = strategiesForFailure(failure);
  for (const s of FULL_LADDER) {
    if (!allowed.includes(s)) continue;
    if (attempted.includes(s)) continue;
    if (s === "human_handoff") {
      return { strategy: "human_handoff", handoff: true, waitingFor: "waiting_for_user_action" };
    }
    return { strategy: s, handoff: false };
  }
  // Ladder exhausted → clean handoff as last resort.
  return { strategy: "human_handoff", handoff: true, waitingFor: "waiting_for_user_action" };
}

/** Map raw playwright-style error text to a failure class (conservative). */
export function classifyFailure(errText: string, opts?: { challenge?: ChallengeKind }): FailureClass {
  if (opts?.challenge) return "security_challenge";
  const e = (errText ?? "").toLowerCase();
  if (/resolved to (0|no) (elements|nodes)|not found|no element/i.test(e)) return "target_not_found";
  if (/(stale|detached|gone)/.test(e)) return "stale_ref";
  if (/resolved to \d+ elements|strict mode violation|ambiguous/.test(e)) return "ambiguous_target";
  if (/frame|cross-?frame/.test(e)) return "iframe_barrier";
  if (/closed shadow|shadow root/.test(e)) return "shadow_dom_closed";
  if (/canvas|webgl/.test(e)) return "canvas_only";
  if (/429|rate.?limit|too many requests/.test(e)) return "rate_limit";
  if (/login|sign.?in/.test(e)) return "login_required";
  if (/element is not (visible|enabled|stable|attached)/.test(e)) return "action_failed";
  return "unknown";
}
