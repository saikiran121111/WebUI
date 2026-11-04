/**
 * Low-RAM concurrent page reader — the extraction half of the pipeline.
 *
 * 7-tier anti-bot extraction per URL (Pass A got-scraping + Pass B
 * fingerprinted Playwright):
 *   Tier 0   — SQLite cache hit (instant)
 *   Tier 1   — direct got-scraping fetch (impit TLS fallback + fingerprint
 *              rotation inside net.ts) → in-file block gate →
 *              structural-mode DOM extraction (article / portfolio /
 *              docs / document) PLUS Pass A structured facts:
 *              schema-extract.ts (JSON-LD across all schema types incl.
 *              Product offers + Movie/TVSeries aggregateRating, Microdata,
 *              OpenGraph/Twitter) and hydration-unpacker.ts (__NEXT_DATA__,
 *              self.__next_f, __PRELOADED_STATE__, __myx,
 *              __INITIAL_STATE__, ytInitialData).
 *   Tier 1.5 — keyless platform API adapter (platform-api.ts: Reddit
 *              .json, GitHub raw/README, YouTube youtubei.js, Google Maps,
 *              OSM Nominatim) for known hard hosts.
 *   Tier 2   — Cloudflare/SPA / WAF fallback: free markdown reader at
 *              r.jina.ai.
 *   Tier 3   — Wayback Machine snapshot (archive.org CDX +
 *              availability API) for hard-blocked / dead / paywalled
 *              URLs.
 *   Tier 4   — snippet / title preservation: if everything fails, the
 *              metasearch snippet becomes the partial-evidence passage
 *              (never crashes).
 *
 * Every URL is classified into one of the report categories:
 *   SUCCESS_DIRECT, SUCCESS_ADAPTER, SUCCESS_METADATA,
 *   SUCCESS_JINA_FALLBACK, SUCCESS_WAYBACK, SUCCESS_SNIPPET_FALLBACK,
 *   SUCCESS_BROWSER, SUCCESS_REDIRECTED (fetch succeeded but landed on a
 *   different registrable site — packet URL/domain carry the final site),
 *   FAIL_SILENT_BOT_BLOCK, FAIL_SILENT_LOGIN_WALL,
 *   FAIL_EMPTY_JS_SHELL, FAIL_NETWORK_OR_CRASH
 *
 * The extractor NEVER passes a login-wall or CAPTCHA body into the
 * reranker: when detectBlock() fires, it short-circuits to Tier 2/3/4.
 */
import pLimit from "p-limit";
import {
  fetchPage,
  fetchUrl,
  fetchWithLinkPreviewBots,
  PDF_LIMIT_BYTES,
  type PageResponse,
} from "./net";
import type { RankedResult } from "./metasearch";
import { getCachedPage, putCachedPage } from "./cache";
import { schemaExtract, schemaExtractFromBlocks } from "./schema-extract";
import { platformAdapter } from "./platform-api";
import { unpackHydration } from "./hydration-unpacker";
import {
  structuralExtractAsync,
  detectMode,
  extractDocumentSync,
  extractPdfBytes,
} from "./universal-extractor";
import { normalizeBody, detectCharset } from "./charset-normalizer";
import { urlSearchFallback, slugTriangulation, triangulatedPassageProvenance } from "./metasearch";
import { registrableHost } from "../decision/task-scope";
import { extractPageInOnePass } from "./agentBrowser";
import {
  walkGenericJsonForEntities,
} from "./hydration-unpacker";
import type { EvidencePacket } from "./types";

// Per-tier timeouts (7-tier cascade):
//   Tier 1A/1B (direct + browser rotation): 45s each
//   Tier 2   (link-preview bots):           45s per bot, 4 bots
//   Tier 3   (platform JSON / llms.txt):    45s
//   Tier 4   (Jina):                        45s
//   Tier 5   (Wayback):                     45s
//   Tier 6   (slug triangulation):           uses metasearch (40s/engine)
//   PDF downloads:                          120s
// §25 RETUNE (2026-10-30, mirrored in ruke-websearch/src/extractor.rs):
// live tier-latency profile p50 ~1.4 s, off-straggler max 6.1 s — caps move
// to ~3–4x the observed max so a dead tier fails FAST into the next tier
// instead of parking a wave (one wayback straggler burned 18.5 s at the
// old cap). Link-preview keeps 45 s: per-bot short fan-outs, dominated by
// the per-page budget below anyway.
const TIER1_TIMEOUT_MS = 20_000;
const LINK_PREVIEW_TIMEOUT_MS = 45_000;
const JINA_TIMEOUT_MS = 15_000;
const WAYBACK_TIMEOUT_MS = 12_000;
const PDF_DOWNLOAD_TIMEOUT_MS = 120_000;

// APPROVED PART-10 PARITY DEVIATION (MIGRATION-MAP §11.3) — TOTAL per-page
// wall-clock budget in extractAll(). The tier timeouts above are PER
// REQUEST, not per PAGE: one dead host stacks tier1 + link-preview bots +
// Jina + Wayback (avail + CDX + snapshot) sequentially into minutes. Live
// evidence (2026-10-28): ONE of ten pages held Promise.all — and with it
// the whole evidence stream and the client's search-toggle UI — for 3m51s.
// The budget abandons the cascade at the cap and folds the page into the
// same snippet-baseline terminal packet extractUrl() produces when the
// cascade legitimately fails. Mirrored byte-for-behavior in
// ruke-websearch/src/extractor.rs (same default, same fallback shape,
// classification "PAGE_BUDGET_TIMEOUT" never emitted elsewhere).
// §25 RETUNE (2026-10-30): 60 s → 30 s. No page in the live profile needed
// more than ~7 s of cascade — the old default only ever sheltered stragglers.
const PAGE_BUDGET_DEFAULT_MS = 30_000;

// APPROVED PART-10 AMENDMENT (MIGRATION-MAP §11.3, 2026-10-29): the budget
// is now tier-boundary-COOPERATIVE instead of a hard cut. Every HTTP tier
// await inside extractUrl() is capped by the REMAINING budget, and the
// browser tier (stealth-Chromium pool — the epoch's generic bot-shield
// bypass: fingerprint rotation, challenge-page rendering, SPA hydration
// unpacking) is ALWAYS granted its bridge-bounded allowance even when the
// HTTP budget is gone. The original hard cut starved JS-heavy / bot-
// challenged sites (user-reported 2026-10-29 "can't access BookMyShow /
// HackerNews" regression): one dead site could still burn at most
// PAGE_BUDGET_DEFAULT_MS + this allowance — still a hard bound.
// Mirrored in ruke-websearch/src/extractor.rs (BROWSER_ALLOWANCE_MS).
const BROWSER_ALLOWANCE_MS = 46_000; // bridge timeout (45s) + headroom

// Concurrency for the DOM-extraction tier.
//
// Default is 4 (production pipeline only ever reads ≤10 URLs, so the extra
// slots only matter at corpus scale). The INSANE stress runner sets
// WEB_SEARCH_CONCURRENCY to match its own worker pool (e.g. 64) so that
// every worker can run the full 7-tier cascade in parallel — otherwise
// 58 of 64 workers would just queue behind the cap-4 / cap-6 global
// limiters and the i9-14900K's 32 threads would sit idle.
const EXTRACTION_CONCURRENCY = Math.max(
  4,
  parseInt(process.env.WEB_SEARCH_CONCURRENCY ?? "4", 10),
);
const limit = pLimit(EXTRACTION_CONCURRENCY);

// Jina rate limiter. Default 6 keeps the production pipeline under
// r.jina.ai's free-tier ~20 req/s cap. The insane stress runner raises it
// to match EXTRACTION_CONCURRENCY so all workers can use Jina in parallel
// (the stress run's goal is maximum throughput on a local workstation,
// not production-rate-limit safety).
const JINA_CONCURRENCY = Math.max(
  6,
  parseInt(process.env.WEB_SEARCH_JINA_CONCURRENCY ?? "6", 10),
);
const jinaLimit = pLimit(JINA_CONCURRENCY);

/* ── Block gate (inlined; replaces the retired block-detector.ts) ────────
 *
 * Runs on the RAW HTML before DOM parsing so a WAF/challenge page is
 * never fed to the structural extractor or the BM25 reranker, and on the
 * EXTRACTED text afterwards to catch "silent" blocks (200 OK + challenge
 * body) that survived the DOM pass.
 *
 * The reason strings are load-bearing: the classification tail of
 * extractUrl() regex-matches them — /login|sign in|auth/i routes to
 * FAIL_SILENT_LOGIN_WALL (surfaced by the pipeline as web:auth_required
 * so the user can sign in through the in-app browser panel) and
 * /cloudflare|akamai|perimeterx|datadome|captcha|bot|js/i routes to
 * FAIL_SILENT_BOT_BLOCK. Do not casually reword these strings.
 */

interface BlockVerdict {
  blocked: boolean;
  reason: string;
}

