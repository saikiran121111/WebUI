/**
 * SEARCH-BY-DEFAULT gate — search_required = true is the DEFAULT for any
 * non-trivial prompt; the model gets to veto a search ONLY for the two
 * narrow classes of self-contained prompts. No domain whitelists, no
 * narrow keyword lists.
 *
 * Decision flow:
 *   0. Hard bypass (URL / known-domain / web-intent / image+intent) →
 *      search, 0 ms.
 *   1. Trivial 1-2 word greetings → NO-SEARCH (zero tokens, zero risk).
 *   2. Main-model gate (one JSON call, 35s ceiling): the model says
 *      search_required=true unless the prompt is strictly
 *      (a) pure conversational filler, OR
 *      (b) a self-contained offline code/math/text transformation where
 *          the user supplied 100% of the input AND mentioned zero
 *          external brands, websites, people, places, products, events
 *          or facts.
 *      Whenever ANY proper noun, brand, website, product, movie,
 *      restaurant, location, URL, or factual question appears → ALWAYS
 *      search. This inversion is encoded in the system prompt below and
 *      in the parser: a model `search_required=false` verdict is
 *      RE-VERIFIED against the "external entity present" heuristic, and
 *      overturned to `true` when a proper noun / brand / URL /
 *      time-sensitive fact is detected in the prompt.
 *   3. Main model unreachable / unparseable → SEARCH-BY-DEFAULT:
 *      `rulesBasedPlan()` (search_required=true), NOT a no-search
 *      fallback. The gate errs on the side of running a search rather
 *      than missing live facts — a junk search is far cheaper than a
 *      confidently wrong answer.
 *
 * Authority is exactly ONE model (the main model from settings.json);
 * no separate LFM / secondary router. Historical note: the LFM2.5-1.2B
 * router (:8791) was removed 2026-10-22; lfm-gate.ts was deleted 2026-10-23
 * and replaced by this file.
 */
import { childLogger } from "@/lib/server/logger";
import { llmApiUrl, llmApiKey } from "@/lib/server/settings";
import {
  SearchGateResult,
  SearchGateContext,
  SearchDecision,
} from "./types";
import { detectUrlsAndDomains, detectPromptUrls, type DetectedUrl } from "./url-detector";

const log = childLogger("web-search/search-gate");

/**
 * Live endpoint resolution: WEB_SEARCH_LLM_ENDPOINT (explicit override) or the
 * shared settings.json/env/fallback chain — settings.json wins so a UI edit
 * reaches the web-search pipeline without a server restart. This is the ONLY
 * model the gate may call (no LFM port, no secondary gateway).
 */
function endpoint(): string {
  return process.env.WEB_SEARCH_LLM_ENDPOINT ?? llmApiUrl();
}

/**
 * Ceiling for the AUTHORITATIVE main-model gate call. It emits a full
 * decision + query plan (~150 tokens measured) so it needs more headroom
 * than a boolean check. Measured warm latency on the main slot is ~2.5-5s.
 */
const MAIN_GATE_TIMEOUT_MS = 35_000;
const MAIN_GATE_MAX_TOKENS = 320;

const GATE_JSON_SCHEMA = {
  type: "object",
  properties: {
    search_required: { type: "boolean" },
    reason: { type: "string" },
    freshness: { type: "string", enum: ["none", "day", "week", "month", "year", "any"] },
    depth: { type: "string", enum: ["quick", "standard", "deep"] },
    queries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          query: { type: "string" },
          intent: { type: "string", enum: ["general", "news", "docs", "code", "academic", "forum"] },
          preferred_domains: { type: "array", items: { type: "string" } },
        },
        required: ["query", "intent"],
      },
    },
  },
  required: ["search_required", "reason", "freshness", "depth", "queries"],
} as const;

/* ── trivial prompt short-circuit (the ONLY regex that survives) ─────── */

/**
 * Trivial prompts — a match skips the LLM call entirely (zero latency,
 * zero tokens). Exact match after stripping trailing punctuation, plus one
 * optional chit-chat filler peel ("By the way which model are you" →
 * "which model are you").
 */
const TRIVIAL_EXACT = new Set([
  // greetings
  "hi", "hello", "hey", "yo", "sup", "thanks", "thank you", "thx",
  "ok", "okay", "cool", "nice", "got it", "sounds good", "bye", "goodbye",
  // assistant-identity / pure chit-chat
  "what are you doing", "what are you up to",
  "which model are you", "what model are you", "who are you",
  "who made you", "who created you", "what are you", "are you alive",
  "how do you work", "how are you", "what can you do",
]);

const TRIVIAL_FILLER_PREFIX = /^(?:by the way|so|anyway|then|oh|hmm|hi|hey|hello|thanks|thank you)\s+/i;

function isTrivialPrompt(prompt: string): boolean {
  let p = prompt.trim().toLowerCase();
  p = p.replace(/[.!?…\s]+$/, "");
  if (TRIVIAL_EXACT.has(p)) return true;
  const peeled = p.replace(TRIVIAL_FILLER_PREFIX, "");
  if (peeled !== p && TRIVIAL_EXACT.has(peeled)) return true;
  return false;
}

/** Detect an explicit http:// or https:// URL in the user prompt. */
export function extractPromptUrls(prompt: string): string[] {
  // tldts-based detector: catches full URLs AND bare domains (skiran.dev,
  // lite.ego.app, rbi.org.in) across all 1,440+ IANA TLDs with a
  // code-filename guard so "app.ts" is never mistaken for a domain.
  return detectPromptUrls(prompt);
}

/* ── STAGE 0: deterministic hard bypass (0 ms, no LLM call) ──────────── */

