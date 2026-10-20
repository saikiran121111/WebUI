/**
 * Anti-bot block detection — runs on the RAW HTML before DOM extraction
 * so a WAF/challenge page is NEVER fed to readability or the BM25 reranker.
 *
 * Every detector returns a `BlockVerdict` that the extractor uses to
 * short-circuit Tier 1 and jump straight to the Tier 2 (Jina) / Tier 3
 * (snippet) fallbacks. A "silent" block (200 OK + challenge body) is the
 * hardest failure mode in the corpus — these detectors are what make it
 * detectable and recoverable.
 */

export type BlockKind =
  | "cloudflare"
  | "akamai"
  | "perimeterx"
  | "datadome"
  | "captcha"
  | "js-required"
  | "login-wall"
  | "amazon-robot"
  | "generic-bot"
  | null;

export interface BlockVerdict {
  blocked: boolean;
  kind: BlockKind;
  /**
   * A short human-readable reason (used in the stress-test report,
   * never sent back to a model).
   */
  reason: string;
}

/* ── signature tables ───────────────────────────────────────────────────── */

// Order matters: the first matching signature wins. Each entry is a
// case-insensitive substring OR a regex against the first 4 KB of body
// (challenge pages front-load the signal).
interface Signature {
  kind: BlockKind;
  match: (head: string, status: number, contentType: string) => boolean;
  reason: string;
}

const SIGNATURES: Signature[] = [
  // Cloudflare Turnstile / challenge
  {
    kind: "cloudflare",
    reason: "Cloudflare challenge / Turnstile",
    match: (head, status) =>
      head.includes("cf-chl") ||
      head.includes("challenge-platform") ||
      head.includes("cf-turnstile") ||
      head.includes("__cf_chl") ||
      head.includes("Just a moment") ||
      head.includes("Checking your browser") ||
      (status === 503 && head.includes("cf-ray")),
  },
  // Akamai Bot Manager
  {
    kind: "akamai",
    reason: "Akamai Bot Manager block",
    match: (head, status) =>
    head.includes("akamai") &&
      (head.includes("bot") || head.includes("dm_oo") || head.includes("akb")) ||
      head.includes("Please enable cookies") && head.includes("akamai"),
  },
  // PerimeterX / HUMAN
  {
    kind: "perimeterx",
    reason: "PerimeterX / HUMAN bot challenge",
    match: (head) =>
      head.includes("_pxhd") ||
      head.includes("_px2") ||
      head.includes("perimeterx") ||
      head.includes("PX-Captcha"),
  },
  // DataDome
  {
    kind: "datadome",
    reason: "DataDome bot challenge",
    match: (head) =>
      head.includes("_ddg") ||
      head.includes("datadome") ||
      head.includes("dd-") && head.includes("captcha"),
  },
  // Generic CAPTCHA (reCAPTCHA, hCaptcha, Arkose/FunCaptcha)
  {
    kind: "captcha",
    reason: "CAPTCHA challenge",
    match: (head) =>
      head.includes("g-recaptcha") ||
      head.includes("hcaptcha") ||
      head.includes("funcaptcha") ||
      head.includes("arkoselabs") ||
      head.includes("Please verify you are not a robot") ||
      head.includes("I'm not a robot"),
  },
  // "Enable JavaScript and cookies to continue"
  {
    kind: "js-required",
    reason: "JavaScript + cookies required (SPA shell)",
    match: (head) =>
      head.includes("enable javascript and cookies") ||
      head.includes("please enable cookies") ||
      head.includes("js is required") ||
      (head.length < 800 && head.includes("<noscript")) && head.includes("javascript"),
  },
  // LinkedIn: 999 status or /uas/login redirect
  {
    kind: "login-wall",
    reason: "LinkedIn login wall",
    match: (head, status) =>
      status === 999 ||
      head.includes("linkedin.com/uas/login") ||
      head.includes('href="https://www.linkedin.com/login') ||
      (head.includes("Sign in to LinkedIn") && head.length < 20000),
  },
  // Instagram / Facebook login walls
  {
    kind: "login-wall",
    reason: "Instagram / Facebook login wall",
    match: (head) =>
    (head.includes("instagram.com") || head.includes("facebook.com")) &&
      (head.includes("log in") || head.includes("login") || head.includes("password")) &&
      head.includes("auth_session") ||
      head.includes("Please log in to continue"),
  },
  // Amazon robot check
  {
    kind: "amazon-robot",
    reason: "Amazon robot / captcha check",
    match: (head) =>
    head.includes("validateCaptcha") ||
      head.includes("Enter the characters you see") ||
      head.includes("Type the characters") && head.includes("captcha"),
  },
];

/* ── text-based (post-extraction) detectors ────────────────────────────── */

/**
 * These run against the EXTRACTED TEXT (after DOM parse) to catch silent
 * blocks that readability "cleaned up" but left the challenge wording in.
 * Kept small and cheap: a handful of regexes over the first 2000 chars.
 */
export function detectBlockInText(text: string): BlockVerdict {
  const head = text.slice(0, 2000);
  const lower = head.toLowerCase();

  // Silent Cloudflare "Just a moment" that survived readability
  if (lower.includes("just a moment")) {
    return verdict("cloudflare", "Cloudflare challenge text survived extraction");
  }
  // Login wall
  const loginWallPatterns: RegExp[] = [
    /sign in to (linkedin|facebook|instagram|twitter|x|youtube)/i,
    /log (in|sign in) to (continue|begin)/i,
    /please (log in|sign in|create an account) (to|and)/i,
    /your session has expired/i,
  ];
  for (const re of loginWallPatterns) {
    if (re.test(lower)) return verdict("login-wall", "Login wall text in extraction");
  }
  // CAPTCHA
  if (
    lower.includes("captcha") ||
    lower.includes("verify you are human") ||
    lower.includes("i'm not a robot")
  ) {
    return verdict("captcha", "CAPTCHA text in extraction");
  }
  // Empty JS shell
  const meaningful = text.replace(/\s+/g, " ").trim();
  if (meaningful.length < 100) {
    return verdict("js-required", "Extraction under 100 meaningful chars (JS shell)");
  }
  return { blocked: false, kind: null, reason: "" };
}

function verdict(kind: BlockKind, reason: string): BlockVerdict {
  return { blocked: true, kind, reason };
}

/* ── main entry point ─────────────────────────────────────────────────── */

/**
 * Classify a raw HTTP response for silent block signals. Called BEFORE
 * DOM extraction in the extractor — a hit short-circuits Tier 1.
 */
export function detectBlock(
  html: string,
  status: number,
  contentType: string,
): BlockVerdict {
  if (status === 999) {
    return verdict("login-wall", "HTTP 999 (LinkedIn-style auth redirect)");
  }
  const head = html.slice(0, 4000).toLowerCase();
  for (const sig of SIGNATURES) {
    if (sig.match(head, status, contentType)) {
      return { blocked: true, kind: sig.kind, reason: sig.reason };
    }
  }
  return { blocked: false, kind: null, reason: "" };
}
