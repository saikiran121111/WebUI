/**
 * EVIDENCE-NEED gate (2026-11-04 repair, brief §1/§2) — the decision
 * standard is "does a reliable answer REQUIRE information outside the
 * conversation and local evidence that may be current or changing?" —
 * NOT "could a search possibly help?" and NOT "search-by-default".
 * No brand→domain tables, no bare-token keyword triggers (today/current/
 * latest/price/video are NOT search instructions on their own), no
 * growing greeting whitelist, no model-verdict overturns.
 *
 * Decision flow:
 *   0. Deterministic hard bypass — all detectors evaluate the CURRENT
 *      INSTRUCTION ONLY (quoted prose, inline code and fenced code are
 *      stripped first, so a URL literal inside code the user pasted
 *      cannot start a search):
 *        FORCE-NO skip layers (evaluated FIRST, escape-guarded):
 *          E1 explicit local-only scope (residual re-test is the guard);
 *          clock questions ("what is today's date?") — the request
 *             carries a live server clock;
 *          E2 supplied-material transforms, prompt-defined code-gen,
 *             creative writing, pure arithmetic.
 *        FORCE-YES evidence layers (instruction scope):
 *          URL/domain literals in the instruction; explicit search/
 *          browse/verify frames; research frames (find + studies/
 *          citations/sources); navigation frames (open/read a link,
 *          watch/stream a live event); narrow high-confidence freshness
 *          shapes (still supported, up to date, most recent, office
 *          holder, latest version/release, latest news, how much…cost);
 *          image attachment + lookup intent.
 *        The boolean attachment flag NEVER forces a verdict: attachment
 *        presence is not evidence sufficiency — the model gate is told
 *        local evidence exists and that attached material does not
 *        supply external/current facts.
 *      Undecided → the model gate decides.
 *   1. Trivial greetings / assistant-identity chit-chat → NO-SEARCH
 *      (zero tokens; temporal adverbs are normalized away before the
 *      fixed-set check — "what are you doing today" is the same chit-
 *      chat as "what are you doing", no whitelist growth).
 *   2. Main-model gate (one JSON call, 35s ceiling). A model
 *      `search_required=false` is a FIRST-CLASS outcome — the old
 *      "external entity present" overturn (promptHasExternalEntity) was
 *      removed: capitalization, proper nouns, versions and bare time
 *      words are not search instructions.
 *   3. Main model unreachable / unparseable → `rulesBasedPlan()` applies
 *      the SAME semantic standard deterministically: it searches only
 *      when a force-YES evidence shape is present; small talk and static
 *      explanations get a safe local no-search. A model outage must not
 *      turn conversations into engine queries.
 *
 * Authority is exactly ONE model (the main model from settings.json);
 * no separate LFM / secondary router. Historical note: the LFM2.5-1.2B
 * router (:8791) was removed 2026-10-22; lfm-gate.ts was deleted 2026-10-23
 * and replaced by this file. The search-by-default inversion it encoded
 * (veto re-verify + always-search rules fallback) was removed 2026-11-04.
 */
import { childLogger } from "@/lib/server/logger";
import { llmApiUrl, llmApiKey } from "@/lib/server/settings";
import {
  SearchGateResult,
  SearchGateContext,
  SearchDecision,
} from "./types";
import { detectUrlsAndDomains, detectPromptUrls, type DetectedUrl } from "./url-detector";
import { isEnforceableScope, scopeHosts } from "../decision/task-scope";
import { localContextLine } from "./local-context";

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
    // Brief §B evidence-basis contract: a no-search verdict must name WHY
    // no evidence is needed. Conditional ("required only when
    // search_required=false") is not expressible in this flat schema —
    // parseMainGateJson enforces it; json_object backends ignore it.
    no_search_basis: {
      type: "string",
      enum: ["local_transform", "code_task", "creative", "math", "stable_general", "available_evidence"],
    },
    freshness: { type: "string", enum: ["none", "day", "week", "month", "year", "realtime", "any"] },
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
  // G01 (2026-11-04 audit): fixed chit-chat family completions — small
  // talk must not reach freshness/model arbitration. This is a closed
  // set, not a growing greeting whitelist.
  "how are you doing", "how are you feeling", "how do you feel",
  "how's it going", "how is it going", "what's up", "what is up",
]);

const TRIVIAL_FILLER_PREFIX = /^(?:by the way|so|anyway|then|oh|hmm|hi|hey|hello|thanks|thank you)\s+/i;

// (2026-11-04 brief §1) Temporal adverbs are normalized AWAY before the
// fixed-set check instead of growing the set with "…today" variants:
// "what are you doing today" is the same chit-chat as "what are you
// doing". This is normalization, not a whitelist — and it never weakens
// freshness: "what's the weather today" strips to "what's the weather",
// which is NOT in the set, so the freshness layer still force-YESes.
const TRIVIAL_TEMPORAL_SUFFIX = /\s+(?:today|tonight|right now|now|currently|at the moment)$/i;

function isTrivialPrompt(prompt: string): boolean {
  let p = prompt.trim().toLowerCase();
  p = p.replace(/[.!?…\s]+$/, "");
  p = p.replace(TRIVIAL_TEMPORAL_SUFFIX, "");
  if (TRIVIAL_EXACT.has(p)) return true;
  const peeled = p.replace(TRIVIAL_FILLER_PREFIX, "");
  if (peeled !== p && TRIVIAL_EXACT.has(peeled)) return true;
  return false;
}

/**
 * Instruction scope (2026-11-04 brief §1/§3): deterministic detectors read
 * the CURRENT INSTRUCTION only. Fenced code, inline `code` spans and
 * double-quoted prose are content the user supplied — a URL literal inside
 * code, a quoted live-sounding word ("the price is high today") or a pasted
 * release note is NOT a search instruction. The model gate still sees the
 * full message; only the deterministic arms use this scope.
 * shortcut: quote-pair stripping is best-effort (an odd number of quotes
 * leaves the tail visible); upgrade trigger = a real chat message whose
 * unbalanced quoting flips a verdict, which the model gate then covers.
 */