/**
 * The user's message is unambiguously about the live web. Three detectors:
 *
 *   A. URL / known domain / shortener   — any http(s):// or www. URL, or a
 *      bare known name (youtu.be, youtube.com, maps.app.goo.gl, goo.gl,
 *      bit.ly, t.co, lnkd.in, redd.it, amzn.to, linkedin.com, reddit.com,
 *      x.com, instagram.com), or a bare domain-shaped token ending in a
 *      known TLD (.gov, .gov.in, .nic.in, .com, .org, .in, .io, .net, .co).
 *   B. Explicit web/freshness intent    — search, look up, watch, video,
 *      location, maps, linkedin, reddit, who won, latest, current, today,
 *      this year's digits (e.g. 2026), price, jobs, hiring.
 *   C. Image attachment + lookup intent — a screenshot plus person/place/
 *      company lookup words (search, linkedin, profile, who is, find, guy,
 *      person, company, location, where is, product).
 *
 *   D. Attachment-local suppression (APPROVED PART-10 DEVIATION) — the
 *      current turn carries attachment evidence (hasAttachmentEvidence)
 *      AND shows no explicit web/current/external intent → forced
 *      {search_required: false, reason: "deterministic_attachment_local"}:
 *      file tasks are answered from the injected evidence, the model gate
 *      is never consulted, and NO query is ever built from a meta-
 *      instruction. Hybrid turns fall through instead: a BROADER phrase
 *      list (EXPLICIT_WEB_INTENT_RE) keeps "browse the web / still
 *      accurate / recent sources / online" turns with the normal gate.
 *
 *   E. Universal self-contained / local-only skip (APPROVED PART-10
 *      DEVIATION) — force-NO {reason: "deterministic_self_contained"}
 *      with ZERO queries, NO attachment required:
 *        E1 local-only intent — the user EXPLICITLY scoped the turn to
 *           local evidence ("do not search the web", "answer only from
 *           the attached/pasted …"). NO escape-hatch check (the phrase
 *           list contains "web" itself, so an escape test would self-
 *           cancel); instead the rule only HOLDS when no live/freshness
 *           intent survives outside the negation phrases (residual
 *           re-test). Evaluated AHEAD of B so the "search" inside
 *           "do not search" cannot force a search.
 *        E2 self-contained task — a transform of SUPPLIED content
 *           (verb + demonstrative + artifact noun in one sentence),
 *           prompt-defined code-gen, or pure arithmetic. Guarded by the
 *           EXPLICIT_WEB_INTENT_RE escape hatch like D.
 *
 *   F. Universal freshness force-YES (APPROVED PART-10 DEVIATION) —
 *      high-confidence time-sensitive shapes (currently, weather,
 *      how much…cost, still supported/available/true, up to date,
 *      most recent, this week/month/year, who is the <office holder>,
 *      current/latest version|release) force A–C's SEARCH verdict. The
 *      model gate can NEVER veto a staleness question; it flows into the
 *      same keyword planner, so the decision bytes stay identical to the
 *      pre-deviation behavior for prompts A–C already caught.
 *
 * Ordering law (FRESHNESS NEVER LOSES): A → F → E1 (residual-guarded) →
 * B → C → D → E2. A contradictory "don't search — what's the latest?"
 * turn searches; a pure local task never wastes an engine query on its
 * own operational instruction.
 *
 * When A/B/C/F fire the gate answers {search_required: true, reason:
 * "deterministic_url_or_intent"} in 0 ms — the model never gets to veto
 * "open the link the user literally pasted". D/E1/E2 are the force-NO hits.
 */
const KNOWN_SITE_TOKEN_RE =
  /(?:^|[^\w./-])(youtu\.be|youtube\.com|maps\.app\.goo\.gl|goo\.gl|bit\.ly|t\.co|lnkd\.in|redd\.it|amzn\.to|linkedin\.com|reddit\.com|x\.com|instagram\.com)(?:$|[^\w./-])/i;

const DOMAIN_TLD_TOKEN_RE =
  /(?:^|[^\w./-])[\w-]+(?:\.[\w-]+)*\.(?:gov|gov\.in|nic\.in|com|org|io|net|co|uk|edu)(?:$|[^\w.-])/i;

const WWW_TOKEN_RE = /(?:^|[^\w./-])www\.[\w-]+/i;

// Part-10 UNIVERSAL pre-gate refinement (APPROVED PART-10 DEVIATION): the
// BARE `search` token is gone — it force-YESed codegen prompts like "Write
// Python code for binary search." and made the engine pool search the
// user's own instruction (the bug class this part retires). Only an
// explicit web-search frame ("search the web/online/internet", "web/google
// search") force-YESes here; a bare "search for X" now reaches the model
// gate, whose explicit-search rule still answers YES. Byte-identical to
// the Rust re_web_intent body.
const WEB_INTENT_RE =
  /(?:\b(?:watch|video|location|maps|linkedin|reddit|latest|current|today|price|jobs|hiring|20(?:2[4-9]))\b|\bsearch(?:es|ing|ed)?\s+(?:the\s+)?(?:web|internet|online)\b|\b(?:web|google|internet)\s+search(?:es|ing)?\b|\blook\s?up\b|\bwho\s+won\b)/i;

/**
 * Part-10 follow-up fix (APPROVED DEVIATION, MIGRATION-MAP §11.2): the
 * narrow `video` token in WEB_INTENT_RE force-YESed "Read the text burned
 * into the attached video …" — but that media is the user's OWN attached
 * file, not an external web target. These probe regexes strip attachment
 * self-references BEFORE the web-intent arm is evaluated (probe ONLY —
 * the freshness arm and the query planner still see the FULL prompt, so
 * hybrid turns keep force-YES):
 *   MEDIA_SELF_REF_RE — unconditional: an explicit "attached/uploaded/
 *     pasted/provided/supplied + media noun" phrase is a self-reference
 *     wherever it appears ("search the video of the keynote" is NOT one);
 *   ATTACH_ANAPHORA_RE — pronoun anaphora ("this/the/my video"), stripped
 *     ONLY when the turn actually carries local attachment evidence, so a
 *     no-attachment "watch this video on youtube" keeps its web intent.
 * Rust mirror: re_media_self_ref / re_attach_anaphora / web_intent_probe.
 */