// Order matters: the first matching signature wins. Each entry is a
// substring check against the first 4 KB of body, lower-cased
// (challenge pages front-load the signal).
const BLOCK_SIGNATURES: {
  match: (head: string, status: number) => boolean;
  reason: string;
}[] = [
  // Cloudflare Turnstile / challenge
  {
    reason: "Cloudflare challenge / Turnstile",
    match: (head, status) =>
      head.includes("cf-chl") ||
      head.includes("challenge-platform") ||
      head.includes("cf-turnstile") ||
      head.includes("__cf_chl") ||
      // (audit 2026-11-04) `head` is lower-cased by detectBlock — the old
      // capitalized literals could never match ("Just a moment" vs "just a
      // moment"): a dead signature on Cloudflare's most common wall string.
      head.includes("just a moment") ||
      head.includes("checking your browser") ||
      (status === 503 && head.includes("cf-ray")),
  },
  // Akamai Bot Manager
  {
    reason: "Akamai Bot Manager block",
    match: (head) =>
      (head.includes("akamai") &&
        (head.includes("bot") || head.includes("dm_oo") || head.includes("akb"))) ||
      (head.includes("please enable cookies") && head.includes("akamai")),
  },
  // PerimeterX / HUMAN
  {
    reason: "PerimeterX / HUMAN bot challenge",
    match: (head) =>
      head.includes("_pxhd") ||
      head.includes("_px2") ||
      head.includes("perimeterx") ||
      head.includes("px-captcha"),
  },
  // DataDome
  {
    reason: "DataDome bot challenge",
    match: (head) =>
      head.includes("_ddg") ||
      head.includes("datadome") ||
      (head.includes("dd-") && head.includes("captcha")),
  },
  // Generic CAPTCHA (reCAPTCHA, hCaptcha, Arkose/FunCaptcha)
  {
    reason: "CAPTCHA challenge",
    match: (head) =>
      head.includes("g-recaptcha") ||
      head.includes("hcaptcha") ||
      head.includes("funcaptcha") ||
      head.includes("arkoselabs") ||
      head.includes("please verify you are not a robot") ||
      head.includes("i'm not a robot"),
  },
  // "Enable JavaScript and cookies to continue"
  {
    reason: "JavaScript + cookies required (SPA shell)",
    match: (head) =>
      head.includes("enable javascript and cookies") ||
      head.includes("please enable cookies") ||
      head.includes("js is required") ||
      (head.length < 800 && head.includes("<noscript") && head.includes("javascript")),
  },
  // LinkedIn: 999 status or /uas/login redirect
  {
    reason: "LinkedIn login wall",
    match: (head, status) =>
      status === 999 ||
      head.includes("linkedin.com/uas/login") ||
      head.includes('href="https://www.linkedin.com/login') ||
      (head.includes("Sign in to LinkedIn") && head.length < 20000),
  },
  // Instagram / Facebook login walls
  {
    reason: "Instagram / Facebook login wall",
    match: (head) =>
      ((head.includes("instagram.com") || head.includes("facebook.com")) &&
        (head.includes("log in") || head.includes("login") || head.includes("password")) &&
        head.includes("auth_session")) ||
      head.includes("please log in to continue"),
  },
  // Amazon robot check
  {
    reason: "Amazon robot / captcha check",
    match: (head) =>
      head.includes("validatecaptcha") ||
      head.includes("enter the characters you see") ||
      (head.includes("type the characters") && head.includes("captcha")),
  },
  // AWS WAF challenge (Zepto, Zeptonow, and other AWS-WAF-protected Indian sites)
  // The challenge page is delivered with HTTP 202 and contains "awsWaf"
  // global + a challenge.js script from *.awswaf.com.
  {
    reason: "AWS WAF bot challenge",
    match: (head, status) =>
      head.includes("awswaf") ||
      head.includes("aws-waf") ||
      head.includes("challenge.js") ||
      (status === 202 && head.includes("challenge")),
  },
];

/**
 * Classify a raw HTTP response for silent block signals. Called BEFORE
 * DOM extraction — a hit short-circuits Tier 1.
 */
function detectBlock(
  html: string,
  status: number,
  _contentType: string,
): BlockVerdict {
  if (status === 999) {
    return { blocked: true, reason: "HTTP 999 (LinkedIn-style auth redirect)" };
  }
  const head = html.slice(0, 4000).toLowerCase();
  for (const sig of BLOCK_SIGNATURES) {
    if (sig.match(head, status)) return { blocked: true, reason: sig.reason };
  }
  return { blocked: false, reason: "" };
}

/**
 * Post-extraction text gate — catches silent blocks that the DOM pass
 * "cleaned up" but left the challenge wording in. Kept small and cheap:
 * a handful of regexes over the first 2000 chars.
 * (brief §11) exported for direct regression vectors.
 */
export function detectBlockInText(text: string): BlockVerdict {
  const lower = text.slice(0, 2000).toLowerCase();
  const signal = text.replace(/\s+/g, " ").trim();

  // Silent Cloudflare "Just a moment" that survived the DOM pass.
  // (audit 2026-11-04) head-window only: residue sits at the very start of
  // recovered text; the old 2 KB scan flagged legitimate articles that
  // merely mention the phrase mid-prose.
  if (lower.slice(0, 300).includes("just a moment") || lower.slice(0, 300).includes("checking your browser")) {
    return { blocked: true, reason: "Cloudflare challenge text survived extraction" };
  }
  // Login wall
  const loginWallPatterns: RegExp[] = [
    /sign in to (linkedin|facebook|instagram|twitter|x|youtube)/i,
    /log (in|sign in) to (continue|begin)/i,
    /please (log in|sign in|create an account) (to|and)/i,
    /your session has expired/i,
  ];
  for (const re of loginWallPatterns) {
    if (re.test(lower)) return { blocked: true, reason: "Login wall text in extraction" };
  }
  // CAPTCHA — (brief §11) even the head-window keyword alone was still a
  // false wall: security explainers, help docs and bot-gate NEWS open
  // with the word all the time. A SURVIVED challenge is structural: the
  // challenge copy IS the whole body (thin extraction) or the head pairs
  // the keyword with a second distinctive challenge phrase. Quoted wall
  // strings ("verify you are human", "I'm not a robot") stay page-wide —
  // they never appear in editorial content. HTTP-200 silent challenges
  // stay rejected: every real challenge page is thin or co-locates a
  // challenge token beside the keyword.
  const head300 = lower.slice(0, 300);
  const thin = signal.length < 400;
  if (
    (head300.includes("captcha") &&
      (thin || CHALLENGE_HEAD_TOKENS.some((t) => head300.includes(t)))) ||
    lower.includes("verify you are human") ||
    lower.includes("i'm not a robot")
  ) {
    return { blocked: true, reason: "CAPTCHA text in extraction" };
  }
  // Empty JS shell
  if (signal.length < 100) {
    return { blocked: true, reason: "Extraction under 100 meaningful chars (JS shell)" };
  }
  return { blocked: false, reason: "" };
}

// Distinctive challenge-page phrases only — no generic English ("bot",
// "security check", "challenge") that editorial prose legitimately uses.
const CHALLENGE_HEAD_TOKENS = [
  "unusual traffic",
  "access denied",
  "access restricted",
  "temporarily blocked",
  "blocked your access",
];

/**
 * Strip residual WAF challenge / CAPTCHA / "checking your browser"
 * wording from recovered text so triangulated snippets never leak
 * challenge boilerplate into the BM25 index. Final line of defense
 * before a link-preview / triangulation result is handed to the reranker.
 */
const WAF_BOILERPLATE_RE = new RegExp(
  [
    "checking your browser",
    "just a moment",
    "please enable javascript and cookies",
    "verify you are human",
    "i'm not a robot",
    "are you a robot",
    "enable cookies to continue",
    "cf-chl",
    "cf-turnstile",
    "turnstile",
    "please wait",
    "verifying connection",
    "access to this page has been limited",
    "you are being redirected",
  ].join("|"),
  "gi",
);

function stripWafChallengeText(text: string): string {
  if (!text) return "";
  // Cut out each boilerplate phrase and its surrounding ~80-char window
  let cleaned = text;
  for (const m of text.matchAll(WAF_BOILERPLATE_RE)) {
    const start = Math.max(0, (m.index ?? 0) - 80);
    const end = Math.min(text.length, (m.index ?? 0) + m[0].length + 80);
    cleaned = cleaned.slice(0, start) + " " + cleaned.slice(end);
  }
  return cleaned.replace(/\s{3,}/g, "  ").trim();
}

/** True when the text (after stripping) still has meaningful content. */
function hasMeaningfulContent(text: string, minChars = 100): boolean {
  return text.replace(/\s+/g, " ").trim().length >= minChars;
}

/* ── Extraction tier results (internal) ───────────────────────────────── */

type Tier =
  | "direct"
  | "adapter"
  | "browser"
  | "metadata"
  | "jina"
  | "wayback"
  | "snippet"
  | "crash";