function instructionScope(p: string): string {
  let s = p.replace(/```[\s\S]*?```/g, " ").replace(/~~~[\s\S]*?~~~/g, " ");
  s = s.replace(/`[^`\n]+`/g, " ");
  s = s.replace(/"[^"\n]*"/g, " ");
  // G04 (2026-11-04 audit): U+201D ” was MISSING from the curly classes, so
  // “quoted live-sounding text” stayed visible to the deterministic
  // detectors. shortcut: only the common curly pairs are handled; upgrade
  // trigger = a real message using an exotic quote pair that flips a verdict.
  s = s.replace(/[“”‟″„][^“”‟″„]*[“”‟″„]/g, " ");
  return s;
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
 * The 2026-11-04 evidence-need chain (brief §1/§2/§3), evaluated on the
 * INSTRUCTION SCOPE (quoted prose / code stripped — see instructionScope):
 *
 *   FORCE-NO skip layers (evaluated FIRST; each is escape-guarded — an
 *   escape means "fall through", never "force YES"):
 *     E1 local-only scope — the user EXPLICITLY scoped the turn to local
 *        evidence ("do not search the web", "answer only from the
 *        attached…", "…, nothing else"). The residual re-test IS the
 *        guard: "don't search — what's the latest version?" keeps a
 *        freshness frame outside the negation and falls through. Bare
 *        URL literals are NOT re-tested here: "Do not search the web.
 *        Count the characters in https://example.com." stays NO.
 *     CLOCK — a direct date/time/day question ("what is today's date?")
 *        is answered from the live server clock; searching cannot make
 *        the clock more correct.
 *     E2 local-task arms — supplied-material transforms (SUPPLIED_TASK_RE),
 *        prompt-defined code-gen (CODEGEN_RE), creative writing
 *        (CREATIVE_RE), pure arithmetic (MATH_RE). The guard tests the
 *        prompt with the matched task clause ITSELF removed, so artifact
 *        nouns inside the clause ("Summarize this news article.") cannot
 *        trigger their own guard, while a genuinely external second
 *        clause ("…; check the web for slang usage") escapes.
 *
 *   FORCE-YES evidence layers (instruction scope):
 *     URL — any http(s):// or bare domain the tldts detector finds in the
 *        instruction. (The old KNOWN_SITE/DOMAIN_TLD/WWW token regexes were
 *        DEAD code — the detector already covered them — and the known-
 *        site brand list violated the no-brand-tables law, so all three
 *        are deleted.)
 *     WEB_INTENT — explicit search frames (search the web / search for /
 *        google it / look up / look online / check the web / browse the
 *        web / who won), navigation frames (open|read|visit a link|page|
 *        article; watch|stream a video|livestream|keynote|launch event)
 *        and research frames (find + studies|citations|sources|papers).
 *        BARE tokens (today/current/latest/price/video/watch) are NOT
 *        search instructions — that bare-token list was the false-positive
 *        engine the brief retires.
 *     FRESHNESS — narrow high-confidence time-sensitive shapes only
 *        (weather, how much…cost, still supported/true, up to date, most
 *        recent, as of now, this week/month/year, who is the <office
 *        holder>, current|latest version|release, latest…news, open
 *        positions|job listings, price…right now).
 *     IMAGE — image attachment + lookup intent.
 *
 * The attachment flag is NOT a layer: attachment presence is not evidence
 * sufficiency (brief §3) — attached material supports transforms of itself
 * and never supplies external/current facts, so undecided attachment
 * turns reach the model gate, which is told the local-evidence situation.
 *
 * Ordering law (replaces "FRESHNESS NEVER LOSES", 2026-11-04): skip →
 * clock → url → web intent → freshness → image. A local task containing a
 * freshness WORD ("Write a poem about the weather.", "Rewrite this
 * paragraph: Our latest release is ready.") stays force-NO — the word is
 * not an evidence request; a contradictory local-only turn escapes via
 * the E1 residual guard, and any surviving explicit frame still force-
 * YESes in the second half of the chain.
 */

/**
 * Explicit web-search frames (universal — frames, never bare nouns).
 * "search for" is an explicit search VERB frame; "binary search." carries
 * no frame ("search" not followed by a search-object frame).
 */
// H01 (2026-11-04 audit): "search in google for that" / "through search" /
// "do a search" carried no frame. Engine names here are SEARCH-FRAME
// vocabulary (how people name the act of searching), never subjects — the
// no-brand-tables law bans site names acting as answer targets, not frame
// words. Provider names only ever pair with a search VERB.
const SEARCH_FRAME_RE =
  /(?:\bsearch(?:es|ing|ed)?\s+(?:the\s+)?(?:web|internet|online)\b|\bsearch(?:es|ing|ed)?\s+for\b|\b(?:web|google|internet|bing)\s+search(?:es|ing)?\b|\b(?:google|bing)\s+(?:it|that|this)\b|\bsearch(?:es|ing|ed)?\s+(?:in|on|through|using)\s+(?:google|bing|duckduckgo|brave|yandex|the\s+web|the\s+internet|a\s+search\s+engine|search\s+engine)\b|\bthrough\s+(?:a\s+|the\s+)?search\b|\b(?:do|does|perform|conduct|run|execute)\s+(?:a\s+|the\s+|some\s+)?search(?:es)?\b|\blook\s?up\b|\blook\s*online\b|\bcheck\s+(?:the\s+|for\s+)?(?:web|online|internet)\b|\bbrowse\s+(?:the\s+)?(?:web|internet|online)\b)/i;

/**
 * Navigation frames — the user points at a live-web object to open or
 * watch. Generic nouns only (no brand names): "watch this video",
 * "stream the keynote", "read that article". Attachment self-references
 * are neutralized by webIntentProbe BEFORE this fires, so "Read the text
 * burned into the attached video" never masquerades as navigation.
 */
const NAV_RE =
  /(?:\b(?:open|read|visit|load|check\s+out|go\s+to|pull\s+up|click(?:\s+on)?)\b[^.!?]{0,24}?(?:this|that|the|a|an|following|his|her|their|its)\s+(?:[\w'-]+\s+){0,2}?(?:link|url|page|website|site|web\s*page|article|blog\s*post|post|profile)\b|\b(?:watch|stream)\b[^.!?]{0,24}?(?:this|that|the|a|an)?\s*(?:livestream|live\s*stream|webcast|webinar|keynote|launch\s+event|press\s+conference|ceremony|concert|game|match|broadcast|video|videos|clip|trailers?))/i;

/** Research frames — an explicit request for external EVIDENCE. */
const RESEARCH_RE =
  /\b(?:find|locate|gather|cite|look\s+for|searched)\b[^.!?]{0,48}?\b(?:peer-reviewed|studies|citations?|sources|references|papers|literature|news\s+coverage)\b/i;

/**
 * Source-attribution frame (brief root cause 1 — "…from their
 * documentation" / "in …'s guidelines"): the request ATTRIBUTES the answer
 * to an external document family, an evidence need with NO magic search
 * word. Universal grammar, no entity tables: attribution preposition +
 * (possessive 's | their | its) + document-kind noun, up to two descriptor
 * words deep ("PM-KISAN guidelines"). "doument" (a real user typo) rides
 * the fuzzy `dou\w*ment` stem — ONE fuzzy pattern, not a growing word
 * list. shortcut: typos that alter the stem itself are missed; upgrade
 * trigger = an attribution noun the model gate then has to cover (the
 * basis contract makes a blind model NO on it invalid anyway).
 * "about"/"with"/"against" are deliberately NOT attribution prepositions —
 * attachment guardrails ("Compare this PDF with the latest regulations.")
 * must stay undecided, and "from NVIDIA?" has no possessive + noun frame.
 * Attachment self-refs are neutralized by webIntentProbe BEFORE this is
 * tested ("the attached document" → stripped; and no possessive frame).
 */
const DOC_NOUN =
  "documents?|documentation|dou\\w*ment|docs?|manuals?|guides?|guidelines?|specs?|specifications?|reports?|catalogs?|catalogues?|faqs?|polic(?:y|ies)|terms(?:\\s+of\\s+(?:service|use))?|announcements?|websites?|sites?|homepages?|white\\s?papers?|handbooks?|brochures?|press\\s+releases?|blog\\s+posts?";
const ATTRIBUTION_RE = new RegExp(
  `\\b(?:from|in|according\\s+to|per|based\\s+on|stated\\s+in|via)\\b[^.?!\\n]{0,60}?(?:'s|’s|their|its)\\s+(?:[\\w'’-]+\\s+){0,2}?(?:${DOC_NOUN})\\b`,
  "i",
);

/**
 * Enumerable-catalog ask (brief root cause 1): "which/what … does <entity>
 * support|offer|provide…" demands the COMPLETE list the entity itself
 * defines — a topical explanation can never answer it, so retrieval is
 * required for unknown entities. The blocklist after the modal is
 * GRAMMATICAL (pronouns, demonstratives, articles) — not an entity table:
 * "What does this function do?" stays undecided (local code), "Which
 * foundation models does ArborWorks support?" force-YESes. Bare
 * do/run/use as the main verb are excluded so ordinary local code
 * questions ("What does this class use?") never arm a search.
 */
const CATALOG_ASK_RE =
  /\b(?:which|what)\b[^.?!\n]{0,50}?\b(?:does|do|did|can|will|could)\s+(?!(?:this|that|these|those|it|its|the|a|an|my|our|his|her|their|your|he|she|they|we)\b)[^.?!]{0,40}?\b(?:supports?|support(?:ed|ing)?|offers?|offer(?:ed|ing)?|provides?|providing|hosts?|hosting|includes?|including|integrat(?:e|es|ed|ing)|features?|featuring|ships?|shipping|lists?|listing|accepts?|accepting)\b/i;

/** Force-YES web-intent = search ∪ navigation ∪ research ∪ attribution ∪
 *  catalog-ask ∪ who-won. (Attribution and catalog-ask ride the SAME
 *  web_intent tag: the maintained matrices only assert their own tags,
 *  and one force-YES family keeps the guard union coherent.) */
/* WS02 (audit 2026-11-05, explicit-verify arm): an explicit "external /
 * independent + evidence-noun" phrase is an evidence NEED even when the
 * verb is "verify" (adding bare verify to the frames would resurrect the
 * boundary-acknowledgment escape — "state that you cannot verify it").
 * Adjacency-locked so the nouns only count inside the frame. */
const EXTERNAL_EVIDENCE_RE =
  /\b(?:external|independent)\s+(?:sources?|evidence|verification|confirmation|validation|corroboration)\b/i;

const WEB_INTENT_RE = new RegExp(
  `(?:${SEARCH_FRAME_RE.source})|(?:${NAV_RE.source})|(?:${RESEARCH_RE.source})|(?:${ATTRIBUTION_RE.source})|(?:${CATALOG_ASK_RE.source})|(?:${EXTERNAL_EVIDENCE_RE.source})|\\bwho\\s+won\\b`,
  "i",
);

/**
 * Escape guard for the force-NO skip layers. Broader than the force-YES
 * frames on purpose — a false escape only returns the turn to the model
 * gate, it never forces a search. EXTERNAL_NEED covers hybrid supplied-
 * material turns that ask for CURRENT information ("find the latest
 * information about the company") without being a force-YES freshness
 * shape by themselves.
 */
const EXTERNAL_NEED_RE =
  /\b(?:find|look\s+for|check|see|compare)\b[^.!?]{0,30}?\b(?:latest|current|newest|up[\s-]?to[\s-]?date)\b[^.!?]{0,20}?\b(?:information|news|updates?|regulations?|listings?|positions?|prices?|versions?|releases?)\b/i;
const GUARD_EXTERNAL_RE = new RegExp(
  `(?:${SEARCH_FRAME_RE.source})|(?:${NAV_RE.source})|(?:${RESEARCH_RE.source})|(?:${ATTRIBUTION_RE.source})|(?:${CATALOG_ASK_RE.source})|(?:${EXTERNAL_NEED_RE.source})` +
    // `sources?` carries an EXTERNAL-citation sense ("cite your sources");
    // it must not fire as an artifact descriptor — "source file"/"source
    // code" name the supplied material itself (false-escape fix, 2026-11-04:
    // "Find the bug in this attached source file." escaped the supplied arm
    // on the word "source"). The lookahead keeps "find sources for this"
    // and "verify against other sources" escaping normally.
    `|\\b(?:website|online|internet|sources?(?!\\s+(?:code|files?\\b))|citations?|studies|peer-reviewed|papers?|references?|verify|fact[\\s-]?check|news|research|google)\\b` +
    `|\\bup[\\s-]?to[\\s-]?date\\b|\\bstill\\s+(?:true|accurate|valid|current|available|maintained|supported)\\b`,
  "i",
);

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
 * (Historical: the ruke-websearch crate carried re_media_self_ref /
 * re_attach_anaphora / web_intent_probe mirrors; the crate was removed
 * 2026-11-03 and THIS file is the sole owner — no Rust edit is required
 * when these probe regexes change.)
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

/* ── universal search pre-gate regexes ──────────────────────────────────
 * (The attachment escape-hatch EXPLICIT_WEB_INTENT_RE was retired
 * 2026-11-04 with the attachment force-NO layer: the boolean attachment
 * flag is not evidence sufficiency, and GUARD_EXTERNAL_RE above is the
 * one shared escape for every skip layer.) */
// (Historical: these bodies were byte-identical mirrors of the Rust
// re_freshness / re_local_only / re_supplied_task / re_codegen / re_math.
// The ruke-websearch crate was removed 2026-11-03 — the Rust twins no
// longer exist and THIS file is the sole owner. grep rust-backend for
// re_freshness before assuming any lock-step edit is required: none is.)

/** Force-YES freshness — high-confidence, NARROW time-sensitive shapes.
 *  Bare "latest"/"current"/"today"/"price" are NOT here (that bare-token
 *  list was the false-positive engine: "Write a poem about the weather."
 *  and "Rewrite this paragraph: Our latest release is ready." must stay
 *  local). Only frames where the ASK itself needs present-day data:
 *  weather, how-much…cost, still-supported, up-to-date, most-recent,
 *  as-of-now, this-week/month/year, office-holder identity, version/
 *  release freshness, latest-…-news, open positions / job listings,
 *  price…right now. Office-holder nouns only match inside the
 *  "who is/are the …" frame. G02 price frame at the tail below.
 *  G01 (2026-11-04 audit): bare "currently" is REMOVED from the head — a
 *  temporal adverb is not an evidence request ("What are you currently
 *  doing?" was small talk force-YESed). "currently" still counts inside
 *  the price frames below, and the trivial-layer temporal normalization
 *  already handles trailing adverbs ("…doing today").
 *  G02 (fallback coverage): the current/latest + price-family frame now
 *  fires WITHOUT an explicit "today/right now" tail — an outage fallback
 *  that misses a plain price ask is the regression this closes. */
const FRESHNESS_RE =
  /(?:\b(?:weather|forecast)\b|\bhow\s+much\b[^.!?]{0,40}?(?:\bcosts?\b|\bprice\b|\bworth\b)|\bthis\s+(?:week|month|year)\b|\bmost\s+recent\b|\bas\s+of\s+now\b|\bup[\s-]?to[\s-]?date\b|\bstill\s+(?:supported|available|maintained|true|accurate|valid|current)\b|\bwho\s+(?:is|are)\s+the\s+(?:ceo|president|mayor|governor|chairman|director|coach|captain)\b|\b(?:current|latest)\s+(?:version|release)\b|\blatest\b[^.!?]{0,14}?\bnews\b|\bnews\b[^.!?]{0,14}?\blatest\b|\b(?:recent|breaking)\s+news\b|\bnews\s+(?:about|on|regarding)\b|\bopen\s+(?:[\w'-]+\s+){0,3}?(?:positions?|jobs?|roles?|vacancies)\b|\bjob\s+(?:listings?|openings?)\b|\b(?:prices?|costs?)\b[^.!?]{0,30}?\b(?:today|now|right now|currently)\b|\b(?:right now|today|currently)\b[^.!?]{0,30}?\b(?:prices?|costs?)\b|\b(?:current|latest)\b[^.!?]{0,24}?\b(?:prices?|costs?|salary|salaries|fees?|fare|fares)\b|\b(?:job|jobs|positions?|hiring)\b[^.!?]{0,20}?\b(?:open|available|listings?|vacanc\w*)\b|\b(?:application|portal|service|website|system|platform)\b[^.!?]{0,24}?\b(?:operational|accepting|receiving|offline|outaged?)\b|\b(?:is|whether|check)\b[^.!?]{0,24}?\boperational\b)/i;

/** Layer E1 — the user EXPLICITLY scoped the turn to local evidence.
 *  WS02 (audit 2026-11-05): `browsing?`/`googling?` were defects — the `?`
 *  only optionals the trailing "g", so the plain verbs NEVER matched and
 *  "Do not browse. What is the current milk price?…" force-YESed on
 *  freshness. The existing "Don't browse; only from the attached…" pin hid
 *  it (that arm matched the ATTACHED clause, not the prohibition).
 *  `brows(?:e|ing)?` / `googl(?:e|ing)?` parse the actual verbs. */
const LOCAL_ONLY_RE =
  /(?:\b(?:do not|don't|dont|no)\s+(?:web\s+)?(?:search|brows(?:e|ing)?|googl(?:e|ing)?|looking\s+online)\b|\bwithout\s+(?:searching|browsing)\b|\b(?:only|just)\s+(?:from|based on|using)\s+(?:the\s+)?(?:attached|provided|supplied|uploaded|pasted|given)\b|\b(?:answer|respond|reply)\s+based on\s+(?:the\s+)?(?:attached|provided|supplied|uploaded|pasted|given)\b|\banswer\s+(?:only|strictly)\s+from\b|\buse\s+only\s+the\s+attached\b|\bnothing\s+else\b)/i;
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
  // 2026-11-04 brief §3: verb→demonstrative gap widened {0,25}→{0,40} so
  // "Summarize the latest paragraph in the attached document." reads as
  // the transform of SUPPLIED material that it is (the intervening words
  // describe WHICH supplied material — they are not an external-need frame).
  /(?:\b(?:summar(?:y|ize|ise)|translat(?:e|ion)|rewrite|paraphrase|shorten|proofread|fix|correct|review|refactor|debug|annotate|explain|clarify|improve|convert|extract|listen|hear)\b[^.!?]{0,40}?(?:this|these|my|attached|supplied|uploaded|pasted|provided)\b[^.!?]{0,20}?(?:code|file|text|log|logs|pdf|doc|docs|document|documents|paragraph|snippet|function|screenshot|image|essay|article|script|trace|error|message|conversation|table|data|json|csv|resume|letter|contract|draft|passage|chat|audio|video|recording|clip|footage|transcript|voice|speech)|\bwhat(?:'s|\s+is)\s+wrong\s+with\b|\bfind\s+the\s+(?:bug|issue|problem)\s+in\b|\bread\s+(?:this|the|an?)\s+(?:attached\s+)?(?:file|code|text|log|pdf|attachment|audio|video|recording|clip|transcript)\b)/i;

/** Layer E2 — code-writing tasks fully defined by the prompt itself. */
const CODEGEN_RE =
  /\b(?:write|create|generate|give me|produce|implement)\b[^.!?]{0,30}?\b(?:code|function|component|script|program|class|regex|sql|hook|snippet|unit tests?)\b/i;

/** Layer E2 — pure arithmetic ("what is 15 * 17?", "solve 25 * 47"). */
const MATH_RE =
  /(?:\b(?:what(?:'s|\s+is)|solve|calculate|compute)\b[^.!?]{0,12}?\d+\s*[-+*/xX]\s*\d+)/i;

/** Layer E2 — creative writing: the content comes FROM the model, not
 *  from the web ("Write a poem about the weather." — the weather is a
 *  THEME, not an evidence request). Escape-guarded like every skip arm. */
const CREATIVE_RE =
  /\b(?:write|compose|invent|make\s+up|draft)\b[^.!?]{0,40}?\b(?:poem|story|stories|essay|haiku|song|lyrics|tale|fiction|novel|joke|limerick|sonnet|screenplay|paragraph|tweet|caption)\b/i;

/** Pure clock question (brief §5): a direct date/time/day request is
 *  answered from the live server clock — retrieval cannot make the clock
 *  more correct. Sentence-ANCHORED so "What's the date of the release?"
 *  (an external fact) never matches. */
const CLOCK_ASK_RE =
  /^(?:what(?:'s| is)? (?:the |today'?s )?(?:current )?(?:date|time|day of the week)(?: (?:is it|is today|today|tonight|now|for today))?|what day is it(?: today| today'?s)?|what day (?:is|was) it|(?:please )?tell me (?:the )?(?:current )?time(?: please)?)[?.!]*$/i;

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
    | "web_intent"
    | "image_intent"
    | "freshness"
    | "clock_question"
    | "local_task";
  /** tldts-detected URLs/bare-domains (normalised https:// form). */
  detected: DetectedUrl[];
}

/* ── gate query language (§4): Unicode-preserving, subject-anchored ──── */

const GATE_FILLER = new Set([
  "tell", "me", "what", "is", "the", "a", "an", "i", "want", "to", "so",
  "you", "can", "could", "please", "how", "about", "in", "on", "at", "by",
  "for", "from", "with", "that", "this", "these", "those", "there", "here",
  "would", "like", "need", "look", "find", "show", "give", "get", "best",
  "top", "good", "and", "it", "its", "of", "up",
]);
// Trivial temporal adverbs add nothing to an engine query ("…price now").
// "latest" is NOT a stop — it is the subject of "latest version/news".
// shortcut: bare "right" is stopped too (it rides the "right now" frame);
// a literal "right" subject ("right to left rotation") rides on the
// surviving tokens around it.
const GATE_TEMPORAL_STOPS = new Set([
  "today", "tonight", "tomorrow", "yesterday", "now", "right", "currently",
]);

/**
 * §4 Unicode law: the OLD keyword builder did `.replace(/[^a-z0-9\s]/g," ")`
 * — Devanagari, CJK, é and ₹ were all ERASED, so "東京で牛乳 price today"
 * searched as "price". This tokenizer keeps every script (\p{L}\p{N}\p{M},
 * NFC-normalized) and preserves exact identifiers; case is the only thing
 * normalized. ASCII output is byte-identical to the old class for normal
 * words.
 */
const GATE_TOKEN_RE = /[\p{L}\p{N}\p{M}][\p{L}\p{N}\p{M}'’_-]*/gu;

function gateTokenize(text: string): string[] {
  return (text.normalize("NFC").match(GATE_TOKEN_RE) ?? [])
    .map((t) => t.toLowerCase().replace(/^['’_-]+|['’_-]+$/g, ""))
    .filter((t) => t.length > 0);
}

/**
 * §4 subject preservation: a subjectless follow-up ("What is its price
 * now?") borrows its subject from the most recent USER turn — never from
 * assistant prose (history entries here are role-filtered by contract),
 * never from hidden instructions, secrets, or attachment bodies. Quoted
 * prose/code inside that turn is stripped by instructionScope first.
 */
function subjectAnchor(ctx: SearchGateContext): string {
  const hist = ctx.history ?? [];
  for (let i = hist.length - 1; i >= 0; i--) {
    const m = hist[i];
    if (m.role !== "user") continue;
    const toks = gateTokenize(instructionScope(m.content)).filter(
      (w) => w.length > 2 && !GATE_FILLER.has(w) && !GATE_TEMPORAL_STOPS.has(w),
    );
    if (toks.length === 0) continue;
    return toks.slice(0, 4).join(" ").slice(0, 120);
  }
  return "";
}

/** Keyword form first: search engines index pages, not URL strings — a
 *  URL-as-query returns the domain's homepage. The pipeline's Stage-0
 *  direct-target fetch reads the prompt's own URLs in parallel, so the
 *  keyword query is all the engine pool needs. Subjectless/stopword-only
 *  results return null (§4: reject before dispatch — the OLD fallback
 *  pushed the WHOLE prompt as a query, turning operational instructions
 *  into engine traffic). */
function gateKeywordQuery(
  instr: string,
  ctx: SearchGateContext,
  detected: DetectedUrl[],
): string | null {
  const text = instr.replace(/https?:\/\/[^\s"'<>[\]]+/gi, " ");
  const tokens = gateTokenize(text).filter(
    (w) => w.length > 2 && !GATE_FILLER.has(w) && !GATE_TEMPORAL_STOPS.has(w),
  );
  let keywords = tokens.slice(0, 8).join(" ");
  if (tokens.length <= 1 && detected.length === 0) {
    const anchor = subjectAnchor(ctx);
    if (anchor) keywords = `${anchor} ${keywords}`.trim();
  }
  return keywords.length > 3 ? keywords.slice(0, 300) : null;
}

/** E2 skip arms, evaluated in order; each matched arm ESCAPES when the
 *  prompt with the matched clause itself removed still carries external
 *  evidence need (guard), so artifact nouns inside the clause ("Summarize
 *  this news article.") cannot trigger their own guard. CODEGEN additionally
 *  escapes on a surviving freshness shape ("Write a script that reports the
 *  most recent release." is a program whose ANSWER is live data). */
const SKIP_ARMS: { re: RegExp; extraGuard: RegExp | null }[] = [
  { re: SUPPLIED_TASK_RE, extraGuard: null },
  { re: CODEGEN_RE, extraGuard: FRESHNESS_RE },
  { re: CREATIVE_RE, extraGuard: null },
  { re: MATH_RE, extraGuard: null },
];

/** Returns the bypass verdict (queries pre-filled from the URLs/entities,
 *  zero queries on every force-NO) or null when the message needs the
 *  model to decide. */
export function deterministicHardBypass(
  ctx: SearchGateContext,
): { decision: SearchDecision; hit: HardBypassHit } | null {
  const p = ctx.userPrompt.trim();
  if (!p) return null;
  // Every deterministic arm reads the INSTRUCTION SCOPE: quoted prose,
  // inline code and pasted material are the user's CONTENT — a URL
  // literal inside code, a quoted live-word, or a pasted release note
  // arms nothing (the model gate still sees the full message).
  const instr = instructionScope(p);
  if (instr.trim().length === 0) return null;

  const detected = detectUrlsAndDomains(instr);
  const localArtifact = ctx.hasAttachmentEvidence === true;

  const forceNo = (
    matched: HardBypassHit["matched"],
    reason: string,
  ): { decision: SearchDecision; hit: HardBypassHit } => ({
    hit: { matched, detected: [] },
    decision: { ...localTaskDecision(), reason },
  });

  // ── SKIP LAYER E1 (first, before every force-YES arm) ──
  // The user EXPLICITLY scoped the turn to local evidence. The residual
  // re-test IS the guard: "do not search the web" contains the frame
  // word "search", so the residual (local-only phrases stripped) is
  // re-tested against web-intent frames ONLY.
  // G03 law change (2026-11-04 audit): a bare freshness WORD no longer
  // overrides an explicit prohibition — "Do not browse; is React 18 up
  // to date?" honors the instruction (the user chose the evidence
  // boundary; freshness is a property of the fact, not a search
  // instruction). The residual escape is an explicit WEB-INTENT frame
  // outside the negation ("…, but check the web for the price" / "watch
  // the launch event, nothing else"). Bare URL literals are NOT
  // re-tested: "Do not search the web. Count the characters in
  // https://example.com." is a local character count, not a link. The
  // web-intent probe (media self-refs neutralized) applies to the
  // residual.
  const residual = instr.replace(LOCAL_ONLY_RE_G, " ");
  if (
    LOCAL_ONLY_RE.test(instr) &&
    !WEB_INTENT_RE.test(webIntentProbe(residual, localArtifact))
  ) {
    return forceNo("local_task", "deterministic_self_contained");
  }

  // ── SKIP LAYER: pure clock question (brief §5) ──
  if (CLOCK_ASK_RE.test(instr.trim())) {
    return forceNo("clock_question", "deterministic_clock_question");
  }

  // ── SKIP LAYER E2 arms (universal; NO attachment flag involved) ──
  for (const arm of SKIP_ARMS) {
    if (!arm.re.test(instr)) continue;
    const rest = instr.replace(arm.re, " ");
    const escapes =
      GUARD_EXTERNAL_RE.test(rest) ||
      (arm.extraGuard !== null && arm.extraGuard.test(rest));
    if (!escapes) return forceNo("local_task", "deterministic_self_contained");
    break; // guarded escape: fall through to the evidence layers below
  }

  // ── FORCE-YES evidence layers ──
  // A boolean attachment flag NEVER forces a verdict either way (brief §3):
  // attached material satisfies transforms of itself but never supplies
  // external facts — undecided attachment turns fall through to the model
  // gate, which is told the local-evidence situation.
  let hit: HardBypassHit | null = null;
  if (detected.length > 0) hit = { matched: "url", detected };
  else if (WEB_INTENT_RE.test(webIntentProbe(instr, localArtifact))) hit = { matched: "web_intent", detected: [] };
  else if (FRESHNESS_RE.test(instr)) hit = { matched: "freshness", detected: [] };
  else if (ctx.hasImageAttachment && IMAGE_LOOKUP_INTENT_RE.test(instr)) hit = { matched: "image_intent", detected: [] };
  if (!hit) return null;

  const queries: SearchDecision["queries"] = [];
  const keywords = gateKeywordQuery(instr, ctx, detected);
  if (keywords) queries.push({ query: keywords, intent: "general" });

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
  // §4: a YES verdict with no keyword and no URL cannot dispatch — reject
  // it here (the model gate decides instead) rather than fire stopword
  // junk at the providers.
  if (queries.length === 0) return null;

  // (audit 2026-11-04) Realtime tier is lexical, not brand-scoped:
  // continuously-changing facts (prices, stock levels, weather, scores,
  // open-now, availability, delivery ETAs). Both deterministic paths must
  // agree — rulesBasedPlan now DERIVES from this function, so they cannot.
  const isRealtime =
    /\b(price|prices|pricing|cost|costs|how much|in stock|stock|shares?|weather|temperature|forecast|score|scores|standings?|open now|available|availability|eta|delivery)\b/i.test(instr);
  const isNewsy = /\b(latest|current|news|today|20(?:2[4-9])|who\s+won|jobs|hiring)\b/i.test(instr);
  return {
    hit,
    decision: {
      search_required: true,
      reason: "deterministic_url_or_intent",
      freshness: isRealtime ? "realtime" : isNewsy ? "week" : "any",
      depth: hit.detected.length > 0 ? "deep" : "standard",
      queries,
    },
  };
}

// (2026-11-04 brief §2) `promptHasExternalEntity` — the search-by-default
// re-verify that overturned a confident model NO on capitalized words,
// proper nouns and version numbers ("Explain Binary Search.", "Explain
// Newton's first law.") — is DELETED with its two override sites. A model
// no-search verdict is first-class; evidence-need is decided by the gate
// policy + the deterministic chain above, never by a proper-noun guess.

/* ── deterministic fallback plans (emergency only) ───────────────────── */

/**
 * THE emergency fallback (main model unreachable / unparseable / timeout /
 * gate disabled by env). 2026-11-04 brief §2: the old version ALWAYS
 * searched (the unanchored `new` even matched "Newton") — the search-
 * by-default default is REMOVED. The rules plan now applies the SAME
 * semantic standard as the primary chain: it derives its verdict from
 * deterministicHardBypass, so the two deterministic authorities can
 * never disagree on the same turn. A middle prompt with no explicit
 * evidence shape stays LOCAL on outage (safe local answers, zero
 * downstream traffic) — the bounded deterministic force-YES layers
 * (URL literal, explicit search frame, live-fact freshness) still fire
 * when the turn genuinely requires retrieval.
 */
export function rulesBasedPlan(ctx: SearchGateContext): SearchGateResult {
  const bypass = deterministicHardBypass(ctx);
  if (!bypass || !bypass.decision.search_required) {
    return bypass
      ? noSearchPlan(bypass.decision.reason)
      : noSearchPlan("rule-based plan: no explicit live-evidence shape (main model unreachable)");
  }
  const decision: SearchDecision = {
    ...bypass.decision,
    reason: "rule-based plan: explicit live-evidence shape (main model unreachable)",
  };
  // Task-scope carry (audit 2026-11-02, brief #6): the emergency fallback
  // must NEVER broaden the contract. The scope's VERIFIED hosts ride as
  // preferred_domains on the main query and get site: companions; an
  // unresolved target gets a bounded quoted discovery query (max 2) —
  // never an invented domain.
  const scope = ctx.scope;
  if (scope && isEnforceableScope(scope) && decision.queries.length > 0) {
    const hosts = scopeHosts(scope);
    if (hosts.length > 0) {
      decision.queries[0].preferred_domains = hosts;
      for (const h of hosts.slice(0, 2)) {
        decision.queries.push({
          query: `${decision.queries[0].query} site:${h}`.slice(0, 300),
          intent: "general",
          preferred_domains: [h],
        });
      }
    }
    let discovery = 0;
    for (const t of scope.targets) {
      if (discovery >= 2) break;
      if (t.state === "unresolved" && t.phrase) {
        const phrase = t.phrase.replace(/^["“”']|["“”']$/g, "").trim();
        if (phrase) {
          discovery += 1;
          decision.queries.push({ query: `"${phrase}"`.slice(0, 300), intent: "general" });
        }
      }
    }
  }
  return { decision, source: "rules", gateMs: 0 };
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
// policy. (The "byte-identical Rust MAIN_GATE_SYSTEM_PROMPT" comment was
// stale — the ruke-websearch crate was removed 2026-11-03 and no Rust
// source mirrors this prompt anymore; it is the SOLE owner.) The decision
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
- the conversation or an attached document already supplies the evidence —
  but supplied material never supplies current EXTERNAL facts: a request for
  open positions, citations, peer-reviewed studies, prices, releases or news
  still requires a search no matter what an attachment contains;
- the question only needs the current time, date, or day of the week:
  the request carries a live server clock; answer from the clock.

For genuinely ambiguous middle cases: if the answer could plausibly have
changed since training, search; otherwise answer without searching.

Answer with ONLY valid JSON:
{"search_required": boolean, "reason": string,
 "no_search_basis": required when search_required=false, omitted when
   true — one of "local_transform" (the task transforms content the user
   supplied), "code_task" (the prompt itself defines the code), "creative"
   (writing/art comes from you), "math" (pure computation),
   "stable_general" (an established concept that does not change), or
   "available_evidence" (THIS conversation or an attached document
   already contains the needed evidence). CONFIDENCE IS NOT A BASIS:
   "I know this", "confident from memory" or "unlikely to have changed"
   is not one of the six — if you cannot name one, set
   search_required=true. A request attributed to an external document
   ("from their documentation") or for a complete list an organization
   defines ("which models does X support") has NO valid no-search basis
   unless the document is in this conversation.
 "freshness": "none"|"day"|"week"|"month"|"year"|"realtime"|"any",
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
- freshness: "day" for same-day facts, "realtime" when the fact changes
  minute-to-minute (prices, scores, status pages, "right now" state),
  "week"/"month"/"year" when the fact is time-scoped, "any" otherwise;
  "none" only with search_required = false.
- depth: "quick" single fact, "standard" comparison, "deep" multi-source
  research.
Do NOT add anything else to your output.`;

