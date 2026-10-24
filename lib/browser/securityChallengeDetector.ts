/**
 * Security-challenge detection — classifies gates the agent must NOT
 * bypass, distinguished from ordinary web clutter.
 *
 * Detected (→ stop, hand control to the human, never automate around
 * them): CAPTCHA / anti-bot interstitials, MFA / OTP / passkey prompts,
 * hard login walls on private data, HTTP 403 / 429, account lockouts.
 *
 * NOT challenges (must not be misread as one — ordinary clutter):
 * cookie-consent banners, newsletter modals, age-gate "I am 18" buttons,
 * generic "sign up to save 10%" popups.
 *
 * Pure heuristics over url/title/body text/status — no network calls,
 * unit-testable against fixtures.
 */

export type ChallengeKind =
  | "captcha"
  | "anti_bot"
  | "mfa"
  | "login_wall"
  | "rate_limit"
  | "lockout"
  | "access_denied";

export interface ChallengeInfo {
  kind: ChallengeKind;
  /** What the human should do next (safe resumption guidance). */
  guidance: string;
}

export interface ChallengeProbe {
  url?: string;
  title?: string;
  /** Bounded visible page text (already extracted — we do NOT re-scan DOM). */
  text?: string;
  status?: number;
}

const CAPTCHA_RE =
  /\b(recaptcha|hcaptcha|captcha|are you a (real )?human|verify you are (a )?human|human verification|challenge-?proof|turnstile)\b/i;

const ANTI_BOT_RE =
  /\b(pardon our interruption|bot detected|detected automated (access|traffic)|unusual traffic|access denied\s*[—-]\s*automated|checking your browser|just a moment…?|enable javascript and cookies to continue)\b/i;

const MFA_RE =
  /\b(two-?factor|2fa|verification code|one-?time( code)?|otp\b|authenticator app|security code|enter the code (we )?(sent|texted|emailed)|passkey|face id|fingerprint unlock)\b/i;

const LOCKOUT_RE =
  /\b(account (has been )?(locked|suspended|disabled)|too many (failed )?(login|sign-?in) attempts|temporarily blocked)\b/i;

const LOGIN_WALL_RE =
  /\b(log ?in (to|first) (continue|access|view)|sign ?in to continue|please (log|sign) ?in to (access|view|continue)|authentication required|members ?-?only content)\b/i;

/** Ordinary clutter that must NEVER be classified as a challenge. */
const ORDINARY_RE =
  /\b(we use cookies|cookie (consent|banner|policy)|accept (all )?cookies|got it|manage (cookie|privacy) preferences|newsletter|subscribe (to|for) (our|the)? ?(newsletter|updates|daily)|save 10%|sign ?up (for|to get)|i am (18|over 18|an adult)|continue shopping)\b/i;

const GUIDANCE: Record<ChallengeKind, string> = {
  captcha: "Complete the human-verification check in the browser window, then say 'done' to resume.",
  anti_bot: "Finish the browser security check yourself in the window, then ask me to resume.",
  mfa: "Enter the verification code / passkey yourself — never share the code with me. Say 'done' after.",
  login_wall: "This page needs you signed in. Complete sign-in in the window yourself, then say 'done'.",
  rate_limit: "The site is rate-limiting. Wait a few minutes, then ask me to resume.",
  lockout: "The account is locked. Unlock it yourself (official recovery flow), then ask me to resume.",
  access_denied: "Access was denied. If you have an account, sign in in the window, then say 'done'.",
};

/**
 * Classify a challenge BEFORE any escalation strategy runs.
 * Order matters: lockout > mfa > captcha > anti_bot > rate_limit >
 * access_denied > login_wall. Text/URL signals win over a bare status
 * when both are present. Ordinary banners short-circuit to null.
 */
export function detectSecurityChallenge(p: ChallengeProbe): ChallengeInfo | null {
  const hay = `${p.title ?? ""}\n${(p.text ?? "").slice(0, 4000)}`;

  if (LOCKOUT_RE.test(hay)) return { kind: "lockout", guidance: GUIDANCE.lockout };
  if (MFA_RE.test(hay)) return { kind: "mfa", guidance: GUIDANCE.mfa };
  if (CAPTCHA_RE.test(hay)) return { kind: "captcha", guidance: GUIDANCE.captcha };
  if (ANTI_BOT_RE.test(hay)) return { kind: "anti_bot", guidance: GUIDANCE.anti_bot };

  // Status-based classifications only when no ordinary-clutter text dominates.
  if (p.status === 429 || /too many requests/i.test(hay)) {
    return { kind: "rate_limit", guidance: GUIDANCE.rate_limit };
  }
  if (p.status === 403 || /(^|\n)\s*403\b|forbidden\b/i.test(hay)) {
    // An access-denied page that is really just a cookie modal is not a challenge.
    if (ORDINARY_RE.test(hay) && !/\b403\b|forbidden/i.test(hay)) return null;
    return { kind: "access_denied", guidance: GUIDANCE.access_denied };
  }

  if (LOGIN_WALL_RE.test(hay) && !ORDINARY_RE.test(hay)) {
    return { kind: "login_wall", guidance: GUIDANCE.login_wall };
  }
  return null;
}

/** Map a detected challenge to the task-state waiting reason. */
export function challengeWaitingReason(kind: ChallengeKind): "waiting_for_login" | "waiting_for_user_action" {
  return kind === "mfa" || kind === "login_wall" || kind === "lockout"
    ? "waiting_for_login"
    : "waiting_for_user_action";
}