interface TierOutput {
  tier: Tier;
  markdown: string;
  status: number;
  /** Block detector verdict (kind=null when not blocked). */
  blocked: boolean;
  blockedReason: string;
  /**
   * Final URL after engine-followed redirects, ONLY when it differs from
   * the requested URL (audit item 8, 2026-11-04: provenance must ride
   * with the body — net.ts already reports it on every multi-pass path).
   */
  resolvedUrl?: string;
  /** Which structural mode was used (for the stress-test report). */
  mode?: string;
  /** Number of markdown tables preserved (portfolio / SaaS signal). */
  tableCount?: number;
  /** Number of <pre><code> blocks preserved (docs signal). */
  codeBlockCount?: number;
}

/**
 * Tier 1 (Pass A): direct got-scraping fetch + block gate + structural-
 * mode DOM extraction + schema-extract / hydration facts.
 *
 * Fingerprint rotation and the impit TLS fallback on 403/429/503 are
 * handled INSIDE fetchPage (net.ts). The caller no longer re-fires Tier 1 with a second
 * fingerprint — that was the double-fetch that kept Jina from ever
 * seeing the clean HTML response on hosts like news.ycombinator.com
 * (a fingerprint the direct fetch had already recovered under).
 *
 * Returns a TierOutput on every path (never null) so the caller can
 * inspect the block verdict, mode, and table/code counts.
 */