/**
 * Part-10 (universal search pre-gate): the date the gate reasons about.
 * NEVER hardcoded — tests inject `currentDate` so they never depend on
 * the wall clock. The chat route supplies the SESSION-timezone date
 * (`sessionDateString(turnInstant, turnTimezone)` — the same instant that
 * renders the turn's `<runtime_clock>` block), so the gate and the
 * answering model can never judge "today"/staleness against different
 * calendar dates at the UTC↔session midnight boundary (brief §5). The
 * bare-UTC fallback fires only for direct API callers that pass no
 * `currentDate` (e.g. /api/search, which has no session zone to honor);
 * Rust mirrors the session-zone law in `chat::clock::session_date_string`.
 */
function gateCurrentDate(ctx: SearchGateContext, now: Date = new Date()): string {
  const d = ctx.currentDate?.trim();
  if (d) return d;
  return now.toISOString().slice(0, 10);
}

function buildMainGateMessages(
  ctx: SearchGateContext,
  now: Date = new Date(),
): { role: string; content: string }[] {
  const date = gateCurrentDate(ctx, now);
  const msgs: { role: string; content: string }[] = [
    {
      role: "system",
      content:
        `Current date: ${date} (year ${date.slice(0, 4)}).\n` +
        `${localContextLine(now)}\n${MAIN_GATE_SYSTEM_PROMPT}`,
    },
  ];
  if (ctx.history?.length) {
    for (const m of ctx.history.slice(-4)) {
      msgs.push({ role: m.role, content: m.content.slice(0, 300) });
    }
  }
  const attNote = ctx.hasAttachmentEvidence
    ? "\n\n(The user also attached document/file material to this message. Its contents are SUPPLIED evidence already in view: satisfy summarize/translate/explain/debug requests against it without searching, but attached content never supplies current EXTERNAL facts — open positions, citations, peer-reviewed studies, prices, releases and news still require a search.)"
    : "";
  const imgNote = ctx.hasImageAttachment
    ? "\n\n(The user also attached an image/screenshot to this message.)"
    : "";
  msgs.push({ role: "user", content: `${ctx.userPrompt.slice(0, 2000)}${attNote}${imgNote}` });
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
  // Brief §5: ONE instant for the whole gate call — the currentDate
  // fallback and the local-context line can never disagree with each
  // other mid-call at a midnight boundary.
  const gateNow = new Date();
  const body: Record<string, unknown> = {
    model: "default",
    messages: buildMainGateMessages(ctx, gateNow),
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

/** The six machine-checkable justifications for a no-search verdict
 *  (brief §B). Anything else — including a bare confidence claim — is not
 *  a valid basis and downgrades the verdict to undecided. */
const NO_SEARCH_BASIS = new Set([
  "local_transform",
  "code_task",
  "creative",
  "math",
  "stable_general",
  "available_evidence",
]);

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
        // (2026-11-04 brief §2) A model `false` verdict is FIRST-CLASS:
        // the deterministic chain above already force-YESed every
        // explicit evidence shape (URL literal, search frame, live-fact
        // freshness), so reaching the model with a NO is the designed
        // outcome for conversation/concepts/writing/supplied material.
        // The old promptHasExternalEntity veto (capitalization / proper-
        // noun / version guessing) is deleted — it overturned confident
        // correct answers on "Explain Newton's first law." style turns.
        //
        // (2026-11-04 brief §B evidence-basis contract) The NO must
        // declare WHY no evidence is needed — one of six named bases.
        // "unknown → no evidence needed" is not a basis: a missing or
        // invalid no_search_basis makes the verdict UNPARSEABLE here, so
        // the caller escalates to the rules plan (which force-YESes
        // attribution/catalog shapes and keeps genuine local tasks
        // local). Confidence language is rejected by construction. The
        // basis string NEVER rides SearchDecision — the wire shape stays
        // frozen for cache/web_meta consumers.
        const basis = String(parsed.no_search_basis ?? "").trim().toLowerCase();
        if (!NO_SEARCH_BASIS.has(basis)) return null;
        // WS03 (audit 2026-11-05): a recognized enum is a JUSTIFICATION
        // TYPE, not the justification itself. available_evidence is the one
        // basis claiming the conversation ALREADY HAS the evidence — that
        // claim is machine-checkable against the turn's evidence-carrying
        // context (the same attachment/image flags the retrieval stage
        // keys off). An ungrounded claim is as invalid as a missing basis:
        // the verdict is rejected here and the turn escalates to the rules
        // plan, which force-YESes explicit evidence shapes and keeps
        // genuine local tasks local. The other five bases are prompt-
        // intrinsic (transform/code/creative/math/stable) — no evidence
        // claim to verify.
        if (basis === "available_evidence" && !(ctx.hasAttachmentEvidence || ctx.hasImageAttachment)) {
          return null;
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
      // §4: a YES verdict whose queries all sanitized away is unusable —
      // reject the whole verdict (caller falls to the rules plan, same
      // standard) instead of pasting the user's question back as a query.
      if (queries.length === 0) return null;

      return {
        search_required: true,
        reason: String(parsed.reason ?? "main model: live web content needed").slice(0, 300),
        freshness: (["none", "day", "week", "month", "year", "realtime", "any"].includes(parsed.freshness)
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
 * THE gate. EVIDENCE-NEED policy (2026-11-04 brief §1/§2):
 *
 *   0. hard bypass — skip layers (local-only / pure clock / supplied-
 *      material / codegen / creative / math, each escape-guarded) →
 *      force-NO with ZERO queries; force-YES layers (URL literal,
 *      explicit search/navigation/research frame, narrow freshness,
 *      image+lookup) → force-SEARCH. 0 ms, source "deterministic".
 *   1. trivial greeting / assistant-identity prompt (temporal-adverb
 *      normalized: "what are you doing today" ≡ "what are you doing")
 *      → no-search, zero tokens, ZERO gate model calls.
 *   2. the main model's verdict — FINAL in both directions once a NO
 *      declares a machine-checked evidence basis (brief §B: a missing or
 *      invalid no_search_basis is NOT a valid no-search verdict — the
 *      turn escalates to the rules plan; the basis itself never rides
 *      the SearchDecision wire shape). The gate model is the only model;
 *      there is no second router, no planner, and no deterministic
 *      re-verify that overrides a well-formed NO.
 *   3. main model unreachable / malformed / timeout → rules plan with
 *      the SAME semantic standard (safe local answers; only explicit
 *      evidence shapes search).
 */
export async function runSearchGate(ctx: SearchGateContext): Promise<SearchGateResult> {
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

  // Stage 0: hard bypass — an explicit link / live-evidence frame never
  // waits on a model verdict, and an explicit local scope never spends
  // one. 0 ms, zero tokens.
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
    // The model verdict is FINAL: the deterministic chain already forced
    // every explicit evidence shape, so nothing here re-searches a
    // confident no. (2026-11-04 brief §2: the search-by-default override
    // is deleted; model NO = empty queries = zero downstream traffic.)
    const out: SearchGateResult = {
      decision: main,
      source: "main-model",
      gateMs: Math.round(performance.now() - t0),
    };
    log.info(
      {
        source: out.source,
        search_required: out.decision.search_required,
        gateMs: out.gateMs,
      },
      "search gate verdict (main model)",
    );
    return out;
  }

  // Main model failed (unreachable / malformed / timeout) → rules plan
  // applying the SAME evidence-need standard — NOT always-search. Safe
  // local answers survive an outage; only explicit evidence shapes fire.
  log.warn(
    { prompt: ctx.userPrompt.slice(0, 80), gateMs: Math.round(performance.now() - t0) },
    "main model unreachable — rules plan (same evidence-need standard)",
  );
  return rulesBasedPlan(ctx);
}

/**
 * Regression-test surface: the main-gate messages are exported so tests can
 * assert on what the classifier actually sees.
 */
export function buildMainGateMessagesForTest(ctx: SearchGateContext): { role: string; content: string }[] {
  return buildMainGateMessages(ctx);
}