const MEDIA_NOUNS =
  "audio|video|recording|clip|footage|image|photo|picture|screenshot|pdf|doc(?:ument)?|file|transcript|log|code";
// Global replace ⇔ Rust `replace_all` (strip EVERY self-ref occurrence).
const MEDIA_SELF_REF_RE_G = new RegExp(
  `\\b(?:attached|attachment|uploaded|pasted|provided|supplied)\\s+(?:[a-z]+\\s+){0,2}?(?:${MEDIA_NOUNS})\\b`,
  "gi",
);
const ATTACH_ANAPHORA_RE_G = new RegExp(
  `\\b(?:this|these|my|the)\\s+(?:${MEDIA_NOUNS})\\b`,
  "gi",
);

/** Web-intent probe body: the prompt with attachment self-refs
 *  neutralized (see MEDIA_SELF_REF_RE_G above). Freshness checks and
 *  query planning NEVER use the probe. */
function webIntentProbe(prompt: string, hasLocalArtifact: boolean): string {
  let s = prompt.replace(MEDIA_SELF_REF_RE_G, " ");
  if (hasLocalArtifact) s = s.replace(ATTACH_ANAPHORA_RE_G, " ");
  return s;
}

/** Lookup-intent words that only count when an image is attached. */
const IMAGE_LOOKUP_INTENT_RE =
  /(?:\b(?:search|linkedin|profile|find|guy|person|company|location|product)\b|\bwho\s*'?s?\s+is\b|\bwhere\s+is\b|\bwhat\s+is\s+this\b)/i;

/**
 * APPROVED PART-10 DEVIATION — the attachment-aware escape hatch. A turn
 * with attachment evidence is only suppressed when it shows NO sign of
 * wanting live-web/current/external information. This broader phrase list
 * is consulted ONLY when attachment evidence is present (non-attachment
 * turns keep byte-identical parity behavior via the narrow WEB_INTENT_RE
 * above). Word-boundary phrases only: "research" never matches through
 * "search", "renew" never through "news".
 */
const EXPLICIT_WEB_INTENT_RE =
  /(?:\b(?:website|web|browse|online|internet|google|news|recent|recently|newest|currently|fact(?:\s|-)+check)\b|\blook\s?online\b|\bup[\s-]?to[\s-]?date\b|\bstill\s+(?:true|accurate|valid|current|available)\b)/i;

/* ── universal search pre-gate regexes (APPROVED PART-10 DEVIATION) ──── */
// Byte-identical bodies to the Rust re_freshness / re_local_only /
// re_supplied_task / re_codegen / re_math (Rust scopes ASCII \b with
// (?-u:…); JS \b is already ASCII).

/** Layer F — high-confidence freshness / time-sensitive → FORCE SEARCH.
 *  Deliberately NARROW and phrase-anchored; office-holder nouns only
 *  match inside the "who is/are the …" frame. */
const FRESHNESS_RE =
  /(?:\b(?:currently|weather|forecast)\b|\bhow\s+much\b[^.!?]{0,40}?(?:\bcosts?\b|\bprice\b|\bworth\b)|\bthis\s+(?:week|month|year)\b|\bmost\s+recent\b|\bas\s+of\s+now\b|\bup[\s-]?to[\s-]?date\b|\bstill\s+(?:supported|available|maintained|true|accurate|valid|current)\b|\bwho\s+(?:is|are)\s+the\s+(?:ceo|president|mayor|governor|chairman|director|coach|captain)\b|\b(?:current|latest)\s+(?:version|release)\b)/i;

/** Layer E1 — the user EXPLICITLY scoped the turn to local evidence. */
const LOCAL_ONLY_RE =
  /(?:\b(?:do not|don't|dont|no)\s+(?:web\s+)?(?:search|browsing?|googling?|looking\s+online)\b|\bwithout\s+(?:searching|browsing)\b|\b(?:only|just)\s+(?:from|based on|using)\s+(?:the\s+)?(?:attached|provided|supplied|uploaded|pasted|given)\b|\b(?:answer|respond|reply)\s+based on\s+(?:the\s+)?(?:attached|provided|supplied|uploaded|pasted|given)\b|\banswer\s+(?:only|strictly)\s+from\b|\buse\s+only\s+the\s+attached\b|\bnothing\s+else\b)/i;
// Part-10 follow-up fix (§11.2): "…, nothing else." is the meta-instruction
// fingerprint (closed-form local answers: "reply YES", "repeat after me").
// The residual re-test below stays the guard: "watch the launch tomorrow,
// nothing else" keeps `watch` in the residual → the web arm re-fires.
// Global mirror ⇔ Rust `replace_all` (strip EVERY local-only phrase).
const LOCAL_ONLY_RE_G = new RegExp(LOCAL_ONLY_RE.source, "gi");

/** Layer E2 — a verb that TRANSFORMS content the user supplied, in one
 *  sentence; the demonstrative must reach an artifact noun (so "Review
 *  this year's finals" never skips). */
const SUPPLIED_TASK_RE =
  // §11.2 follow-up: `listen|hear` verbs + media nouns (audio|video|…) —
  // attached-media meta-instructions ("Listen to the attached audio…")
  // are supplied-content transforms even through the web-intent probe;
  // the read arm now also tolerates "read the ATTACHED transcript".
  /(?:\b(?:summar(?:y|ize|ise)|translat(?:e|ion)|rewrite|paraphrase|shorten|proofread|fix|correct|review|refactor|debug|annotate|explain|clarify|improve|convert|extract|listen|hear)\b[^.!?]{0,25}?(?:this|these|my|attached|supplied|uploaded|pasted|provided)\b[^.!?]{0,20}?(?:code|file|text|log|logs|pdf|doc|docs|document|documents|paragraph|snippet|function|screenshot|image|essay|article|script|trace|error|message|conversation|table|data|json|csv|resume|letter|contract|draft|passage|chat|audio|video|recording|clip|footage|transcript|voice|speech)|\bwhat(?:'s|\s+is)\s+wrong\s+with\b|\bfind\s+the\s+(?:bug|issue|problem)\s+in\b|\bread\s+(?:this|the|an?)\s+(?:attached\s+)?(?:file|code|text|log|pdf|attachment|audio|video|recording|clip|transcript)\b)/i;

/** Layer E2 — code-writing tasks fully defined by the prompt itself. */
const CODEGEN_RE =
  /\b(?:write|create|generate|give me|produce|implement)\b[^.!?]{0,30}?\b(?:code|function|component|script|program|class|regex|sql|hook|snippet|unit tests?)\b/i;

/** Layer E2 — pure arithmetic ("what is 15 * 17?", "solve 25 * 47"). */
const MATH_RE =
  /(?:\b(?:what(?:'s|\s+is)|solve|calculate|compute)\b[^.!?]{0,12}?\d+\s*[-+*/xX]\s*\d+)/i;

/** Shared force-NO decision for every deterministic local-task layer.
 *  Structurally guarantees ZERO queries — an operational instruction can
 *  never become an engine query from the skip path. */
function localTaskDecision(): SearchDecision {
  return {
    search_required: false,
    reason: "deterministic_self_contained",
    freshness: "any",
    depth: "standard",
    queries: [],
  };
}

export interface HardBypassHit {
  matched:
    | "url"
    | "known_site"
    | "web_intent"
    | "image_intent"
    | "freshness"
    | "attachment_evidence"
    | "local_task";
  /** tldts-detected URLs/bare-domains (normalised https:// form). */
  detected: DetectedUrl[];
}

/** Returns the bypass verdict (queries pre-filled from the URLs/entities)
 *  or null when the message needs the model to decide. */
export function deterministicHardBypass(
  ctx: SearchGateContext,
): { decision: SearchDecision; hit: HardBypassHit } | null {
  const p = ctx.userPrompt.trim();
  if (!p) return null;

  const detected = detectUrlsAndDomains(p);
  // Part-10 universal pre-gate (APPROVED DEVIATION): ordering law is
  // url → freshness (force-YES) → local-only (force-NO) → web intent →
  // image intent → attachment → self-contained task. Mirrors the Rust
  // `deterministic_hard_bypass` chain byte-for-byte in semantics.
  //
  // E1 "holds" ONLY when no live intent survives OUTSIDE the negation
  // phrases: "do not search the web" contains the force-YES token
  // "search", so the residual (every local-only phrase stripped) is
  // re-tested against the web-intent and freshness lists. A contradictory
  // "don't search — what's the latest version?" turn falls through to the
  // force-SEARCH arms instead.
  // §11.2 follow-up: the web-intent arm (and the E1 residual re-test)
  // evaluate the PROBE form of the prompt — attachment self-references
  // like "the attached video" must not masquerade as external-media web
  // intent. Freshness always sees the full prompt (freshness never loses).
  const localArtifact = ctx.hasAttachmentEvidence === true;
  const localOnlyHolds =
    LOCAL_ONLY_RE.test(p) &&
    !(
      WEB_INTENT_RE.test(webIntentProbe(p.replace(LOCAL_ONLY_RE_G, " "), localArtifact)) ||
      FRESHNESS_RE.test(p.replace(LOCAL_ONLY_RE_G, " "))
    );

  let hit: HardBypassHit | null = null;

  if (detected.length > 0) hit = { matched: "url", detected };
  else if (FRESHNESS_RE.test(p)) hit = { matched: "freshness", detected: [] };
  else if (localOnlyHolds) {
    // Layer E1: the user EXPLICITLY scoped the turn to local evidence.
    // No escape-hatch check — the phrase list contains "web" itself, so
    // an escape test would self-cancel; the residual re-test above IS
    // the guard. Force-NO with zero queries; the model gate never runs.
    return {
      hit: { matched: "local_task", detected: [] },
      decision: localTaskDecision(),
    };
  }
  else if (WEB_INTENT_RE.test(webIntentProbe(p, localArtifact))) hit = { matched: "web_intent", detected: [] };
  else if (ctx.hasImageAttachment && IMAGE_LOOKUP_INTENT_RE.test(p)) hit = { matched: "image_intent", detected: [] };
  else if (ctx.hasAttachmentEvidence) {
    // APPROVED PART-10 DEVIATION (attachment-aware gate): the current turn
    // already carries local attachment evidence, so a file-grounded
    // instruction must never wait on — or lose to — a probabilistic model
    // verdict that web-searches the instruction itself. Explicit web/
    // current/external intent falls through to the normal gate (hybrid
    // turns keep web research); anything else is a forced NO: 0 ms, zero
    // tokens, no gate LLM / planner / engines / extractor / browser touch,
    // and NO queries — a meta-instruction can never become an engine query
    // from this path.
    if (EXPLICIT_WEB_INTENT_RE.test(p)) return null;
    return {
      hit: { matched: "attachment_evidence", detected: [] },
      decision: {
        search_required: false,
        reason: "deterministic_attachment_local",
        freshness: "any",
        depth: "standard",
        queries: [],
      },
    };
  }
  else if (SUPPLIED_TASK_RE.test(p) || CODEGEN_RE.test(p) || MATH_RE.test(p)) {
    // Layer E2 (universal, NO attachment required): transforming supplied
    // content, prompt-defined code-gen, or pure arithmetic is answered
    // locally. Same escape-hatch law as D — an explicit web/external
    // intent on the turn returns it to the normal gate.
    if (EXPLICIT_WEB_INTENT_RE.test(p)) return null;
    return {
      hit: { matched: "local_task", detected: [] },
      decision: localTaskDecision(),
    };
  }
  if (!hit) return null;

  const queries: SearchDecision["queries"] = [];
  // Keyword form first: search engines index pages, not URL strings — a
  // URL-as-query returns the domain's homepage (or nothing). The pipeline's
  // Stage-0 direct-target fetch reads the prompt's own URLs in parallel,
  // so the keyword query is all the engine pool needs to learn what to
  // look for around the link.
  const filler = new Set([
    "tell", "me", "what", "is", "the", "a", "an", "i", "want", "to", "so",
    "you", "can", "could", "please", "how", "about", "in", "on", "at", "by",
    "for", "from", "with", "that", "this", "these", "those", "there", "here",
    "would", "like", "need", "look", "find", "show", "give", "get", "best",
    "top", "good", "and", "it", "its", "of", "up",
  ]);
  const keywords = p
    .replace(/https?:\/\/[^\s"'<>[\]]+/gi, " ")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !filler.has(w))
    .slice(0, 8)
    .join(" ");
  if (keywords.length > 3) queries.push({ query: keywords, intent: "general" });

  // URL plans: kept as last queries (cache-key continuity) — metasearch()
  // drops URL-shaped plans from the engine pool; the pipeline's Stage-0
  // direct-target fetch is what actually reads the linked page.
  if (hit.detected.length > 0) {
    for (const d of hit.detected.slice(0, 4)) {
      if (!queries.some((q) => q.query === d.url)) {
        queries.push({ query: d.url, intent: "general" });
      }
    }
  }
  if (queries.length === 0) {
    queries.push({ query: p.replace(/\s+/g, " ").trim().slice(0, 300), intent: "general" });
  }

  const isNewsy = /\b(latest|current|today|20(?:2[4-9])|who\s+won|price|jobs|hiring)\b/i.test(p);
  return {
    hit,
    decision: {
      search_required: true,
      reason: "deterministic_url_or_intent",
      freshness: isNewsy ? "week" : "any",
      depth: hit.detected.length > 0 ? "deep" : "standard",
      queries,
    },
  };
}

/* ── external-entity detector (the search-by-default re-verify) ───────── */

/**
 * Deterministic "external entity present" check. Under the search-by-default
 * policy a model `search_required=false` verdict is only honored when the
 * prompt contains NONE of: a URL, a known-site token, a domain-shaped
 * token, a proper-noun phrase (2+ consecutive capitalized words), a
 * version number, a time-sensitivity signal, or an attached image with
 * lookup intent. If any of these fire, the verdict is overturned to
 * search_required=true by the parser (see parseMainGateJson), so a lazy
 * "I can answer from memory" answer can never suppress a live-facts
 * lookup for Blinkit / Myntra / a local business / any proper noun.
 */
export function promptHasExternalEntity(prompt: string): boolean {
  const p = prompt ?? "";
  if (p.trim().length === 0) return false;
  // 1. Explicit URL or bare domain (tldts-based, all 1,440+ TLDs)
  if (detectUrlsAndDomains(p).length > 0) return true;
  // 3. Proper-noun phrase: two consecutive capitalized words ("Blinkit deal",
  //    "BookMyShow movie", "NVIDIA stock"). One capitalized word at
  //    sentence start is NOT enough (English sentences start capitalized);
  //    two in a row is a strong proper-noun signal.
  const properNounPhrase = /\b[A-Z][a-z]{2,}\s+[A-Z][a-z]{2,}\b/.test(p);
  if (properNounPhrase) return true;
  // 4. Version numbers / model numbers (v1.2.3, 15.2, 3090, RTX 4090, ...)
  if (/\bv?\d+\.\d+(?:\.\d+)?\b/.test(p) || /\b[A-Z]{2,}\s?\d{2,4}\b/.test(p)) return true;
  // 5. Time-sensitivity signal (prices, "today", "current", a specific
  //    year digit)
  if (/\b(today|current|latest|recent|20(?:[012]\d))\b/i.test(p)) return true;
  // 6. Proper-noun-ish single capitalized token of 4+ chars that is not
  //    the sentence's first word. Heuristic: a capitalized word appearing
  //    after position 4 in the prompt.
  const nonLeadingCap = p.slice(4).match(/\b[A-Z][a-z]{3,}\b/);
  if (nonLeadingCap) return true;
  return false;
}

/* ── deterministic fallback plans (emergency only) ───────────────────── */

export function rulesBasedPlan(ctx: SearchGateContext): SearchGateResult {
  const p = ctx.userPrompt.trim();
  const hasTimeSignal = /latest|recent|new|current|today|this (week|month|year|quarter)/i.test(p);
  const hasVersion = /\bv?\d+\.\d+|version \d+/i.test(p);
  const urls = extractPromptUrls(p);
  const queries: SearchDecision["queries"] = [
    {
      query: p.replace(/\s+/g, " ").trim().slice(0, 300),
      intent: (hasTimeSignal ? "news" : "general") as SearchDecision["queries"][number]["intent"],
    },
  ];
  for (const u of urls.slice(0, 3)) {
    queries.push({ query: u, intent: "general" });
  }
  return {
    decision: {
      // SEARCH-BY-DEFAULT: the rules fallback always searches. The no-
      // search path is reserved for the trivial-greeting short-circuit
      // above — a junk search is far cheaper than a confidently-wrong
      // live-facts answer.
      search_required: true,
      reason: "rule-based search-by-default plan (main model unreachable)",
      freshness: hasTimeSignal ? "day" : hasVersion ? "month" : "any",
      depth: "standard",
      queries,
    },
    source: "rules",
    gateMs: 0,
  };
}

function noSearchPlan(reason = "trivial prompt — no web content needed"): SearchGateResult {
  return {
    decision: {
      search_required: false,
      reason,
      freshness: "none",
      depth: "quick",
      queries: [],
    },
    source: "rules",
    gateMs: 0,
  };
}

/* ── LLM call (main model ONLY) ───────────────────────────────────────── */

/**
 * Thinking-model safety: the body always carries `reasoning_effort: "none"`
 * (THINKING_OFF_BODY) so a thinking backend cannot burn its whole budget
 * into `reasoning_content` and return `content: null`. We still recover a
 * JSON verdict from BOTH fields.
 */
import { THINKING_OFF_BODY } from "./llm-json";

// Part-10 (universal search pre-gate): replaces the old SEARCH-BY-DEFAULT
// policy. Byte-identical to the Rust MAIN_GATE_SYSTEM_PROMPT. The decision
// standard is staleness-aware: the model judges whether a fact may have
// CHANGED, and the "Current date: …" line prepended by
// buildMainGateMessages grounds that judgment in the real runtime clock.
const MAIN_GATE_SYSTEM_PROMPT = `You are the search router for your own answering pipeline.
Your parametric knowledge may be STALE. Use the current date at the top of
this message when interpreting words such as latest, current, today,
recent, this year, newest, supported, available, price, version, office
holder, release, schedule, law, regulation, or status — and whenever you
decide whether a fact may have changed since your training.

DECISION STANDARD: ask "Does answering this accurately REQUIRE information
outside the conversation and local evidence that may be current, changing,
or unknown?" — NOT "could web search possibly help?".

Search when:
- the answer depends on facts that may have changed since training
  (versions, releases, prices, office holders, laws, regulations,
  schedules, availability, status, news, sports results);
- external verification materially affects correctness;
- the user explicitly asks to search, fact-check, or verify.

Do NOT search when:
- the task transforms content the user provided (summarize, translate,
  rewrite, proofread, shorten, explain, review, or fix supplied code,
  logs, or text);
- it is ordinary writing, generic coding the prompt already defines, or
  pure math;
- debugging follows from code, logs, or attachments the user supplied;
- the question concerns an established concept, definition, or how-to
  whose answer does not change;
- the conversation or an attached document already supplies the evidence.

For genuinely ambiguous middle cases: if the answer could plausibly have
changed since training, search; otherwise answer without searching.

Answer with ONLY valid JSON:
{"search_required": boolean, "reason": string,
 "freshness": "none"|"day"|"week"|"month"|"year"|"any",
 "depth": "quick"|"standard"|"deep",
 "queries": [{"query": string, "intent": "general"|"news"|"docs"|"code"|"academic"|"forum", "preferred_domains"?: string[]}]}

Query rules (only when search_required = true):
- 2-4 queries. KEYWORD FORM, not full sentences. Never paste the user's
  question or an operational instruction (e.g. "read this file and reply
  YES") as a query; never write a query that is only stopwords or generic
  phrasing.
- Anchor every query on the concrete entities of the request (names,
  numbers, products, places) plus at most one topic word.
- Example good: ["NVIDIA stock price", "NVDA share price today"].
  Example bad: ["What is the minimum number of cuts needed to partition
  the string so that each part is a palindrome"].
- Use the user's exact terminology for proper nouns and version numbers.
- Prefer official/primary sources: when the authoritative source is
  obvious for a version, release, doc set, price, or office-holder fact,
  set preferred_domains to it (e.g. oracle.com, openjdk.org, nodejs.org,
  python.org, official project docs or repositories).
- freshness: "day" for same-day facts, "week"/"month"/"year" when the
  fact is time-scoped, "any" otherwise; "none" only with
  search_required = false.
- depth: "quick" single fact, "standard" comparison, "deep" multi-source
  research.
Do NOT add anything else to your output.`;

/**
 * Part-10 (universal search pre-gate): the date the gate reasons about.
 * NEVER hardcoded — tests inject `currentDate` so they never depend on
 * the wall clock; production always falls back to the real runtime clock
 * (UTC, matching Rust's chrono::Utc::now) so staleness questions ("is X
 * still supported?") are judged against the actual present.
 */
function gateCurrentDate(ctx: SearchGateContext): string {
  const d = ctx.currentDate?.trim();
  if (d) return d;
  return new Date().toISOString().slice(0, 10);
}

function buildMainGateMessages(ctx: SearchGateContext): { role: string; content: string }[] {
  const date = gateCurrentDate(ctx);
  const msgs: { role: string; content: string }[] = [
    {
      role: "system",
      content: `Current date: ${date} (year ${date.slice(0, 4)}).\n${MAIN_GATE_SYSTEM_PROMPT}`,
    },
  ];
  if (ctx.history?.length) {
    for (const m of ctx.history.slice(-4)) {
      msgs.push({ role: m.role, content: m.content.slice(0, 300) });
    }
  }
  const prompt = ctx.hasImageAttachment
    ? `${ctx.userPrompt.slice(0, 2000)}\n\n(The user also attached an image/screenshot to this message.)`
    : ctx.userPrompt.slice(0, 2000);
  msgs.push({ role: "user", content: prompt });
  return msgs;
}

function stripAndRepair(raw: string): string {
  let s = raw.trim();
  // Strip thinking/reasoning blocks some backends embed in the payload —
  // terminated or truncated (a thinking model cut off mid-think by
  // max_tokens leaves an orphan open tag; consume to end of output).
  s = s.replace(/<(?:think|thinking)>[\s\S]*?(?:<\/(?:think|thinking)>|$)/gi, "");
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  const braceStart = s.indexOf("{");
  if (braceStart > 0) s = s.slice(braceStart);
  return s;
}

/**
 * Call the main-model gate endpoint and parse the JSON decision.
 * Returns a parsed SearchDecision on success, or null on any of: non-200,
 * timeout, unparseable JSON, or an empty-content + empty-reasoning failure.
 */
async function mainModelGate(ctx: SearchGateContext): Promise<SearchDecision | null> {
  const body: Record<string, unknown> = {
    model: "default",
    messages: buildMainGateMessages(ctx),
    temperature: 0,
    ...THINKING_OFF_BODY,
    // Extra thinking-disables for backends that use a different flag name.
    thinking: { type: "disabled" },
    response_format: { type: "json_object" },
    max_tokens: MAIN_GATE_MAX_TOKENS,
  };

  let content = "";
  let reasoning = "";
  try {
    const res = await fetch(endpoint(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + llmApiKey(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(MAIN_GATE_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn({ status: res.status }, "gate non-200");
      return null;
    }
    const data: any = await res.json();
    const msg = data?.choices?.[0]?.message ?? {};
    content = typeof msg.content === "string" ? msg.content : "";
    reasoning = typeof msg.reasoning_content === "string" ? msg.reasoning_content : "";
  } catch (e: unknown) {
    const err = e as { message: string };
    log.warn({ err: err.message, timeoutMs: MAIN_GATE_TIMEOUT_MS }, "gate unreachable / timeout");
    return null;
  }

  for (const raw of [content, reasoning]) {
    const decision = parseMainGateJson(raw, ctx);
    if (decision) return decision;
  }
  // Silent fallback: the caller (runSearchGate) routes to rulesBasedPlan.
  // No WARN log here — an unparseable verdict from a small local model is
  // expected noise, not an error worth dumping to the terminal.
  return null;
}

/**
 * Parse the main model's combined verdict+plan. A `search_required: false`
 * answer is a first-class outcome — not a failure. Explicit prompt URLs are
 * still force-added.
 */
function parseMainGateJson(raw: string, ctx: SearchGateContext): SearchDecision | null {
  if (!raw || raw.trim() === "") return null;
  for (const cand of [stripAndRepair(raw), raw.trim()]) {
    try {
      const parsed = JSON.parse(cand);
      if (typeof parsed?.search_required !== "boolean") continue;

      if (!parsed.search_required) {
        // Search-by-default re-verify: the model may only veto a search
        // for genuinely self-contained prompts. If the prompt carries an
        // external entity (URL, brand, proper noun, version, time signal,
        // image+lookup intent), the "I can answer from memory" answer is
        // overturned — this is what makes the gate search-by-default in
        // practice, not just in the system prompt.
        const vetoAllowed =
          !promptHasExternalEntity(ctx.userPrompt) &&
          !(ctx.hasImageAttachment && IMAGE_LOOKUP_INTENT_RE.test(ctx.userPrompt));
        if (!vetoAllowed) {
          const urls = extractPromptUrls(ctx.userPrompt);
          const queries: SearchDecision["queries"] = urls.map(
            (u) => ({ query: u, intent: "general" as const }),
          );
          if (queries.length === 0) {
            queries.push({
              query: ctx.userPrompt.replace(/\s+/g, " ").trim().slice(0, 300),
              intent: "general",
            });
          }
          return {
            search_required: true,
            reason: "search-by-default: model veto overturned (external entity present)",
            freshness: "any",
            depth: "standard",
            queries,
          };
        }
        return {
          search_required: false,
          reason: String(parsed.reason ?? "main model: no live web content needed").slice(0, 300),
          freshness: "none",
          depth: "quick",
          queries: [],
        };
      }

      const queries: SearchDecision["queries"] = Array.isArray(parsed.queries)
        ? parsed.queries
            .map((q: any) => ({
              query: String(q?.query ?? "").trim(),
              intent: (["general", "news", "docs", "code", "academic", "forum"].includes(q?.intent)
                ? q.intent
                : "general") as SearchDecision["queries"][number]["intent"],
              ...(Array.isArray(q?.preferred_domains) ? { preferred_domains: q.preferred_domains } : {}),
            }))
            .filter((q: SearchDecision["queries"][number]) => q.query.length > 0)
        : [];

      const urls = extractPromptUrls(ctx.userPrompt);
      for (const u of urls) {
        if (!queries.some((q) => q.query === u)) queries.push({ query: u, intent: "general" });
      }
      if (queries.length === 0) {
        queries.push({ query: ctx.userPrompt.replace(/\s+/g, " ").trim().slice(0, 300), intent: "general" });
      }

      return {
        search_required: true,
        reason: String(parsed.reason ?? "main model: live web content needed").slice(0, 300),
        freshness: (["none", "day", "week", "month", "year", "any"].includes(parsed.freshness)
          ? parsed.freshness
          : "any") as SearchDecision["freshness"],
        depth: (["quick", "standard", "deep"].includes(parsed.depth)
          ? parsed.depth
          : "standard") as SearchDecision["depth"],
        queries,
      };
    } catch { /* try next candidate */ }
  }
  return null;
}

/**
 * Back-compatible entry point (kept for external callers/exports): returns
 * just the decision. `runSearchGate` is the public API that also reports
 * which authority decided.
 */
export async function callLlm(ctx: SearchGateContext): Promise<SearchDecision | null> {
  const main = await mainModelGate(ctx);
  if (main) return main;
  return null;
}

/* ── public API ────────────────────────────────────────────────────────── */

/** Test/CI escape hatch check — the flag was renamed WEB_SEARCH_LFM_DISABLED
 *  → WEB_SEARCH_GATE_DISABLED; the old env name keeps working so existing
 *  unit tests never break. */
export function gateDisabledByEnv(): boolean {
  return (
    process.env.WEB_SEARCH_GATE_DISABLED === "1" ||
    process.env.WEB_SEARCH_LFM_DISABLED === "1"
  );
}

/**
 * THE gate. SEARCH-BY-DEFAULT policy.
 *
 * Precedence:
 *   0. hard bypass (URL / known domain / web intent / image+intent) →
 *      search, 0 ms, source "deterministic", reason "deterministic_url_or_intent"
 *   1. trivial greeting / assistant-identity prompt → no-search, zero tokens
 *   2. main model verdict, re-verified against promptHasExternalEntity —
 *      a model `false` is flipped to `true` whenever an external entity
 *      (brand, URL, proper noun, version, time signal, image+intent) is
 *      present.
 *   3. main model unreachable / unparseable → SEARCH-BY-DEFAULT rules
 *      plan (a junk search is far cheaper than a confidently-wrong
 *      offline answer).
 */
export async function runSearchGate(ctx: SearchGateContext): Promise<SearchGateResult> {
  // Search-by-default override (the Part 1 mandate): unless the prompt is
  // a trivial 1-2 word greeting/chit-chat, the gate NEVER returns
  // search_required=false — a junk search is far cheaper than a
  // confidently-wrong answer on live facts (prices, stock, showtimes,
  // local businesses, versions). The model's role narrows to writing the
  // queries, not to vetoing the search.
  const searchByDefault = !isTrivialPrompt(ctx.userPrompt);

  // Test / CI escape hatch: skip the network call entirely.
  if (gateDisabledByEnv()) {
    const bypass = deterministicHardBypass(ctx);
    const plan: SearchGateResult = bypass
      ? { decision: bypass.decision, source: "deterministic", gateMs: 0 }
      : isTrivialPrompt(ctx.userPrompt)
        ? noSearchPlan()
        : rulesBasedPlan(ctx);
    log.info({ prompt: ctx.userPrompt.slice(0, 40) }, "search gate disabled → deterministic plan");
    return plan;
  }

  // Stage 0: hard bypass — a literal link / known site / live-intent word
  // never waits on (or loses to) a model verdict. 0 ms, zero tokens.
  const bypass = deterministicHardBypass(ctx);
  if (bypass) {
    log.info(
      {
        matched: bypass.hit.matched,
        search_required: bypass.decision.search_required,
        prompt: ctx.userPrompt.slice(0, 60),
      },
      "search gate STAGE 0 hard bypass",
    );
    return { decision: bypass.decision, source: "deterministic", gateMs: 0 };
  }

  // Fast path: trivial prompt → no LLM call, zero tokens.
  if (isTrivialPrompt(ctx.userPrompt)) {
    log.info({ prompt: ctx.userPrompt.slice(0, 40) }, "trivial prompt → skip (no search, zero latency)");
    return noSearchPlan();
  }

  const t0 = performance.now();
  const main = await mainModelGate(ctx);
  if (main) {
    let decision = main;
    // Search-by-default re-verify: a model "no" only holds when the
    // prompt is truly self-contained (no URL / brand / proper noun /
    // version / time signal / image+lookup intent).
    if (!main.search_required && promptHasExternalEntity(ctx.userPrompt)) {
      decision = {
        ...main,
        search_required: true,
        reason: "search-by-default: external entity in prompt — search even though the model vetoed",
        depth: "standard",
        queries: main.queries.length > 0 ? main.queries : buildFallbackQueries(ctx.userPrompt),
      };
    }
    const out: SearchGateResult = {
      decision,
      source: "main-model",
      gateMs: Math.round(performance.now() - t0),
    };
    log.info(
      {
        source: out.source,
        search_required: out.decision.search_required,
        gateMs: out.gateMs,
        overridden: main.search_required !== out.decision.search_required,
      },
      "search gate verdict (main model)",
    );
    return out;
  }

  // Main model failed → SEARCH-BY-DEFAULT: rules-based plan (search
  // required), NOT a no-search fallback. The gate errs on the side of
  // running a search rather than missing live facts.
  log.warn(
    { prompt: ctx.userPrompt.slice(0, 80), gateMs: Math.round(performance.now() - t0) },
    "main model unreachable — search-by-default rules plan",
  );
  return rulesBasedPlan(ctx);
}

/**
 * Build a minimal keyword-form query list from the prompt when the model
 * was unreachable or returned none. Used by the search-by-default
 * override and by rulesBasedPlan.
 */
function buildFallbackQueries(prompt: string): SearchDecision["queries"] {
  const urls = extractPromptUrls(prompt);
  const out: SearchDecision["queries"] = urls.slice(0, 3).map((u) => ({ query: u, intent: "general" }));
  const hasTimeSignal = /latest|recent|new|current|today|this (week|month|year|quarter)/i.test(prompt);
  out.unshift({
    query: prompt.replace(/\s+/g, " ").trim().slice(0, 300),
    intent: (hasTimeSignal ? "news" : "general") as SearchDecision["queries"][number]["intent"],
  });
  return out;
}

/**
 * Regression-test surface: the main-gate messages are exported so tests can
 * assert on what the classifier actually sees.
 */
export function buildMainGateMessagesForTest(ctx: SearchGateContext): { role: string; content: string }[] {
  return buildMainGateMessages(ctx);
}