async function extractDirect(
  url: string,
  fp: "chrome" | "firefox" | "edge" = "chrome",
): Promise<TierOutput> {
  const page: PageResponse | null = await fetchPage(url, {
    timeoutMs: TIER1_TIMEOUT_MS,
    fingerprint: fp,
  });
  if (!page) {
    return {
      tier: "crash",
      markdown: "",
      status: 0,
      blocked: true,
      blockedReason: "network error / timeout",
    };
  }

  // Normalize the body's charset before anything else — this is what
  // keeps Shift_JIS / GB18030 / EUC-KR / Windows-1252 pages readable
  // instead of garbled.
  // (audit 2026-11-04) The old code RE-ENCODED the already-decoded string
  // (TextEncoder) — for a Pass-B page the UTF-8 decode had already eaten
  // every non-UTF-8 byte (U+FFFD), so detectCharset sniffed a corpse and
  // normalizeBody re-mangled correct Pass-A text. net.ts now hands over
  // the TRUE decompressed bytes (rawBytes); detection + re-decode run on
  // them, and the re-encode fallback survives only on the string-only
  // wreq pass.
  const bytes = page.rawBytes ?? new TextEncoder().encode(page.body);
  const charset = detectCharset(page.contentType, bytes);
  const html =
    charset === "utf-8" ? page.body : normalizeBody(bytes, page.contentType);

  if (!page.ok || page.body.length < 200) {
    // (audit 2026-11-04) HTTP status carries access-control semantics the
    // old blanket blocked:false threw away: a 401 that survived the
    // cascade reported SUCCESS_SNIPPET_FALLBACK (a SUCCESS label) instead
    // of an auth-required failure, and 401 skipped the browser-rescue
    // gate entirely. Auth statuses → login-wall kind; WAF statuses →
    // bot-block kind; plain 404/5xx stay unblocked misses.
    const authStatus = page.status === 401 || page.status === 407;
    const wafStatus =
      page.status === 403 || page.status === 405 ||
      page.status === 429 || page.status === 202;
    return {
      tier: "crash",
      markdown: "",
      status: page.status,
      blocked: authStatus || wafStatus,
      blockedReason: authStatus
        ? "HTTP " + page.status + " authorization required"
        : "HTTP " + page.status +
          (wafStatus ? " (WAF/bot status)" : " (non-200 or empty body)"),
    };
  }

  // Non-HTML response: hand it to the structural extractor's document
  // mode (CSV/JSON/Markdown sync; PDF via unpdf).
  // (audit 2026-11-04) PDFs used to hit the sync placeholder and return
  // the literal string "(PDF requires structuralExtractAsync)" AS
  // EVIDENCE (≥100 chars — it sailed the gate and reached the model).
  // This function is async, so run the real unpdf pass HERE, on the true
  // retained bytes (gov PDFs are the classic broken-cert + PDF combo, so
  // the tlsTolerantGet path also carries rawBytes).
  if (!/text\/html|application\/xhtml/i.test(page.contentType)) {
    if (
      /application\/pdf/i.test(page.contentType) ||
      (page.rawBytes !== undefined && /\.pdf(\?|#|$)/i.test(url))
    ) {
      const pdfMd = await extractPdfBytes(
        page.rawBytes ?? new TextEncoder().encode(page.body),
      );
      if (!pdfMd.startsWith("(PDF text extraction failed")) {
        return {
          tier: "metadata",
          markdown: pdfMd,
          status: page.status,
          blocked: false,
          blockedReason: "",
          mode: "document",
          ...(page.resolvedUrl && page.resolvedUrl !== url
            ? { resolvedUrl: page.resolvedUrl }
            : {}),
        };
      }
      return {
        tier: "crash",
        markdown: "",
        status: page.status,
        blocked: false,
        blockedReason: "PDF text extraction failed (unpdf could not parse)",
      };
    }
    const md = extractDocumentSync(page.body, page.contentType, url);
    if (md.length >= 100) {
      return {
        tier: "metadata",
        markdown: md,
        status: page.status,
        blocked: false,
        blockedReason: "",
        mode: "document",
        ...(page.resolvedUrl && page.resolvedUrl !== url
          ? { resolvedUrl: page.resolvedUrl }
          : {}),
      };
    }
    return {
      tier: "crash",
      markdown: "",
      status: page.status,
      blocked: false,
      blockedReason: "non-HTML response under 100 chars",
    };
  }

  // Block gate BEFORE DOM parsing — a challenge page should never reach
  // the extractor (it would extract "Checking your browser" as content).
  const block = detectBlock(page.body, page.status, page.contentType);
  if (block.blocked) {
    return {
      tier: "crash",
      markdown: "",
      status: page.status,
      blocked: true,
      blockedReason: block.reason,
    };
  }

  // DOM extraction: pick the right structural mode automatically.
  const det = detectMode(page.body, page.contentType, url);
  let md: string;
  let tableCount = 0;
  let codeBlockCount = 0;
  {
    const structOut = await structuralExtractAsync(
      page.body,
      page.contentType,
      url,
    );
    md = structOut.markdown;
    tableCount = structOut.tableCount;
    codeBlockCount = structOut.codeBlockCount;
    // The structural sync path can return "" when turndown + linkedom
    // both choke on a page's DOM shape. Fall back to plain-text
    // extraction so the URL still yields content (and never silently
    // drops to Jina for a page that actually had text in it).
    if (md.length < 100) {
      const fallback = page.body
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (fallback.length >= 100) {
        md = "## Page text (raw extraction)\n" + fallback.slice(0, 12000);
      }
    }
  }

  // Pass A structured facts + SSR hydration unpacking.
  // ONLY fires when the structural DOM extraction came up thin — for a
  // page that already produced enough text, re-parsing the same body
  // through the schema/hydration channels is pure waste (this is what
  // was blowing the cold-cache budget on plain HTML pages).
  //
  // Two cheap signals: the ORIGINAL HTML body's plain-text length (before
  // any extraction) and the structural extractor's markdown output.
  // If the body itself has <1500 chars of visible text, it's a JS shell
  // or a structured-data-heavy page → run the schema/hydration channels.
  // Otherwise, skip them (the DOM already gave us real content).
  const bodyPlainLen = page.body.replace(/<[^>]+>/g, " ").trim().length;
  const domThin =
    det.mode === "document" ||
    bodyPlainLen < 1500 ||
    md.length < 800;
  if (domThin) {
    // Pure-HTML channels only (no network): Pass A schema facts +
    // hydration unpacking. These parse the same body the DOM pass
    // already paid for.
    const schemaMd = schemaExtract(page.body);
    const hydrationMd = unpackHydration(page.body);
    if (schemaMd || hydrationMd) {
      md = [schemaMd, hydrationMd, md].filter(Boolean).join("\n\n");
    }
  }

  // Text-level block check (silent blocks that survived readability)
  const textBlock = detectBlockInText(md);
  if (textBlock.blocked) {
    return {
      tier: "crash",
      markdown: "",
      status: page.status,
      blocked: true,
      blockedReason: textBlock.reason,
    };
  }

  if (md.length < 100) {
    return {
      tier: "crash",
      markdown: "",
      status: page.status,
      blocked: false,
      blockedReason: "empty JS shell (under 100 meaningful chars)",
      mode: det.mode,
      tableCount,
      codeBlockCount,
    };
  }
  return {
    tier: "direct",
    markdown: md,
    status: page.status,
    blocked: false,
    blockedReason: "",
    ...(page.resolvedUrl && page.resolvedUrl !== url
      ? { resolvedUrl: page.resolvedUrl }
      : {}),
    mode: det.mode,
    tableCount,
    codeBlockCount,
  };
}

/** Tier 1.5: keyless platform API adapter (JSON rewrite; platform-api.ts). */
async function extractAdapter(url: string): Promise<TierOutput | null> {
  const result = await platformAdapter(url);
  if (!result) return null;
  return {
    tier: "adapter",
    markdown: result.markdown,
    status: 200,
    blocked: false,
    blockedReason: "",
  };
}

/**
 * Universal SERP-snippet baseline — guaranteed to survive every stage.
 * The search engine's own index (title + rich snippet) is always a valid
 * evidence passage even when every direct extraction tier fails. This is
 * what keeps the pipeline from ever returning 0 passages for a blocked
 * Myntra / Zomato / BookMyShow page.
 */
function serpBaselinePassage(result: RankedResult): EvidencePacket["passages"][number] | null {
  const snippet = (result.snippet || result.title || "").trim();
  if (snippet.length < 12) return null;
  return {
    sourceId: "",
    // §6: the SERP entry cites the URL exactly as the engine surfaced it.
    url: result.url || result.canonical,
    title: result.title,
    domain: result.domain,
    publishedAt: result.publishedDate,
    // (audit 2026-11-04) The old header predicted failure ("the page
    // itself was blocked or empty") even though this passage is pushed
    // BEFORE the tier cascade runs — in a SUCCESS_DIRECT packet it was a
    // false claim sitting next to the real extraction. The provenance
    // statement below is true whatever the cascade later decides: this
    // text is the engine's index entry, never the page's retrieved body.
    passageText:
      "[Search-engine index entry — title + snippet as the search engine " +
      "indexed them. Snippet-level evidence about the page, not the page's " +
      "own retrieved content; verify against the retrieved passages from " +
      "this URL before quoting specifics.]\n" +
      snippet.slice(0, 2000),
    bm25Score: 0,
  };
}

/**
 * Cross-site landing check (audit item 8, 2026-11-04): did the fetch
 * engine end up serving content from a DIFFERENT registrable site than
 * the requested URL? (A shop URL bouncing to an affiliate/ad landing, a
 * regional mirror, a country redirect to a different site.) registrableHost
 * is public-suffix aware (tldts) — co.in / com.au second levels compare
 * correctly — and same-site hops (http→https, apex→www) never fire it.
 */
function crossedRegistrableBoundary(requested: string, resolved?: string): boolean {
  if (!resolved) return false;
  const a = registrableHost(requested);
  const b = registrableHost(resolved);
  return !!a && !!b && a !== b;
}

/** Passage header naming the site that actually served redirect-landed text. */
function redirectedProvenanceHeader(requested: string, resolved: string): string {
  return (
    "[Redirect provenance: " + requested + " now resolves to " + resolved +
    ". The text below was served by that final site, not the originally " +
    "requested URL — cite it as " + resolved + ".]\n"
  );
}

/**
 * Bundle-level SERP-baseline guarantee: results OUTSIDE the extractor's
 * read window (rank 11+) still contribute their engine-indexed title +
 * snippet as a snippet-only packet, so a blocked site's facts (a LinkedIn
 * profile's headline, a 999-walled page's indexed description) can never
 * be lost just because we chose not to fetch that URL. The pipeline
 * merges these after extractAll(); extractUrl() already carries the same
 * baseline inside every packet it returns.
 *
 * §6 note: `extractedUrls` carries CANONICAL keys (packet.url is the raw
 * fetched URL since §6 — the pipeline maps it through normalizeUrl); the
 * skip check below compares against `r.canonical`.
 */
export function baselinePacketsFor(
  ranked: RankedResult[],
  extractedUrls: Set<string>,
  max = 10,
): (EvidencePacket & { classification: string })[] {
  const out: (EvidencePacket & { classification: string })[] = [];
  for (const r of ranked) {
    if (out.length >= max) break;
    if (extractedUrls.has(r.canonical)) continue;
    const baseline = serpBaselinePassage(r);
    if (!baseline) continue;
    out.push({
      sourceId: "",
      url: r.url || r.canonical, // §6: raw engine URL (fetch/citation truth)
      title: r.title,
      domain: r.domain,
      publishedAt: r.publishedDate,
      extraction: "snippet-only",
      passages: [baseline],
      classification: "SUCCESS_SNIPPET_FALLBACK",
    });
  }
  return out;
}

/**
 * §11.3: the packet extractAll() yields when a page's tier cascade is
 * abandoned at the total page budget. Shape mirrors the terminal-failure
 * fallback extractUrl() already returns (baseline first; title/marker only
 * when no baseline exists) — the only new artifact is the
 * "PAGE_BUDGET_TIMEOUT" classification. (The ruke-websearch crate mirror
 * was retired 2026-11-03 — this TS shape is the only one.)
 */
export function timeoutFallbackPacket(
  result: RankedResult,
): EvidencePacket & { classification: string } {
  const packet: EvidencePacket = {
    sourceId: "",
    url: result.url || result.canonical, // §6: fetch/citation truth
    title: result.title,
    domain: result.domain,
    publishedAt: result.publishedDate,
    extraction: "snippet-only",
    passages: [],
  };
  const baseline = serpBaselinePassage(result);
  if (baseline) {
    packet.passages.push(baseline);
  } else {
    packet.passages.push({
      sourceId: "",
      url: result.url || result.canonical,
      title: result.title,
      domain: result.domain,
      publishedAt: result.publishedDate,
      passageText:
        result.title || "(page read timed out — no content extracted)",
      bm25Score: 0,
    });
  }
  return { ...packet, classification: "PAGE_BUDGET_TIMEOUT" };
}

/**
 * Browser-tier extraction — real Playwright Chromium (lib/web-search/agentBrowser.ts).
 * Runs when Stage A (fast HTTP) was blocked/empty and the page is a known
 * WAF-heavy SPA or JS shell. The browser executes the full SPA bundle, so
 * Myntra / Zomato / BookMyShow / Blinkit hydration payloads that never
 * reach a raw fetch are recovered here.
 */
async function extractBrowser(
  result: RankedResult,
): Promise<{ markdown: string; status: number | null; blocked: boolean; blockedReason: string; finalUrl?: string } | null> {
  // §6: navigate the RAW engine URL (fetch truth); canonical stays comparison-only.
  const fetchUrl = result.url || result.canonical;
  try {
    const r = await extractPageInOnePass(fetchUrl, { timeoutMs: 45_000 });
    if (!r.ok) {
      return {
        markdown: "",
        status: r.status ?? 0,
        blocked: r.status === 403 || r.status === 429 || r.status === 503,
        blockedReason: r.error ?? "browser extraction failed",
      };
    }
    const parts: string[] = [];

    // 1. Live-rendered DOM body text (the primary payload — this is what
    //    a raw HTTP fetch can never produce for a JS-only SPA).
    if (r.bodyText.length >= 100) {
      parts.push("## Rendered page body (Playwright stealth Chromium)\n" + r.bodyText.slice(0, 12_000));
    }

    // 2. Final URL after JS/HTTP redirects — the real target of the SERP.
    // §6: compared against the URL we ACTUALLY navigated, not the key.
    if (r.finalUrl && r.finalUrl !== fetchUrl) {
      parts.push("Final URL after redirects: " + r.finalUrl);
    }

    // 3. Title
    if (r.title) parts.push("# " + r.title);

    // 4. JSON-LD (same formatter as the Pass A HTML path)
    if (r.jsonLd.length > 0) {
      const schemaMd = schemaExtractFromBlocks(r.jsonLd).join("\n\n");
      if (schemaMd) parts.push("[Structured Page Facts]\n\n" + schemaMd);
    }

    // 5. OpenGraph / Twitter meta
    if (Object.keys(r.meta).length > 0) {
      const lines = Object.entries(r.meta)
        .filter(([k]) => /^(og:|twitter:)/.test(k) || k === "description")
        .map(([k, v]) => "- " + k + ": " + String(v).slice(0, 300));
      if (lines.length > 0) parts.push("## Page Metadata (browser)\n" + lines.join("\n"));
    }

    // 6. Universal window global hydration state — run the generic JSON
    //    entity walker (Part 4, 100% schema-agnostic) so a Myntra
    //    product catalog, Zomato menu, or BookMyShow event listing buried
    //    in `window.__PRELOADED_STATE__` etc. is unpacked without any
    //    per-site hardcoding.
    for (const [key, raw] of Object.entries(r.windowState)) {
      try {
        const parsed = JSON.parse(raw);
        const cards = walkGenericJsonForEntities(parsed, { maxCards: 60, label: key });
        if (cards) parts.push("## Hydration state (" + key + ")\n" + cards);
      } catch {
        /* not valid JSON under this key — skip */
      }
    }

    // 7. ARIA semantic snapshot — the accessibility-tree view of the
    //    rendered page. This is what pierces Shadow DOM, React portals,
    //    and cross-origin iframes that `document.body.innerText` on the
    //    main document misses. Capped so one hostile page can't blow
    //    out the reranker's context budget.
    if (r.ariaSnapshot && r.ariaSnapshot.length >= 100) {
      parts.push("## ARIA snapshot (accessibility tree)\n" + r.ariaSnapshot.slice(0, 8_000));
    }

    const markdown = parts.filter(Boolean).join("\n\n");
    if (markdown.length < 60) {
      return { markdown, status: r.status, blocked: false, blockedReason: "browser returned little content" };
    }
    return { markdown, status: r.status ?? 200, blocked: false, blockedReason: "", finalUrl: r.finalUrl };
  } catch (e: any) {
    return {
      markdown: "",
      status: 0,
      blocked: false,
      blockedReason: "browser pool error: " + (e?.message ?? String(e)),
    };
  }
}

/**
 * Tier 2: social link-preview crawler bypass (WhatsApp / Facebook /
 * Twitter / Slack UAs). Hostile WAFs whitelist these bots, so a blocked
 * URL that 403'd under browser TLS often returns a clean 200 under a
 * link-preview UA.
 *
 * The response body is a real HTML page — we extract OpenGraph / Twitter
 * / JSON-LD / hydration / body text from it before handing to the cascade.
 */
async function extractLinkPreview(
  url: string,
): Promise<TierOutput | null> {
  const page: (PageResponse & { botName: string }) | null =
    await fetchWithLinkPreviewBots(url, {
      timeoutMs: LINK_PREVIEW_TIMEOUT_MS,
    });
  if (!page || !page.ok || page.body.length < 200) return null;

  // Block gate on the bot-fetched body — a WAF can still return a
  // challenge page as a 200 to a whitelisted bot.
  const block = detectBlock(page.body, page.status, page.contentType);
  if (block.blocked) return null;

  // Extract structured metadata + DOM text from the bot-fetched body.
  const schemaMd = schemaExtract(page.body);
  const hydrationMd = unpackHydration(page.body);
  const structOut = await structuralExtractAsync(
    page.body,
    page.contentType,
    url,
  );
  let md = structOut.markdown;
  // Raw-text fallback if the DOM pass produced little
  if (md.length < 100) {
    const fallback = page.body
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (fallback.length >= 100) {
      md = "## Page text (raw extraction, link-preview bot " + page.botName + ")\n" + fallback;
    }
  }
  // Prepend structured facts so specs / prices / OG metadata survive
  const parts = [schemaMd, hydrationMd, md].filter(Boolean);
  const combined = parts.length > 0 ? parts.join("\n\n") : "";

  // Strip residual WAF boilerplate from the bot response (defense in
  // depth — some WAFs serve a challenge page with a 200 status to
  // whitelisted bots that they didn't fully recognize).
  const cleaned = stripWafChallengeText(combined);
  if (!hasMeaningfulContent(cleaned)) return null;

  return {
    tier: "direct",
    markdown:
      "## Link-preview bot response (" + page.botName + ")\n" + cleaned,
    status: page.status,
    blocked: false,
    blockedReason: "",
    ...(page.resolvedUrl && page.resolvedUrl !== url
      ? { resolvedUrl: page.resolvedUrl }
      : {}),
    mode: structOut.mode,
    tableCount: structOut.tableCount,
    codeBlockCount: structOut.codeBlockCount,
  };
}
async function extractJina(url: string): Promise<TierOutput | null> {
  return jinaLimit(async () => {
    const jinaUrl = "https://r.jina.ai/" + encodeURI(url);
    const page = await fetchPage(jinaUrl, {
      timeoutMs: JINA_TIMEOUT_MS,
      headers: { "user-agent": "Mozilla/5.0" },
    });
    if (!page || !page.ok) return null;
    const body = page.body.trim();
    const block = detectBlockInText(body);
    if (block.blocked) {
      // Jina returned a challenge page — treat as a failed tier.
      return null;
    }
    return body.length >= 200
      ? {
          tier: "jina",
          markdown: body,
          status: page.status,
          blocked: false,
          blockedReason: "",
        }
      : null;
  });
}

/**
 * Tier 3: Wayback Machine snapshot — archive.org's availability API +
 * CDX server. Used for hard-blocked / dead / paywalled URLs where no
 * other tier worked.
 */
async function extractWayback(url: string): Promise<TierOutput | null> {
  // 1. Availability API — returns the closest snapshot
  const availRes = await fetchUrl(
    "https://archive.org/wayback/available?url=" +
      encodeURIComponent(url),
    { timeoutMs: WAYBACK_TIMEOUT_MS },
  );
  let snapshotUrl: string | null = null;
  let snapshotTs = ""; // (audit 2026-11-04) snapshots must SELF-DECLARE their age
  if (availRes && availRes.ok) {
    try {
      const data: any = JSON.parse(availRes.text);
      const snap = data?.archived_snapshots?.closest?.url;
      if (snap) {
        snapshotUrl = snap;
        snapshotTs = String(data?.archived_snapshots?.closest?.timestamp ?? "");
      }
    } catch {
      /* malformed */
    }
  }
  // 2. CDX fallback — the closest snapshot by timestamp
  if (!snapshotUrl) {
    const cdxRes = await fetchUrl(
      "https://web.archive.org/cdx/search/cdx?url=" +
        encodeURIComponent(url) +
        "&limit=1&output=json&fl=original,timestamp,statuscode&from=2020",
      { timeoutMs: WAYBACK_TIMEOUT_MS },
    );
    if (cdxRes && cdxRes.ok) {
      try {
        const rows: any[] = JSON.parse(cdxRes.text);
        const row = rows.find((r) => r?.[2]?.startsWith("200"));
        if (row?.[0] && row?.[1]) {
          snapshotUrl = "https://web.archive.org/web/" + row[1] + "/" + row[0];
          snapshotTs = String(row[1]);
        }
      } catch {
        /* malformed */
      }
    }
  }
  if (!snapshotUrl) return null;

  // 3. Fetch the snapshot HTML and extract it
  const page = await fetchPage(snapshotUrl, { timeoutMs: WAYBACK_TIMEOUT_MS });
  if (!page || !page.ok || page.body.length < 200) return null;
  const block = detectBlockInText(page.body);
  if (block.blocked) return null;
  const structOut = await structuralExtractAsync(page.body, page.contentType, snapshotUrl);
  const md = structOut.markdown;
  if (md.length < 100) return null;
  const tsNote = /^\d{8}/.test(snapshotTs)
    ? `captured ${snapshotTs.slice(0, 4)}-${snapshotTs.slice(4, 6)}-${snapshotTs.slice(6, 8)} — HISTORIC content, verify against live sources before quoting as current`
    : "capture date unknown — HISTORIC content, verify against live sources before quoting as current";
  return {
    tier: "wayback",
    markdown: `## Wayback Machine snapshot of ${url} (${tsNote})\n` + md,
    status: page.status,
    blocked: false,
    blockedReason: "",
    mode: structOut.mode,
    tableCount: structOut.tableCount,
    codeBlockCount: structOut.codeBlockCount,
  };
}

/* ── Public entry points ─────────────────────────────────────────────── */

/**
 * Fetch + extract one URL through every tier in order, with fingerprint
 * rotation on 403/429/503 and a per-host block short-circuit.
 *
 * Never throws: returns a snippet-only packet on total failure so the
 * pipeline still has SOMETHING for the BM25 reranker.
 */
/**
 * §11.3 AMENDMENT (2026-10-29): cap one tier-await by the remaining page
 * budget. The DEADLINE_EXPIRED sentinel mirrors Rust's Err(()) from
 * `capped` in ruke-websearch: the caller substitutes that tier's failure
 * shape and marks budgetHit so the classification tail can report
 * PAGE_BUDGET_TIMEOUT. With no deadline the promise runs untouched
 * (byte-parity for golden replays and uncapped direct calls). The tier's
 * own per-request timeout keeps bounding the orphaned promise.
 */
const DEADLINE_EXPIRED = Symbol("deadline-expired");
async function withDeadline<T>(
  deadline: number | undefined,
  fut: Promise<T>,
): Promise<T | typeof DEADLINE_EXPIRED> {
  if (deadline === undefined) return fut;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fut,
      new Promise<typeof DEADLINE_EXPIRED>((resolve) => {
        timer = setTimeout(
          () => resolve(DEADLINE_EXPIRED),
          Math.max(0, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Short-lived per-domain extraction health (§17/§29) + browser-tier
// selectivity (§18) — mirrors the Rust store in ruke-websearch extractor.
// Pure bookkeeping over the EXISTING cascade; adds no new browser
// capability and no new tier. A read that ends fully bot-blocked cools
// its domain down; the next read then skips only the ATTEMPT at the
// already-implemented browser seam and runs the identical HTTP cascade +
// snippet tail. Nothing permanent: every entry has a TTL, the store is
// bounded, and the rank cap just confines that attempt to the top of the
// read window (it is the most expensive existing tier).
export const BROWSER_RANK_MAX = 6;
const DOMAIN_BOT_COOLDOWN_MS = 10 * 60_000;
const DOMAIN_HEALTH_MAX = 256;
const domainHealth = new Map<string, number>();

function domainOnCooldown(domain: string): boolean {
  const exp = domainHealth.get(domain);
  return exp !== undefined && exp > Date.now();
}

function recordDomainBotBlock(domain: string): void {
  const now = Date.now();
  if (domainHealth.size >= DOMAIN_HEALTH_MAX) {
    // shortcut: LRU bookkeeping not worth it — drop expired, wipe if still
    // full; every entry has a TTL so the store self-heals.
    for (const [d, exp] of domainHealth) if (exp <= now) domainHealth.delete(d);
    if (domainHealth.size >= DOMAIN_HEALTH_MAX) domainHealth.clear();
  }
  domainHealth.set(domain, now + DOMAIN_BOT_COOLDOWN_MS);
}

/** Test-only: wipe cross-request health state (the Rust twin pairs this
    with a test lock; vitest isolates files and runs tests in-file
    sequentially, so the Map needs no lock here). */
export function resetExtractionHealth(): void {
  domainHealth.clear();
}

export async function extractUrl(
  result: RankedResult,
  /** §11.3 AMENDMENT: absolute deadline (epoch ms) for the HTTP tiers.
      Omitted = uncapped cascade — the original golden/parity path. */
  deadline?: number,
  /** §18: position of `result` in the pipeline's full read window —
      drives browser-tier selectivity only; callers with no window pass 0. */
  rankInWindow = 0,
  /** §11.11 page-layer mirror (2026-11-04 audit fix): on a live_required
      turn the SQLite PAGE cache is skipped just like the query cache —
      a "price today / latest" answer must never cite a 5h-old cached
      body. Cache WRITES still happen (fresh evidence replenishes it). */
  liveRequired = false,
): Promise<EvidencePacket & { classification: string }> {
  // Brief §6: FETCH semantics use the URL exactly as the engine/tool gave
  // it — case-sensitive paths, signed query params, amp/mobile shapes and
  // SPA-route hashes survive end to end; `canonical` stays the dedupe /
  // comparison key only. `|| canonical` covers synthetic results that
  // predate the §6 url/canonical split.
  const url = result.url || result.canonical;
  // Set whenever a capped tier expired; drives the tail branch.
  let budgetHit = false;
  const packet: EvidencePacket = {
    sourceId: "", // assigned later
    url,
    title: result.title,
    domain: result.domain,
    publishedAt: result.publishedDate,
    extraction: "snippet-only",
    passages: [],
  };

    // ── Universal SERP snippet baseline ────────────────────────────────
    // Guaranteed to survive every stage: the search engine's own indexed
    // title + snippet is evidence even when every direct connection to
    // the target page fails. Pushed FIRST so the reranker always has
    // something to score when the tier cascade comes up empty.
    const baseline = serpBaselinePassage(result);
    if (baseline) {
      packet.passages.push(baseline);
      packet.extraction = "snippet-only";
    }

    // Tier 0: SQLite cache hit (skipped entirely on live_required turns —
  // the §11.11 freshness law at the page layer, 2026-11-04 audit fix).
  const cached = liveRequired ? null : getCachedPage(url);
  if (cached && cached.extracted.length >= 200) {
    const cachedTier = cached.tier as string;
    packet.extraction =
      cachedTier === "jina" ? "jina-fallback" : "direct";
    packet.passages.push({
      sourceId: "",
      url,
      title: result.title,
      domain: result.domain,
      publishedAt: result.publishedDate,
      // No truncation: the cache stores the full extracted document.
      // The reranker's 2,000-char chunks handle the budget — trimming
      // 12,000 chars here would silently drop tail content (PDF
      // conclusions, long pricing tables, final pages of papers).
      passageText: cached.extracted,
      bm25Score: 0,
    });
    const classification =
      cachedTier === "jina"
        ? "SUCCESS_JINA_FALLBACK"
        : cachedTier === "adapter"
          ? "SUCCESS_ADAPTER"
          : cachedTier === "browser"
            ? "SUCCESS_BROWSER"
            : cachedTier === "wayback"
              ? "SUCCESS_WAYBACK"
            : cachedTier === "metadata"
              ? "SUCCESS_METADATA"
              : "SUCCESS_DIRECT";
    return { ...packet, classification };
  }

  // Tier 1.5: platform API adapter first (cheapest for known hosts)
  const adapterOut = await extractAdapter(url);
  if (adapterOut && adapterOut.markdown.length >= 200) {
    packet.extraction = "direct";
    packet.passages.push({
      sourceId: "",
      url,
      title: result.title,
      domain: result.domain,
      publishedAt: result.publishedDate,
      passageText: adapterOut.markdown,
      bm25Score: 0,
    });
    putCachedPage(url, adapterOut.markdown, "adapter");
    return { ...packet, classification: "SUCCESS_ADAPTER" };
  }

  // Tier 1: direct fetch with fingerprint rotation on block (rotation
  // happens INSIDE fetchPage — the caller only fires Tier 1 once; a
  // second caller-level fingerprint retry would re-fetch the clean HTML
  // that the first already recovered under, and waste the Jina budget
  // on a follow-up that never ran).
  // §11.3 AMENDMENT: capped by the remaining page budget; expiry
  // substitutes the network-failure shape (status 0, blocked) which keeps
  // the downstream tier gates intact — the page still gets the
  // link-preview tier if it fits, and ALWAYS the browser tier.
  const directRaw = await withDeadline(deadline, extractDirect(url, "chrome"));
  const directOut: TierOutput | null =
    directRaw === DEADLINE_EXPIRED
      ? ((budgetHit = true),
        {
          tier: "crash" as const,
          markdown: "",
          status: 0,
          blocked: true,
          blockedReason: "page budget exhausted during direct fetch",
        })
      : directRaw;

  if (directOut && !directOut.blocked && directOut.markdown.length >= 200) {
    // (audit item 8, 2026-11-04) A redirect that crossed registrable
    // domains served ANOTHER site's content. The packet must carry the
    // final URL/domain as truth (citations, provenance header) and must
    // not claim SUCCESS_DIRECT of the requested shop. Cross-domain bodies
    // are never cached under the requested URL — a later cache hit would
    // relabel them plain SUCCESS_DIRECT and launder the provenance away.
    const crossed = crossedRegistrableBoundary(url, directOut.resolvedUrl);
    const finalUrl = crossed ? directOut.resolvedUrl as string : url;
    const finalDomain = crossed ? registrableHost(finalUrl) ?? result.domain : result.domain;
    if (crossed) {
      packet.url = finalUrl;
      packet.domain = finalDomain;
    }
    packet.extraction = "direct";
    packet.passages.push({
      sourceId: "",
      url: finalUrl,
      title: result.title,
      domain: finalDomain,
      publishedAt: result.publishedDate,
      passageText: crossed ? redirectedProvenanceHeader(url, finalUrl) + directOut.markdown : directOut.markdown,
      bm25Score: 0,
    });
    if (!crossed) putCachedPage(url, directOut.markdown, "direct");
    return { ...packet, classification: crossed ? "SUCCESS_REDIRECTED" : "SUCCESS_DIRECT" };
  }

  // If Tier 1 produced only metadata (product JSON-LD, hydration state,
  // document mode), classify as SUCCESS_METADATA even when the DOM text
  // was thin.
  if (
    directOut &&
    !directOut.blocked &&
    directOut.tier === "metadata" &&
    directOut.markdown.length >= 100
  ) {
    // Audit item 8: same cross-domain truth rule as the direct-success
    // branch — metadata harvested off a landing on another registrable
    // site is that site's metadata, not the requested URL's.
    const crossed = crossedRegistrableBoundary(url, directOut.resolvedUrl);
    const finalUrl = crossed ? directOut.resolvedUrl as string : url;
    const finalDomain = crossed ? registrableHost(finalUrl) ?? result.domain : result.domain;
    if (crossed) {
      packet.url = finalUrl;
      packet.domain = finalDomain;
    }
    packet.extraction = "direct";
    packet.passages.push({
      sourceId: "",
      url: finalUrl,
      title: result.title,
      domain: finalDomain,
      publishedAt: result.publishedDate,
      passageText: crossed ? redirectedProvenanceHeader(url, finalUrl) + directOut.markdown : directOut.markdown,
      bm25Score: 0,
    });
    if (!crossed) putCachedPage(url, directOut.markdown, "metadata");
    return { ...packet, classification: crossed ? "SUCCESS_REDIRECTED" : "SUCCESS_METADATA" };
  }

  // Tier 2: social link-preview crawler bypass — fires when Tier 1 was
  // blocked or empty (WAF 403/503 / JS shell). Whitelisted bot UAs often
  // get a clean 200 where the browser fingerprint got a challenge page.
  const tier1BlockedOrEmpty =
    (directOut?.blocked ?? false) ||
    (directOut?.status === 0) ||
    (directOut?.markdown.length < 200 && directOut?.tier === "crash");

  let linkPreviewOut: TierOutput | null = null;
  if (tier1BlockedOrEmpty) {
    // §11.3 AMENDMENT: the 4-bot link-preview stack is the worst budget
    // burner (4×45s); it is capped by the remaining budget so the browser
    // tier downstream always stays reachable.
    const lpRaw = await withDeadline(deadline, extractLinkPreview(url));
    if (lpRaw === DEADLINE_EXPIRED) budgetHit = true;
    linkPreviewOut = lpRaw === DEADLINE_EXPIRED ? null : lpRaw;
    if (linkPreviewOut && linkPreviewOut.markdown.length >= 200) {
      // Audit item 8: bots get redirected too — carry the landing truth.
      const crossed = crossedRegistrableBoundary(url, linkPreviewOut.resolvedUrl);
      const finalUrl = crossed ? linkPreviewOut.resolvedUrl as string : url;
      const finalDomain = crossed ? registrableHost(finalUrl) ?? result.domain : result.domain;
      if (crossed) {
        packet.url = finalUrl;
        packet.domain = finalDomain;
      }
      packet.extraction = "direct";
      packet.passages.push({
        sourceId: "",
        url: finalUrl,
        title: result.title,
        domain: finalDomain,
        publishedAt: result.publishedDate,
        passageText: crossed ? redirectedProvenanceHeader(url, finalUrl) + linkPreviewOut.markdown : linkPreviewOut.markdown,
        bm25Score: 0,
      });
      if (!crossed) putCachedPage(url, linkPreviewOut.markdown, "direct");
      return { ...packet, classification: crossed ? "SUCCESS_REDIRECTED" : "SUCCESS_DIRECT" };
    }
  }

  // Browser-tier fallback — runs when Stage A (direct HTTP) was blocked,
  // challenged (HTTP 202 = Zepto/DataDome bot-challenge page), returned
  // an empty JS shell, or produced < 200 chars of markdown. The Playwright
  // pool executes the full page with per-context fingerprints; the JSON-walker
  // unpacks whatever `window` global hydration payload the SPA shipped.
  const directThinnedOrBlocked =
    (directOut?.blocked ?? false) ||
    (directOut?.status === 0) ||
    (directOut?.status === 202) ||  // WAF challenge page (Zepto, DataDome)
    (directOut?.status === 403) ||
    (directOut?.status === 429) ||
    (directOut?.markdown.length < 200 && directOut?.tier === "crash") ||
    (directOut?.markdown.length < 100 && !(directOut?.tier === "crash"));
  // §18: an attempt at the EXISTING browser seam is the most expensive
  // move in the cascade, so it is confined to the top of the read window,
  // and skipped for a domain still cooling down from a recent full
  // bot-block (short TTL, never permanent — §17). Missing this attempt is
  // just another tier miss: the jina/wayback/snippet tail below runs
  // unchanged either way.
  if (
    directThinnedOrBlocked &&
    rankInWindow < BROWSER_RANK_MAX &&
    !domainOnCooldown(result.domain)
  ) {
    const browserOut = await extractBrowser(result);
    if (browserOut && browserOut.markdown.length >= 200 && !browserOut.blocked) {
      // Audit item 8: the browser tier already prints the final URL in
      // its markdown; the packet/citation layer must agree with it.
      const crossed = crossedRegistrableBoundary(url, browserOut.finalUrl);
      const finalUrl = crossed ? browserOut.finalUrl as string : url;
      const finalDomain = crossed ? registrableHost(finalUrl) ?? result.domain : result.domain;
      if (crossed) {
        packet.url = finalUrl;
        packet.domain = finalDomain;
      }
      packet.extraction = "direct";
      packet.passages.push({
        sourceId: "",
        url: finalUrl,
        title: result.title,
        domain: finalDomain,
        publishedAt: result.publishedDate,
        passageText: crossed ? redirectedProvenanceHeader(url, finalUrl) + browserOut.markdown : browserOut.markdown,
        bm25Score: 0,
      });
      if (!crossed) putCachedPage(url, browserOut.markdown, "browser");
      return { ...packet, classification: crossed ? "SUCCESS_REDIRECTED" : "SUCCESS_BROWSER" };
    }
  }

  // Tier 4: Jina fallback — fires on any Tier 1/2 failure including
  // silent blocks (which is its whole point for Cloudflare-protected pages).
  // §11.3 AMENDMENT: capped tiers past the browser allowance are the pure
  // anti-stall tail — an expired budget skips them cheaply (the original
  // hard cut used to cut the BROWSER allowance short instead).
  const jinaRaw = await withDeadline(deadline, extractJina(url));
  if (jinaRaw === DEADLINE_EXPIRED) budgetHit = true;
  const jinaOut = jinaRaw === DEADLINE_EXPIRED ? null : jinaRaw;
  if (jinaOut && jinaOut.markdown.length >= 200) {
    packet.extraction = "jina-fallback";
    packet.passages.push({
      sourceId: "",
      url,
      title: result.title,
      domain: result.domain,
      publishedAt: result.publishedDate,
      passageText: jinaOut.markdown,
      bm25Score: 0,
    });
    putCachedPage(url, jinaOut.markdown, "jina");
    return { ...packet, classification: "SUCCESS_JINA_FALLBACK" };
  }

  // Tier 3: Wayback Machine snapshot — fires when Jina also failed AND
  // (a) the original fetch was a hard block / network error, OR
  // (b) Tier 1 produced an empty JS shell (sparse content). This is the
  // last network-based recovery before the snippet tier: archive.org's
  // CDX index covers even SPA sites whose live page returns an empty
  // shell to our fetcher.
  const tier1Failed =
    directOut &&
    (directOut.blocked ||
      directOut.status === 0 ||
      (directOut.markdown.length < 100 && directOut.tier === "crash"));
  // (audit 2026-11-04) an ARCHIVED snapshot can never answer a live_required
  // question (price/score/status) — skip the wayback tier entirely there.
  if (tier1Failed && !liveRequired) {
    const waybackRaw = await withDeadline(deadline, extractWayback(url));
    if (waybackRaw === DEADLINE_EXPIRED) budgetHit = true;
    const waybackOut = waybackRaw === DEADLINE_EXPIRED ? null : waybackRaw;
    if (waybackOut && waybackOut.markdown.length >= 200) {
      packet.extraction = "jina-fallback";
      packet.passages.push({
        sourceId: "",
        url,
        title: result.title,
        domain: result.domain,
        publishedAt: result.publishedDate,
        passageText: waybackOut.markdown,
        bm25Score: 0,
      });
      putCachedPage(url, waybackOut.markdown, "wayback");
      return { ...packet, classification: "SUCCESS_WAYBACK" };
    }
  }

  // Tier 4: snippet preservation — the metasearch snippet becomes the
  // passage. If the snippet is empty (a corpus URL with no pre-indexed
  // search result), the title is used as a minimal evidence stub so the
  // pipeline still has SOMETHING for the BM25 reranker.
  packet.extraction = "snippet-only";
  const snippet = result.snippet || result.title || "";

  // Tier 6: deep URL-slug metasearch triangulation.
  // Guaranteed zero-block fallback: parse the target URL into slug
  // keywords and run a site: scoped metasearch. Titles + snippets from
  // every matching result are synthesized into a clean evidence block.
  // Fires when the URL has no pre-indexed snippet (stress-test case)
  // AND Tier 1 was blocked/empty — converts FAIL_SILENT_BOT_BLOCK and
  // FAIL_EMPTY_JS_SHELL rows into SUCCESS_SNIPPET_FALLBACK.
  const directBlocked = directOut?.blocked ?? false;
  const directEmptyShell =
    !directBlocked &&
    directOut != null &&
    directOut.tier === "crash";

  if ((directBlocked || directEmptyShell || linkPreviewOut === null) && (result.snippet ?? "").length < 20) {
    try {
      // Tier 6a: slug triangulation (site: + broad keyword queries)
      // §11.3 AMENDMENT: issues live metasearch engine requests (~40s
      // each) — capped by the remaining budget.
      const synthRaw = await withDeadline(deadline, slugTriangulation(url, result.title));
      if (synthRaw === DEADLINE_EXPIRED) budgetHit = true;
      const synthesized = synthRaw === DEADLINE_EXPIRED ? "" : synthRaw;
      if (synthesized.length >= 80) {
        const cleaned = stripWafChallengeText(synthesized);
        if (hasMeaningfulContent(cleaned, 40)) {
          packet.passages.push({
            sourceId: "",
            url,
            title: result.title || "(triangulated)",
            domain: result.domain,
            publishedAt: result.publishedDate,
            passageText: cleaned,
            bm25Score: 0,
          });
          return { ...packet, classification: "SUCCESS_SNIPPET_FALLBACK" };
        }
      }
      // Tier 6b: exact-URL search fallback (search engines that index
      // the literal URL string — a broader net than slug keywords alone)
      const fbRaw = await withDeadline(deadline, urlSearchFallback(url, result.title));
      if (fbRaw === DEADLINE_EXPIRED) budgetHit = true;
      const fallbackResults = fbRaw === DEADLINE_EXPIRED ? [] : fbRaw;
      if (fallbackResults.length > 0) {
        const best = fallbackResults[0];
        const fbSnippet = (best.snippet || best.title || "").slice(0, 12000);
        if (fbSnippet.length >= 20) {
          const cleaned = stripWafChallengeText(fbSnippet);
          if (hasMeaningfulContent(cleaned, 40)) {
            packet.passages.push({
              sourceId: "",
              url,
              title: best.title || result.title,
              domain: best.domain || result.domain,
              publishedAt: best.publishedDate,
              // Audit #9: the passage is filed under the TARGET url (that
              // is what the packet is about), but its text came from a
              // third-party listing at `best.url`. The marker names the
              // real source so fallback evidence can never be presented
              // as a live read of the target. ⇔ Rust extractor Tier 6b.
              passageText: `${triangulatedPassageProvenance(best.url)}\n${cleaned}`,
              bm25Score: 0,
            });
            return { ...packet, classification: "SUCCESS_SNIPPET_FALLBACK" };
          }
        }
      }
    } catch {
      /* triangulation network failure — fall through to Tier 4 */
    }
  }

  // Classify the Tier 4 result: if Tier 1 hit a real block, this is a
  // FAIL_* that the stress report will surface; otherwise it's a clean
  // snippet fallback (SUCCESS_SNIPPET_FALLBACK).
  // §11.3 AMENDMENT: a page whose budget expired mid-cascade and that the
  // browser allowance could not rescue reports PAGE_BUDGET_TIMEOUT — the
  // same classification as before the amendment, but the packet keeps its
  // natural cascade shape: the SERP baseline passage is already first, and
  // the marker/title is pushed only when no baseline exists (identical
  // fallback text to timeoutFallbackPacket). Mirrors the budget_hit tail
  // in ruke-websearch's extract_url_capped.
  if (budgetHit) {
    packet.extraction = "snippet-only";
    if (packet.passages.length === 0) {
      packet.passages.push({
        sourceId: "",
        url,
        title: result.title,
        domain: result.domain,
        publishedAt: result.publishedDate,
        passageText:
          result.title || "(page read timed out — no content extracted)",
        bm25Score: 0,
      });
    }
    return { ...packet, classification: "PAGE_BUDGET_TIMEOUT" };
  }
  if (directOut && directOut.blocked) {
    const kind = directOut.blockedReason;
    packet.passages.push({
      sourceId: "",
      url,
      title: result.title,
      domain: result.domain,
      publishedAt: result.publishedDate,
      passageText:
        snippet.length >= 20 ? snippet : result.title || "(blocked page)",
      bm25Score: 0,
    });
    if (/login|sign in|auth/i.test(kind)) {
      return { ...packet, classification: "FAIL_SILENT_LOGIN_WALL" };
    }
    if (/cloudflare|akamai|perimeterx|datadome|captcha|bot|js/i.test(kind)) {
      recordDomainBotBlock(result.domain);
      return { ...packet, classification: "FAIL_SILENT_BOT_BLOCK" };
    }
    return { ...packet, classification: "FAIL_NETWORK_OR_CRASH" };
  }

  if (snippet.length < 20) {
    // No snippet AND no title: this is a true empty JS shell — classify
    // as FAIL_EMPTY_JS_SHELL. We still keep the URL in the packet so
    // downstream consumers can see it, but the reranker will penalize
    // it heavily (zero useful tokens).
    packet.passages.push({
      sourceId: "",
      url,
      title: result.title,
      domain: result.domain,
      publishedAt: result.publishedDate,
      passageText:
        result.title || "(empty page — JS shell, no content extracted)",
      bm25Score: 0,
    });
    return { ...packet, classification: "FAIL_EMPTY_JS_SHELL" };
  }

  // A real snippet (or title) survived the Tier 1 failure — this is a
  // clean SUCCESS_SNIPPET_FALLBACK.
  packet.passages.push({
    sourceId: "",
    url,
    title: result.title,
    domain: result.domain,
    publishedAt: result.publishedDate,
    passageText: snippet,
    bm25Score: 0,
  });
  return { ...packet, classification: "SUCCESS_SNIPPET_FALLBACK" };
}

const BUDGET_HIT = Symbol("page-budget-hit");

/**
 * §11.3 (AMENDED 2026-10-29): the deadline is threaded INTO the cascade —
 * each HTTP tier is capped at its own await by the remaining budget, and
 * the browser tier always runs when the direct read thinned/blocked
 * (bridge-bounded). This race is now a SAFETY NET with one browser
 * allowance of slack (budget + BROWSER_ALLOWANCE_MS): it can only fire if
 * a tier ignores its cap, which none do on the normal path. The losing
 * cascade keeps running harmlessly in the background (its own per-request
 * timeouts bound it) and its late rejection is absorbed. A cache throw
 * while the race is still live rejects exactly like the original
 * Promise.all. Mirrors the tokio::time::timeout wrapper in ruke-
 * websearch's extract_all: the page still counts toward onPage progress
 * and still receives its S-id.
 */
async function extractUrlWithBudget(
  result: RankedResult,
  budgetMs: number,
  rankInWindow = 0,
  liveRequired = false,
): Promise<EvidencePacket & { classification: string }> {
  const deadline = Date.now() + budgetMs;
  const work = extractUrl(result, deadline, rankInWindow, liveRequired);
  const guard = work.catch(() => undefined); // absorb a post-budget rejection
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const won = await Promise.race([
      work,
      new Promise<typeof BUDGET_HIT>((resolve) => {
        timer = setTimeout(
          () => resolve(BUDGET_HIT),
          budgetMs + BROWSER_ALLOWANCE_MS,
        );
      }),
    ]);
    return won === BUDGET_HIT ? timeoutFallbackPacket(result) : won;
  } finally {
    if (timer) clearTimeout(timer);
    void guard;
  }
}

/**
 * Extract the top N ranked results in parallel (capped at 10 URLs, 6 at a
 * time). Returns packets ready for BM25 scoring, each with its
 * classification for the stress-test report.
 */
export async function extractAll(
  ranked: RankedResult[],
  maxUrls = 10,
  /** Real per-page completion counter (this batch only) — used by the
      chat route's live progress bridge; optional, existing callers unaffected. */
  onPage?: (done: number, total: number) => void,
  /** §11.3 per-page wall-clock budget (MIGRATION-MAP); production always
      uses the default, tests may inject a smaller one. */
  pageBudgetMs = PAGE_BUDGET_DEFAULT_MS,
  /** §18: start position of `ranked` inside the pipeline's full read
      window; batched hops pass their offset, one-shot callers pass 0. */
  rankBase = 0,
  /** §25 mid-wave sufficiency stop: consulted once per page COMPLETION; on
      the first true the wave resolves with the packets completed so far,
      in rank order, and no further progress frames are emitted. Mirrors
      extract_all's `stop_when` in extractor.rs — JS promises cannot be
      aborted, so unfinished pages are ABANDONED (their results discarded
      by the guard below) where Rust cancels the futures outright; the
      visible contract (packet set, progress frames, S-ids) is identical.
      Upgrade path if abandoned fetches ever start costing bandwidth:
      thread an AbortController through limit()/extractUrlWithBudget. */
  stopWhen?: (packet: EvidencePacket & { classification: string }) => boolean,
  /** §11.11 page-layer freshness law (2026-11-04 audit fix): true ⇒ skip
      the SQLite page cache for every page in this wave. */
  liveRequired = false,
): Promise<(EvidencePacket & { classification: string })[]> {
  const top = ranked.slice(0, maxUrls);
  const settled: Array<(EvidencePacket & { classification: string }) | undefined> =
    new Array(top.length).fill(undefined);
  let donePages = 0;
  let stopped = false;
  let signalStop: () => void = () => {};
  const stopGate = new Promise<void>((resolve) => { signalStop = resolve; });
  const tasks = top.map((r, i) => limit(() => extractUrlWithBudget(r, pageBudgetMs, rankBase + i, liveRequired)).then((p) => {
    if (stopped) return undefined; // abandoned page — Rust cancels these instead
    settled[i] = p;
    donePages++;
    onPage?.(donePages, top.length);
    if (stopWhen?.(p)) {
      stopped = true;
      signalStop();
    }
    return p;
  }));
  // Full-wave path is the original Promise.all (rejects like before); the
  // race only ever settles early when the predicate fired.
  await Promise.race([Promise.all(tasks), stopGate]);
  if (stopped) for (const t of tasks) t.catch(() => {}); // abandon, don't unhandled-reject
  const packets = settled.filter(
    (p): p is EvidencePacket & { classification: string } => p !== undefined,
  );
  // Assign S1..Sn in rank order (positional slots keep the order; a
  // stopped wave simply has holes, and ids renumber over the survivors).
  packets.forEach((packet, i) => {
    packet.sourceId = "S" + (i + 1);
    for (const p of packet.passages) p.sourceId = packet.sourceId;
  });
  return packets;
}

/**
 * Re-number a LATE-MERGED batch so it cannot collide with the ids already in
 * the run. `extractAll` assigns S1..Sn WITHIN its own batch, and the pipeline
 * merges every extra hop (gap search, verification hop) into one packet set —
 * without this, a hop-2 page and a hop-1 page can both be "S3", and the
 * evidence block, the citation map, the ledger and the state banners would key
 * two different URLs off one id: passages cited under another page's URL,
 * banners attached to the wrong page. Mutates in place, ids stay "S<number>".
 */
export function renumberPackets(packets: EvidencePacket[], startAt = 1): void {
  packets.forEach((packet, i) => {
    packet.sourceId = "S" + (startAt + i);
    for (const p of packet.passages ?? []) p.sourceId = packet.sourceId;
  });
}

/** First free source id index after a packet set (for renumberPackets). */
export function nextSourceIndex(packets: EvidencePacket[]): number {
  let max = 0;
  for (const p of packets) {
    const m = /^S(\d+)$/.exec(String(p.sourceId ?? ""));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}
