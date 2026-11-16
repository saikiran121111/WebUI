/**
 * Task scope — the server-authoritative "which website is this turn about"
 * contract (task-scope audit 2026-11-02, brief items #1, #3, #5, #6).
 *
 * ONE deterministic, pure, server-side interpretation of the user's own
 * words. No network, no model, no brand tables. This module is the single
 * source of operational scope; downstream planner/gate/browser layers
 * ENFORCE it — they never re-derive it, and model tool arguments can never
 * widen it (the only way a bare-name host is filled in is resolveTaskScope()
 * over ranked retrieval candidates the server already fetched).
 *
 * TS ⇔ Rust parity: ruke-server/src/task_scope.rs implements the same
 * tokenizer, word lists, passes, and resolution law; the shared corpus
 * rust-backend/fixtures/task-scope/cases.json pins both ("the corpus is the
 * contract" — same policy as the golden harnesses). Fixtures are ASCII-only;
 * non-ASCII target phrases are a documented limitation.
 *
 * Hard laws (user brief, verbatim intent):
 *  - NO hardcoded website names, brand→domain mappings, preferred TLDs,
 *    or blanket source bans anywhere in this file.
 *  - Explicit URLs/domains resolve via the PSL-aware url-detector ONLY
 *    (this is what kills the site:what.com / blinkitcom.com /
 *    foo.community bug family — no pascal-case brand guessing, no TLD
 *    invention).
 *  - Bare names bound by operational/source prepositions ("order milk on
 *    Zepto", "do this in Blinkit") become UNRESOLVED targets — never a
 *    guessed domain.
 *  - Incidental mentions (reported speech, generic noun phrases, names not
 *    bound by an operational/source preposition) never become scope.
 *  - "operate" / "site_info" / "compare_sites" are the enforceable intents;
 *    "research" targets are topic mentions only — soft research
 *    preferences stay in the existing reranker layer (brief #5), this is
 *    NOT another planner subsystem.
 */
// NAMED-IMPORT LAW (pw-48, 2026-11-03): the `tldts` package exports NO
// default in its browser ESM build — `import tldts from "tldts"` worked
// under Node's CJS interop but left `tldts` undefined in the client
// bundle, so every in-browser registrableHost call threw
// "Cannot read properties of undefined (reading 'parse')" (the omnibox
// search-phrase crash the Phase-6 matrix caught). Named imports resolve
// in BOTH runtimes; never switch these back to a default import.
import { parse as tldtsParse } from "tldts";
import { detectUrlsAndDomains } from "../web-search/url-detector";

// ─── Public contract ────────────────────────────────────────────────────────

export type TaskIntent = "none" | "research" | "site_info" | "operate" | "compare_sites";
export type TargetState = "unresolved" | "resolved" | "ambiguous";
export type TargetProvenance =
  | "none"
  | "explicit_url"
  | "explicit_domain"
  | "resolved_search"
  | "resolved_cache"
  | "ambiguous";

/** Key order is the serialization contract (fixture byte-parity; mirror in Rust). */
export interface SiteTarget {
  /** Verbatim phrase from the user (case, spacing, punctuation preserved). */
  phrase: string;
  state: TargetState;
  /** Verified registrable host (PSL), "" when unresolved/ambiguous. */
  host: string;
  /** Exact verified URL when one was seen, "" otherwise. */
  url: string;
  /** Candidate hosts when ambiguous (distinct, sorted, capped). */
  candidates: string[];
  provenance: TargetProvenance;
}

export interface TaskScope {
  intent: TaskIntent;
  targets: SiteTarget[];
  /** Phrases the user explicitly excluded ("don't use reddit"). */
  excludedPhrases: string[];
  /** Extra hosts the user authorized (auth/pay hops), never primary targets. */
  authorizedHosts: string[];
}

/**
 * Site-specific scopes: their RESOLVED destinations may drive URL-shaped
 * resolution promotion, the gate's preferred-domain carry, and the
 * browser's destination affinity (with its one-shot human authorization).
 * Research is NEVER scope-enforced (brief #1/#3). Since brief §4c
 * (2026-11-13) this predicate is NOT the evidence wall any more — the
 * mandatoryHosts / admission boundary is the narrower
 * [`isOperationalScope`] below: a site_info or compare_sites turn names
 * the sites it is ABOUT, and folding those hosts into a hard boundary
 * would automatically ban outside corroboration.
 */
export function isEnforceableScope(scope: TaskScope): boolean {
  return scope.intent === "operate" || scope.intent === "site_info" || scope.intent === "compare_sites";
}

/**
 * §4c hard-boundary law (2026-11-13 brief): ONLY an OPERATE scope — a
 * destination the human authorized an ACTION at — may become a
 * mandatoryHosts / admission wall. Explicit source restrictions from the
 * user's own words ("only use X", "never Y") are enforced separately by
 * the §4b cue law on any intent; site_info/compare_sites hosts ride as
 * ORDERING only (the `origin: "scope"` companion wave, fusion boost,
 * rerank authority tier). ⇔ `is_operational_scope` in
 * `ruke-server/src/task_scope.rs`.
 */
export function isOperationalScope(scope: TaskScope): boolean {
  return scope.intent === "operate";
}

/**
 * Browser routing law — the SCOPE half (brief #2/#3): an OPERATE scope is
 * the only intent that CAN run the browser tool loop (the intent ladder
 * makes "operate" structurally imply ≥1 target). Research/site-info/
 * compare turns route through the scope-enforced research path instead.
 * This half ALONE no longer activates the engine — the user rescope
 * (2026-11-07) gates it with the human's request; the FULL law is
 * [`browserActivates`] below. The TS side carries no browser engine
 * (route.ts strips the markers); this mirror exists so the contract stays
 * one law in two languages, pinned by the shared vitest/Rust matrix
 * tests. ⇔ `routes_to_browser_turn` in `ruke-server/src/task_scope.rs`.
 */
export function routesToBrowserTurn(scope: TaskScope): boolean {
  return scope.intent === "operate";
}

/**
 * Instrument words: the harness browser's own capability name — never a
 * site/company/city vocabulary patch. ⇔ BROWSER_INSTRUMENTS in
 * `ruke-server/src/task_scope.rs`.
 */
const BROWSER_INSTRUMENTS = new Set(["browser", "browsers"]);
/** Words that AIM an instrument token at the harness. ⇔ BROWSER_TRIGGERS. */
const BROWSER_TRIGGERS = new Set([
  "use", "uses", "using", "used",
  "open", "opens", "opening",
  "launch", "launches", "launching",
  "start", "starts", "starting",
  "try", "trying", "tried",
  "run", "runs", "running",
  "drive", "drives", "driving",
  "navigate", "navigates", "navigating",
  "browse", "browsing",
]);
/** Negation ANYWHERE before the instrument token vetoes the request.
 *  ⇔ BROWSER_NEG. */
const BROWSER_NEG = new Set([
  "not", "no", "never",
  "don't", "dont", "doesn't", "doesnt", "won't", "wont",
  "cannot", "can't", "cant",
  "without", "avoid", "stop", "stopped", "shouldn't", "shouldnt",
]);
/** Harmless connectives the walk-back skips over — articles/possessives
 *  plus plain prepositions bridging a verb to the instrument ("open it IN
 *  the browser", "navigate WITH the browser"). Prepositions never mention
 *  the instrument themselves, and the negation-first veto keeps the
 *  conservative direction. ⇔ BROWSER_FILLERS. */
const BROWSER_FILLERS = new Set([
  "the", "a", "an", "your", "my", "this", "that", "web",
  "to", "up", "and", "or", "please", "just", "now",
  "with", "in", "on", "at", "via", "through", "inside",
]);

/**
 * Explicit-browser-request law (user rescope 2026-11-07): the turn's OWN
 * words ask for the harness browser — an instrument token preceded within
 * ≤6 tokens (skipping fillers) by a trigger word, vetoed by any negation
 * token ANYWHERE earlier in the sentence. Conservative: "navigate with
 * the browser" counts; "close the browser", "don't use the browser" and
 * "my browser crashed" do not. ⇔ `explicit_browser_request` in
 * `ruke-server/src/task_scope.rs`.
 */
export function explicitBrowserRequest(text: string): boolean {
  const toks = tokenize(text);
  for (let i = 0; i < toks.length; i++) {
    if (!BROWSER_INSTRUMENTS.has(toks[i].clean)) continue;
    if (toks.slice(0, i).some((t) => BROWSER_NEG.has(t.clean))) continue;
    // ⇔ rust: floor = i.saturating_sub(6); walk while j > floor, i.e.
    // the window is the ≤6 tokens immediately before the instrument.
    for (let j = i - 1; j >= 0 && j >= i - 6; j--) {
      const w = toks[j].clean;
      if (BROWSER_FILLERS.has(w)) continue;
      if (BROWSER_TRIGGERS.has(w)) return true;
      break;
    }
  }
  return false;
}

/**
 * FULL browser-activation law (user rescope 2026-11-07): the browser tool
 * loop runs ONLY for an OPERATE scope AND the human's browser request —
 * the Browser Panel OPEN at send time (`browserArmed`: opening the panel
 * through the TopBar toggle IS the explicit "open browser" action) or the
 * turn's own words naming the harness browser. Every other turn —
 * including an instrument-free OPERATE sentence with the panel closed
 * (the "Find apartments to rent in Tallinn" family) — stays on the
 * web-search path; the interactive browser NEVER rides web search.
 * ⇔ `browser_activates` in `ruke-server/src/task_scope.rs`.
 */
export function browserActivates(
  scope: TaskScope,
  question: string,
  browserArmed: boolean,
): boolean {
  return routesToBrowserTurn(scope) && (browserArmed || explicitBrowserRequest(question));
}

/** Distinct resolved hosts in scope order (for gate/planner/browser enforcement). */
export function scopeHosts(scope: TaskScope): string[] {
  const out: string[] = [];
  for (const t of scope.targets) {
    if (t.state === "resolved" && t.host && !out.includes(t.host)) out.push(t.host);
  }
  for (const h of scope.authorizedHosts) if (h && !out.includes(h)) out.push(h);
  return out;
}

/** PSL registrable host for a bare hostname or full URL string ("" → null). */
export function registrableHost(input: string): string | null {
  if (!input) return null;
  let host = input;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch {
      return null;
    }
  } else {
    host = host.split("/")[0];
  }
  host = host.toLowerCase();
  if (!host) return null;
  return tldtsParse(host).domain ?? null;
}

// ─── Word lists (pure language vocabulary — NO brands, NO TLD hints) ───────

const PREPS = new Set(["on", "from", "in", "at", "via", "through"]);

// Operational verbs: things done AT/THROUGH a website. "get/got" deliberately
// absent (false-positive magnet). "open/opens/opening" was demoted OUT on
// 2026-11-05 (audit WS01): adjectival "open" ("open backend engineering
// jobs") made any read-only find turn OPERATE and skipped web research
// entirely. The genuine site-destination reading ("Open Zepto") lives in
// DO_SITE_VERBS/NAV_SITE_VERBS (Pass 3b) — the only place an "open" that
// actually governs a destination can set the intent.
const OP_VERBS = new Set([
  "buy", "buys", "buying", "purchased", "purchases", "purchasing", "purchase",
  "ordered", "orders", "ordering", "order", "booked", "books", "booking", "book",
  "reserved", "reserves", "reserving", "reserve", "rented", "rents", "renting", "rent",
  "subscribed", "subscribes", "subscribing", "subscribe", "paid", "pays", "paying", "pay",
  "checkout", "add", "adds", "adding", "added", "deliver", "delivers", "delivered",
  "ship", "ships", "shipped", "shipping", "apply", "applies", "applying", "applied",
  "renew", "renews", "renewing", "upgrade", "upgrades", "upgrading",
  "use", "uses", "using", "used", "grab", "signup", "register", "registers",
  "do", "does", "did", "done", "doing",
  // UI-action verbs (2026-11-03 audit #2): "Click the login button on
  // example.com" must be OPERATE (browser routing accepts only operate),
  // so the click/tap/scroll/select/submit/fill family belongs in the
  // operational vocabulary. "type" deliberately absent (common noun magnet).
  "click", "clicks", "clicked", "clicking", "tap", "taps", "tapped", "tapping",
  "scroll", "scrolls", "scrolling", "select", "selects", "selecting",
  "submit", "submits", "submitting", "fill", "fills", "filling",
]);

// Direct-object site-taking verbs (2026-11-03 audit #2): "Open Zepto",
// "Search Amazon for milk" — the verb's OBJECT is the destination itself.
// "buy/order/find" deliberately absent: their objects are entities, not
// sites ("Buy iPhone" must never scope iPhone as a website).
const DO_SITE_VERBS = new Set([
  "open", "opens", "opening", "visit", "visits", "visiting", "browse",
  "browses", "browsing", "search", "searches", "searched", "searching",
  "lookup", "lookups", "use", "uses", "using", "used", "navigate",
  "navigates", "navigating", "access", "accesses", "accessing", "launch",
  "launches", "launching",
]);

// Site-navigation subset of DO_SITE_VERBS (audit WS01, 2026-11-05): verbs
// whose direct object IS the destination AND whose use IS an operation on
// that site ("Open/Visit/Browse Zepto" → operate). "search/lookup/use"
// deliberately absent — the corpus pins "Search Amazon for milk" as
// SITE_INFO (read-only flavor preserved).
const NAV_SITE_VERBS = new Set([
  "open", "opens", "opening", "visit", "visits", "visiting", "browse",
  "browses", "browsing", "navigate", "navigates", "navigating", "access",
  "accesses", "accessing", "launch", "launches", "launching",
]);

// Scaffold words that can never be a direct-object site ("Open the login
// page", "Open my account" ⇒ nothing, not a "login"/"account" website).
const DO_SCAFFOLD = new Set([
  "login", "logins", "signin", "button", "buttons", "link", "links", "tab",
  "tabs", "form", "forms", "menu", "menus", "setting", "settings", "search",
  "bar", "screen", "window", "dashboard", "account", "page", "pages", "app",
  "apps", "site", "website",
]);

// Coordinating conjunctions END the Pass-3 backward scan: an eligible verb
// from a different coordinated instruction must not license this NP.
const CONJ_STOPS = new Set(["and", "or", "but", "then", "nor"]);

const FIND_VERBS = new Set([
  "find", "finds", "finding", "search", "searches", "searched", "searching",
  "check", "checks", "checked", "checking", "read", "reads", "see", "sees",
  "show", "shows", "showing", "browse", "browses", "browsing", "explore",
  "explores", "exploring", "look", "looks", "looking", "lookup", "lookups",
  "track", "tracks", "tracking", "visit", "visits", "visiting", "open", "opens",
  "opening", "review", "reviews", "reviewed", "rate", "rates", "rated",
  "watch", "watches", "watching",
]);

const CUE_NOUNS = new Set([
  "price", "prices", "cost", "costs", "rate", "rates", "pricing", "menu", "menus",
  "stock", "availability", "review", "reviews", "rating", "ratings", "deal", "deals",
  "offer", "offers", "discount", "discounts", "coupon", "coupons", "delivery",
  "shipping", "listing", "listings", "status", "catalog", "catalogue", "invoice",
  "receipt", "balance", "order", "orders", "cart", "checkout", "subscription",
]);

const COMPARE_WORDS = new Set(["compare", "compares", "compared", "comparison", "comparing", "vs", "versus"]);
const COMPARE_ADJ = new Set(["better", "worse", "cheaper", "costlier", "faster", "slower"]);

// Generic sentence-scaffold words. A noun phrase that STARTS with one of
// these is never a site name — this (plus the detector-only path) is what
// retired the `site:what.com` bug: sentence-initial "What" can no longer
// become a "brand".
const GENERIC_FIRST = new Set([
  "what", "when", "where", "why", "how", "who", "whom", "whose", "which", "whether",
  // protocol words are sentence scaffolding, never site names ("https" as
  // an NP head would otherwise fabricate the phrase "https www.x.com").
  "http", "https", "www",
  "the", "a", "an", "some", "any", "no", "not", "this", "that", "these", "those",
  "it", "its", "i", "you", "he", "she", "we", "they", "them", "me", "my", "your",
  "his", "her", "our", "their", "every", "each", "both", "either", "neither", "all",
  "most", "more", "less", "few", "many", "several", "one", "two", "three", "another",
  "other", "others", "such", "own", "best", "better", "top", "cheapest", "cheap",
  "expensive", "official", "online", "new", "latest", "same", "nearby", "local",
  "recent", "current", "general", "store", "stores", "shop", "shops", "market",
  "markets", "mall", "malls", "website", "websites", "site", "sites", "app", "apps",
  "platform", "platforms", "portal", "portals", "page", "pages", "internet", "web",
  "home", "house", "office", "offices", "city", "town", "country", "state",
  "district", "area", "region", "place", "near", "nearest", "different", "order",
  "orders", "cart", "checkout", "milk", "beer", "wine", "water", "bread", "egg",
  "eggs", "coffee", "tea", "juice", "soda", "snack", "snacks", "grocery", "groceries",
  "vegetable", "vegetables", "fruit", "fruits", "food", "meal", "meals", "ticket",
  "tickets", "seat", "seats", "table", "tables", "room", "rooms", "hotel", "hotels",
  "flight", "flights", "cab", "cabs", "car", "cars", "bike", "bikes", "scooter",
  "job", "jobs", "movie", "movies", "song", "songs", "book", "books", "gift", "gifts",
  "flower", "flowers", "medicine", "medicines", "pill", "pills", "phone", "phones",
  "laptop", "laptops", "shoe", "shoes", "shirt", "shirts", "dress", "dresses",
  "saree", "kurta",
]);

// NP terminators (function words).
const STOP_TOKENS = new Set([
  "on", "in", "at", "from", "via", "through", "to", "for", "with", "about", "of",
  "and", "or", "but", "so", "then", "than", "that", "this", "these", "those",
  "who", "which", "as", "by", "up", "down", "out", "into", "over", "under",
  "again", "now", "here", "there", "today", "tonight", "tomorrow", "my", "your",
  "his", "her", "their", "our", "its", "me", "you", "he", "she", "they", "it",
  "not", "please", "pls", "too", "also", "vs", "versus",
]);

// Words stripped from the END of a noun phrase ("Blinkit App" → "Blinkit").
const TRAILING_STRIP = new Set([
  "app", "website", "site", "platform", "portal", "online", "order", "orders",
  "cart", "checkout", "page", "pages", "account", "delivery", "now", "today",
  "here", "there", "quickly", "pls", "please", "side",
]);

const ARTICLES = new Set(["the", "a", "an"]);
// Relative-pronoun follow-ups mean the NP was a sentence subject, not an
// object of the preposition ("I read on reddit THAT blinkit raised…").
const POST_NP_REJECT = new Set(["that", "which", "who", "was", "were"]);

const ONLY_LEAD = new Set(["only", "just", "strictly"]);
const ONLY_VERB = new Set([
  "use", "uses", "using", "used", "from", "on", "via", "through", "search",
  "searches", "searched", "searching", "check", "checks", "checking", "browse",
  "browses", "browsing", "order", "orders", "ordering", "buy", "buys", "buying",
]);
const EXCL_LEAD = new Set(["don't", "dont", "never", "avoid", "avoided", "avoiding", "without", "exclude", "excluding"]);
const EXCL_VERB = new Set([
  "use", "using", "uses", "used", "from", "on", "via", "through", "search",
  "searching", "searched", "check", "checking", "browse", "browsing", "order",
  "ordering", "order", "buy", "buying", "see", "seeing", "show", "showing",
]);
const AUTH_LEAD1 = new Set(["allowed", "permitted"]);
const AUTH_VERB = new Set(["use", "visit", "open", "check", "go", "login", "signin", "sign", "pay", "try"]);

const RESEARCH_CUE_WORDS = new Set(["search", "searches", "searching", "research", "latest", "current", "recent", "news", "explain"]);
const INTERROG = ["who", "what", "when", "where", "why", "how", "which"];
const COPULAS = new Set(["is", "was", "are", "were", "will", "would", "can", "could", "does", "did", "has", "have"]);
// §4c continuation law (2026-11-13 brief): "now", "and", "but", "then",
// "here", "there" are NOT continuation evidence — bare connectives and
// temporal/locative adverbs appear everywhere and once proved
// continuation of the wrong subject ("now find the price" no longer
// inherits an unrelated previous destination). KEPT cues are GENUINE
// ANAPHORA: pronouns/demonstratives whose antecedent only exists in a
// PREVIOUS scope (mergeTaskScope applies this predicate solely when one
// does — "insufficient proof on its own" holds: with nothing to resolve
// against, a pronoun proves nothing), and the ADDITIVE adverbs "too"/
// "also", which refer back to the previous action's proposition ("add
// bread too" = also add bread to the same cart). The removed connectives
// stay non-content tokens via CONJ_STOPS / STOP_TOKENS / TRAILING_STRIP
// ("too"/"also" join STOP_TOKENS as NP terminators), so the Pass-3
// locative law is otherwise byte-identical; only the continuation law
// moved.
const FOLLOW_CUES = new Set(["it", "its", "them", "this", "that", "same", "again", "too", "also"]);
// Leading connectives stripped before the Tier-2 fragment test below —
// the FRAGMENT'S SHAPE decides, never its leading connective (§4c: "a short
// question is insufficient proof" on its own; it continues only with a real
// previous scope to resolve against, in mergeTaskScope).
const CONTINUATION_SCAFFOLD = new Set(["and", "or", "but", "so", "then", "nor", "too", "also", "now"]);
// F04: tokens that may precede a turn's leading slot without becoming its
// predicate. Interrogatives and copulas need no entry: isContentToken already
// refuses them, which is what keeps a question ("what about its fee") from
// looking like a new imperative action.
const NON_HEAD_OPENERS = new Set([
  ...CONTINUATION_SCAFFOLD, ...ARTICLES, ...PREPS, ...ONLY_LEAD, ...COPULAS,
]);

// Content-token law (audit WS01, 2026-11-05): a token belonging to NONE of
// the functional/scaffolding vocabularies above carries lexical meaning —
// a noun ("backend", "engineering", "jobs", "apartments", or an unseen
// entity word). This is the gazetteer-free test behind the Pass-3 locative
// rule: content tokens between an eligible verb and an "in" bind the PP to
// the entity NP (geographic restriction, NEVER a site destination); only
// scaffolding in between licenses a platform destination ("do this in
// Blinkit"). No place names, no brand tables — purely closed-class
// vocabulary membership.
const NON_CONTENT_SETS: ReadonlyArray<ReadonlySet<string>> = [
  PREPS, OP_VERBS, DO_SITE_VERBS, NAV_SITE_VERBS, DO_SCAFFOLD, CONJ_STOPS,
  FIND_VERBS, CUE_NOUNS, COMPARE_WORDS, COMPARE_ADJ, GENERIC_FIRST,
  STOP_TOKENS, TRAILING_STRIP, ARTICLES, POST_NP_REJECT, ONLY_LEAD,
  ONLY_VERB, EXCL_LEAD, EXCL_VERB, AUTH_LEAD1, AUTH_VERB,
  RESEARCH_CUE_WORDS, COPULAS, FOLLOW_CUES,
];
const isContentToken = (c: string) =>
  !isInterrog(c) && !NON_CONTENT_SETS.some((s) => s.has(c));

// ─── Tokenizer (shared law with task_scope.rs) ─────────────────────────────
// Punctuation never forms a token on its own; "." stays INSIDE tokens
// ("blinkit.com" is one token, so sentence dots inside domains don't split);
// clause boundaries are computed from the GAPS between tokens.

interface Tok {
  raw: string;
  clean: string; // lowercased, trailing sentence punct removed
  start: number;
  end: number;
}

const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}'&_.+#-]*/gu;
const stripTailPunct = (t: string) => t.replace(/[.,;:!?"']+$/, "");

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  for (const m of s.matchAll(TOKEN_RE)) {
    const raw = m[0];
    out.push({ raw, clean: stripTailPunct(raw.toLowerCase()), start: m.index ?? 0, end: (m.index ?? 0) + raw.length });
  }
  return out;
}

/** Phrase join preserves the user's own casing ("big basket"). */
const npPhrase = (words: string[]) => words.join(" ");

// ─── NP collection ─────────────────────────────────────────────────────────

interface NpResult {
  words: string[];
  firstTok: number;
  lastTok: number; // inclusive
  next: number; // first token index after the NP
}

/**
 * Collect a noun phrase starting at token `i`. Terminates on stop words,
 * clause boundaries, verbs, and a 3-word cap; strips trailing scaffold
 * words; rejects generic/verb-leading heads. `extraStops` adds pattern-
 * specific terminators (compare connectors).
 */
function collectNp(
  prompt: string,
  toks: Tok[],
  boundary: boolean[],
  i: number,
  opts: { extraStops?: Set<string>; skipArticles?: boolean } = {},
): NpResult | null {
  const n = toks.length;
  let j = i;
  if (j >= n || boundary[j]) return null;
  if (opts.skipArticles !== false) {
    while (j < n && ARTICLES.has(toks[j].clean)) j++;
  }
  if (j >= n || boundary[j]) return null;
  const head = toks[j].clean;
  if (GENERIC_FIRST.has(head) || OP_VERBS.has(head) || FIND_VERBS.has(head)) return null;
  if (head.replace(/[.,]/g, "").length < 2) return null;

  const words: string[] = [];
  const firstTok = j;
  while (j < n) {
    const t = toks[j];
    if (boundary[j] || STOP_TOKENS.has(t.clean) || (opts.extraStops?.has(t.clean) ?? false)) break;
    if (words.length > 0 && (OP_VERBS.has(t.clean) || FIND_VERBS.has(t.clean))) break;
    if (words.length >= 3) break;
    words.push(stripTailPunct(t.raw));
    j++;
  }
  // strip trailing scaffold tokens (compare against collected tokens, newest first)
  let lastIdx = j - 1;
  while (words.length > 1 && TRAILING_STRIP.has(toks[lastIdx].clean)) {
    words.pop();
    lastIdx--;
  }
  if (words.length === 0) return null;
  // "on reddit that …" ⇒ the NP was a sentence subject, not the object of
  // the preposition. A comma EXEMPTS non-restrictive relatives
  // ("zepto, which is cheaper…" — zepto IS the object of "vs").
  if (postNpRejected(prompt, toks, boundary, lastIdx, j)) return null;
  return { words, firstTok, lastTok: lastIdx, next: j };
}

function postNpRejected(prompt: string, toks: Tok[], boundary: boolean[], lastIdx: number, next: number): boolean {
  const n = toks.length;
  if (next >= n || next < 0 || boundary[next]) return false;
  if (!POST_NP_REJECT.has(toks[next].clean)) return false;
  return !/,/.test(prompt.slice(toks[lastIdx].end, toks[next].start));
}

/** Single-token NP guard (compare-vs operands, and-continuations). */
function guardedSingle(prompt: string, toks: Tok[], boundary: boolean[], i: number, extraStops?: Set<string>): NpResult | null {
  const n = toks.length;
  if (i < 0 || i >= n || boundary[i]) return null;
  const t = toks[i];
  const c = t.clean;
  if (STOP_TOKENS.has(c) || (extraStops?.has(c) ?? false)) return null;
  if (GENERIC_FIRST.has(c) || OP_VERBS.has(c) || FIND_VERBS.has(c)) return null;
  if (c.replace(/[.,]/g, "").length < 2) return null;
  if (postNpRejected(prompt, toks, boundary, i, i + 1)) return null;
  return { words: [stripTailPunct(t.raw)], firstTok: i, lastTok: i, next: i + 1 };
}

// ─── Derivation ────────────────────────────────────────────────────────────

function isInterrog(clean: string): boolean {
  for (const w of INTERROG) {
    if (clean === w) return true;
    if (clean.startsWith(w) && clean[w.length] === "'") return true; // what's, who'll…
  }
  return false;
}

interface MutableTarget {
  phrase: string;
  spanStart: number; // prompt offsets (for sort + overlap)
  spanEnd: number;
  firstTok: number; // -1 for promoted (not token-bound) targets
  lastTok: number;
  state: TargetState;
  host: string;
  url: string;
  candidates: string[];
  provenance: TargetProvenance;
}

/**
 * Derive the TaskScope for ONE user prompt. Pure, deterministic,
 * word-order aware. Target order: ascending span start (the user's order).
 */
export function deriveTaskScope(prompt: string): TaskScope {
  const toks = tokenize(prompt);
  const n = toks.length;
  const empty: TaskScope = { intent: "none", targets: [], excludedPhrases: [], authorizedHosts: [] };
  if (n === 0) return empty;

  // Clause boundaries: gap punctuation before token i. Token 0 is a clause
  // START, not a break — clause-initial verbs ("compare X and Y", "buy …
  // on …") are perfectly eligible; the window scan bounds itself instead.
  const boundary: boolean[] = new Array(n).fill(false);
  for (let i = 1; i < n; i++) {
    boundary[i] = /[.?!;\n]/.test(prompt.slice(toks[i - 1].end, toks[i].start));
  }

  // Explicit URLs/domains — ONLY via the PSL-aware detector, with prompt spans.
  const dets = detectUrlsAndDomains(prompt, {}).map((d) => {
    let start = prompt.indexOf(d.raw);
    if (start < 0) start = prompt.toLowerCase().indexOf(d.raw.toLowerCase());
    return { ...d, spanStart: Math.max(start, 0), spanEnd: Math.max(start, 0) + d.raw.length };
  });

  const targets: MutableTarget[] = [];
  const excludedPhrases: string[] = [];
  const authorizedHosts: string[] = [];
  const consumed = new Set<number>();
  const consume = (a: number, b: number) => {
    for (let i = a; i <= b && i < n; i++) consumed.add(i);
  };
  const pushTarget = (np: NpResult) => {
    targets.push({
      phrase: npPhrase(np.words),
      spanStart: toks[np.firstTok].start,
      // The last token's RAW keeps its sentence punctuation (a sentence-
      // final domain tokenizes as "careers.example.com."), but neither the
      // phrase nor the detector span does — the target span must end where
      // the phrase ends (audit WS01: sentence-final explicit domains missed
      // their detector merge by exactly this off-by-one and stayed
      // forever-unresolved site targets).
      spanEnd: toks[np.lastTok].end - (toks[np.lastTok].raw.length - stripTailPunct(toks[np.lastTok].raw).length),
      firstTok: np.firstTok,
      lastTok: np.lastTok,
      state: "unresolved",
      host: "",
      url: "",
      candidates: [],
      provenance: "none",
    });
    consume(np.firstTok, np.lastTok);
  };

  // ── Pass 1: restrictions & authorizations (the user's OWN constraints) ──
  let k = 0;
  while (k < n) {
    if (consumed.has(k)) {
      k++;
      continue;
    }
    const c = toks[k].clean;
    // Exclusions: don't/don't-bigram/never/without/avoid + verb + NP.
    const exclLeadLen = EXCL_LEAD.has(c) ? 1 : c === "do" && toks[k + 1]?.clean === "not" ? 2 : 0;
    if (exclLeadLen > 0) {
      const v = k + exclLeadLen;
      if (v < n && EXCL_VERB.has(toks[v].clean) && !boundary[v]) {
        let s = v + 1;
        if (s < n && PREPS.has(toks[s].clean)) s++;
        const np = collectNp(prompt, toks, boundary, s);
        if (np) {
          excludedPhrases.push(npPhrase(np.words));
          consume(k, np.lastTok);
          k = np.next;
          continue;
        }
      }
    }
    // Mandatory restriction: only/just/strictly + use-ish verb + NP.
    if (ONLY_LEAD.has(c)) {
      const v = k + 1;
      if (v < n && ONLY_VERB.has(toks[v].clean) && !boundary[v]) {
        let s = v + 1;
        if (s < n && PREPS.has(toks[s].clean)) s++;
        const np = collectNp(prompt, toks, boundary, s);
        if (np) {
          pushTarget(np);
          k = np.next;
          continue;
        }
      }
    }
    // Authorization (auth/pay hops): you can/may + verb + registrable domain.
    const authLeadLen =
      (toks[k].clean === "you" && (toks[k + 1]?.clean === "can" || toks[k + 1]?.clean === "may")) ||
      (toks[k].clean === "feel" && toks[k + 1]?.clean === "free")
        ? 2
        : AUTH_LEAD1.has(c)
          ? 1
          : 0;
    if (authLeadLen > 0) {
      const v = k + authLeadLen;
      if (v < n && AUTH_VERB.has(toks[v].clean) && !boundary[v]) {
        let s = v + 1;
        if (s < n && PREPS.has(toks[s].clean)) s++;
        const np = collectNp(prompt, toks, boundary, s, { skipArticles: false });
        if (np && np.words.length === 1) {
          const reg = registrableHost(np.words[0]);
          if (reg) {
            authorizedHosts.push(reg);
            consume(k, np.lastTok);
            k = np.next;
            continue;
          }
        }
      }
    }
    k++;
  }

  // ── Pass 2: compare cues & operands ────────────────────────────────────
  let compareCue = false;
  for (let i = 0; i < n; i++) {
    const c = toks[i].clean;
    const nxt = toks[i + 1]?.clean;
    if (COMPARE_WORDS.has(c)) compareCue = true;
    else if ((c === "difference" || c === "contrast") && nxt === "between") compareCue = true;
    else if (COMPARE_ADJ.has(c) && nxt === "than") compareCue = true;
  }
  const CMP_STOPS = new Set(["vs", "versus"]);
  for (let i = 0; i < n; i++) {
    if (consumed.has(i)) continue;
    const c = toks[i].clean;
    if ((c === "vs" || c === "versus") && !boundary[i]) {
      const a = i > 0 && !boundary[i] ? guardedSingle(prompt, toks, boundary, i - 1) : null;
      const b = guardedSingle(prompt, toks, boundary, i + 1);
      if (a) pushTarget(a);
      if (b) pushTarget(b);
      continue;
    }
    if (COMPARE_WORDS.has(c) && c !== "vs" && c !== "versus" && !boundary[i]) {
      const SKIP = ["the", "a", "an", "price", "prices", "cost", "costs", "between", "of", "with"];
      let j = i + 1;
      while (j < n && SKIP.includes(toks[j].clean)) j++;
      const a = collectNp(prompt, toks, boundary, j, { extraStops: CMP_STOPS });
      if (a) {
        pushTarget(a);
        let jn = a.next;
        if (jn < n && ["and", "with", "vs", "versus", "to", "than"].includes(toks[jn].clean)) {
          jn++;
          while (jn < n && SKIP.includes(toks[jn].clean)) jn++;
          const b = collectNp(prompt, toks, boundary, jn, { extraStops: CMP_STOPS });
          if (b) pushTarget(b);
        }
      }
      continue;
    }
  }

  // ── Pass 3: candidate targets via operational/source prepositions ──────
  const eligibleWord = (w: string) =>
    OP_VERBS.has(w) || FIND_VERBS.has(w) || CUE_NOUNS.has(w) || COMPARE_WORDS.has(w);
  for (let p = 0; p < n; p++) {
    if (!PREPS.has(toks[p].clean) || consumed.has(p) || boundary[p]) continue;
    // Scan back to the clause start — no fixed token cap (2026-11-03 audit
    // #2: the old 8-token window lost "Amazon" in "Find Samsung Galaxy S24
    // Ultra 256 GB Titanium Gray on Amazon.", where the eligible verb sits
    // past an arbitrarily long entity NP). The scan stops at the clause
    // boundary (a previous clause must not license this NP) and at a
    // coordinating conjunction (a verb from another coordinated
    // instruction must not license it either).
    let eligible = false;
    for (let j = p - 1; j >= 0; j--) {
      if (boundary[j] || CONJ_STOPS.has(toks[j].clean)) break;
      if (eligibleWord(toks[j].clean)) {
        // Locative rule (audit WS01, 2026-11-05): with the preposition "in",
        // content tokens between the eligible word and the preposition mean
        // the PP post-modifies the entity NP ("find open backend engineering
        // jobs IN Hyderabad" — Hyderabad restricts JOBS; it is never a site
        // destination). Only scaffolding in between keeps the destination
        // reading ("do this IN Blinkit"). A locative PP is bound to its NP,
        // so eligible words further back must not re-license it either.
        if (toks[p].clean !== "in") {
          eligible = true;
        } else {
          let locative = false;
          for (let m = j + 1; m < p; m++) {
            if (isContentToken(toks[m].clean)) {
              locative = true;
              break;
            }
          }
          if (!locative) eligible = true;
        }
        break;
      }
    }
    if (!eligible) continue;
    const np = collectNp(prompt, toks, boundary, p + 1);
    if (!np) continue;
    if (consumed.has(np.firstTok)) continue;
    pushTarget(np);
    // "amazon and flipkart" → a SECOND target (not one phrase).
    if (np.next < n && (toks[np.next].clean === "and" || toks[np.next].clean === "or")) {
      const two = guardedSingle(prompt, toks, boundary, np.next + 1);
      if (two && !consumed.has(two.firstTok)) pushTarget(two);
    }
  }

  // Set when a target was admitted as the direct object of a site-
  // navigation verb (NAV_SITE_VERBS) — the operation ITSELF, even though
  // "open" is no longer an OP_VERB (audit WS01).
  let navOperate = false;

  // ── Pass 3b: direct-object destinations ("Open Zepto", "Search Amazon
  // for milk") ────────────────────────────────────────────────────────────
  // A site-taking verb whose OBJECT is the destination itself (2026-11-03
  // audit #2: these forms produced no target at all). Gated three ways so an
  // entity object never masquerades as a site: (1) if this clause already
  // produced a token target, the verb's object was the entity — the site was
  // licensed by a preposition ("Find <product> on Amazon"); (2) the NP must
  // be a SINGLE word after trailing-token stripping (multiword objects like
  // "a new tab" are not site names); (3) the word must not be UI scaffold
  // ("Open the login page" ⇒ nothing, not a "login" website). Detector spans
  // still merge in Pass 4, so domain objects ("use reddit.com") resolve to
  // explicit hosts through the normal funnel.
  for (let v = 0; v < n; v++) {
    if (consumed.has(v) || boundary[v] || !DO_SITE_VERBS.has(toks[v].clean)) continue;
    // A verb sitting right after a preposition/article is being used as a
    // NOUN at that position ("in the select tier-select" — HTML <select>),
    // not commanding an object. Skip it.
    if (v > 0 && (PREPS.has(toks[v - 1].clean) || ARTICLES.has(toks[v - 1].clean))) continue;
    let clauseEnd = n;
    for (let b = v + 1; b < n; b++) {
      if (boundary[b]) {
        clauseEnd = b;
        break;
      }
    }
    if (targets.some((t) => t.firstTok > v && t.firstTok < clauseEnd)) continue;
    const np = collectNp(prompt, toks, boundary, v + 1);
    if (!np || np.words.length !== 1 || consumed.has(np.firstTok)) continue;
    if (DO_SCAFFOLD.has(np.words[0].toLowerCase())) continue;
    // Entity-qualified object guard (audit WS01): "open positions IN
    // Hyderabad" — a single-word object further restricted by an "in" NP is
    // an entity being researched, not a destination. "Open Zepto in a new
    // tab" is unaffected: a scaffold NP ("new" is generic) is never
    // collectible.
    if (np.next < n && toks[np.next].clean === "in") {
      const mod = collectNp(prompt, toks, boundary, np.next + 1);
      if (mod) continue;
    }
    const nav = NAV_SITE_VERBS.has(toks[v].clean);
    pushTarget(np);
    if (np.next < n && (toks[np.next].clean === "and" || toks[np.next].clean === "or")) {
      const two = guardedSingle(prompt, toks, boundary, np.next + 1);
      if (two && !consumed.has(two.firstTok)) pushTarget(two);
    }
    // The navigation ITSELF is the requested operation: with "open" no
    // longer in OP_VERBS, "Open Zepto" must still reach the browser loop.
    if (nav) navOperate = true;
  }

  // ── Pass 4: explicit merge / promotion (PSL-verified, never guessed) ───
  // The detector's `domain` field carries the full HOST ("www.zepto.com");
  // SiteTarget.host is defined as the PSL REGISTRABLE host ("zepto.com").
  // Funnel every detector host through registrableHost — a target never
  // keeps an unregistered host form.
  const detHost = (d: { domain: string; url: string; hasScheme: boolean }): string =>
    registrableHost(d.hasScheme ? d.url : d.domain) ?? d.domain;
  for (const t of targets) {
    for (const d of dets) {
      if (d.spanStart <= t.spanStart && d.spanEnd >= t.spanEnd) {
        t.state = "resolved";
        t.host = detHost(d);
        t.url = d.url;
        t.provenance = d.hasScheme ? "explicit_url" : "explicit_domain";
        break;
      }
    }
  }
  const overlapsTargetSpan = (spanStart: number, spanEnd: number) =>
    targets.some((t) => spanStart < t.spanEnd && spanEnd > t.spanStart);
  const overlapsConsumed = (spanStart: number, spanEnd: number) =>
    toks.some((t, i) => consumed.has(i) && spanStart < t.end && spanEnd > t.start);
  for (const d of dets) {
    if (overlapsTargetSpan(d.spanStart, d.spanEnd)) continue;
    if (d.hasScheme) {
      targets.push({
        phrase: d.raw,
        spanStart: d.spanStart,
        spanEnd: d.spanEnd,
        firstTok: -1,
        lastTok: -1,
        state: "resolved",
        host: detHost(d),
        url: d.url,
        candidates: [],
        provenance: "explicit_url",
      });
      continue;
    }
    if (overlapsConsumed(d.spanStart, d.spanEnd)) continue;
    const bareUntied = dets.filter(
      (o) => !o.hasScheme && !overlapsTargetSpan(o.spanStart, o.spanEnd) && !overlapsConsumed(o.spanStart, o.spanEnd),
    ).length;
    if (compareCue || bareUntied === 1) {
      targets.push({
        phrase: d.raw,
        spanStart: d.spanStart,
        spanEnd: d.spanEnd,
        firstTok: -1,
        lastTok: -1,
        state: "resolved",
        host: detHost(d),
        url: d.url,
        candidates: [],
        provenance: "explicit_domain",
      });
    }
  }

  // Sort by user order, then dedupe (host,url,phrase-lower).
  targets.sort((a, b) => a.spanStart - b.spanStart);
  const seen = new Set<string>();
  const deduped = targets.filter((t) => {
    const key = `${t.host}\u0000${t.url}\u0000${t.phrase.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // ── Intent ladder ───────────────────────────────────────────────────────
  let researchCue = false;
  for (let i = 0; i < n && !researchCue; i++) {
    const c = toks[i].clean;
    if (RESEARCH_CUE_WORDS.has(c)) {
      researchCue = true;
      break;
    }
    if (isInterrog(c)) {
      for (let j = i + 1; j <= Math.min(n - 1, i + 2); j++) {
        if (COPULAS.has(toks[j].clean)) {
          researchCue = true;
          break;
        }
      }
    }
    if (c === "tell" && toks[i + 1]?.clean === "me") researchCue = true;
  }
  let opSeen = false;
  for (const t of toks) {
    if (OP_VERBS.has(t.clean)) {
      opSeen = true;
      break;
    }
  }

  let intent: TaskIntent;
  if (deduped.length === 0) intent = researchCue ? "research" : "none";
  else if (compareCue && deduped.length >= 2) intent = "compare_sites";
  else if (opSeen || navOperate) intent = "operate";
  else intent = "site_info";

  return {
    intent,
    targets: deduped.map((t) => ({
      phrase: t.phrase,
      state: t.state,
      host: t.host,
      url: t.url,
      candidates: t.candidates,
      provenance: t.provenance,
    })),
    excludedPhrases,
    authorizedHosts,
  };
}

// ─── Host resolution from REAL retrieval candidates (never fabricated) ─────

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const candidateHost = (c: string): string | null => registrableHost(c.trim());

/**
 * Resolve ONE unresolved target against ranked candidate URLs/hosts.
 * Law (2026-11-03 audit #5): identity is EQUALITY ONLY — the normalized
 * phrase must equal the registrable label. Prefix/containment resemblance
 * NEVER resolves: zeptodiscounts.com is not Zepto, and PSL validity plus
 * string similarity is not identity evidence. Several distinct equality
 * hosts ⇒ ambiguous (clarification territory, brief #4); zero matches
 * leaves the target unresolved — the system never guesses a domain.
 */
export function resolveTarget(
  t: SiteTarget,
  candidates: string[],
  max = 8,
  provenance: TargetProvenance = "resolved_search",
): SiteTarget {
  if (t.state !== "unresolved") return t;
  const pn = norm(t.phrase);
  if (!pn) return t;

  const eqHosts: string[] = [];
  for (const cRaw of candidates) {
    const host = candidateHost(cRaw);
    if (!host) continue;
    const label = host.split(".")[0] ?? "";
    const ln = norm(label);
    if (!ln) continue;
    if (ln === pn && !eqHosts.includes(host)) eqHosts.push(host);
  }

  if (eqHosts.length === 1) {
    return { ...t, state: "resolved", host: eqHosts[0], candidates: [], provenance };
  }
  if (eqHosts.length > 1) {
    return {
      ...t,
      state: "ambiguous",
      host: "",
      candidates: eqHosts.slice().sort().slice(0, Math.max(1, max)),
      provenance: "ambiguous",
    };
  }
  return t; // unresolved, provenance stays "none" — no match, no invention
}

export function resolveTaskScope(
  scope: TaskScope,
  candidates: string[],
  opts: { max?: number; provenance?: TargetProvenance } = {},
): TaskScope {
  const max = opts.max ?? 8;
  const prov = opts.provenance ?? "resolved_search";
  return { ...scope, targets: scope.targets.map((t) => resolveTarget(t, candidates, max, prov)) };
}

// §4c (2026-11-13): applyVerifiedDestinations RETIRED. Title evidence —
// even a self-claiming label family — never PROVES official identity
// (exact hostname-label equality or a title prefix is similarity, not
// identity), so it can never RESOLVE a target into the mandatory
// boundary. Targets stay honestly unresolved from title evidence; the
// only resolution law left is resolveTarget's URL-equality match (a real
// SERP URL whose registrable label equals the phrase). Planner-law's
// destinationAffinities carries such self-claims as ORDERING only.

// ─── Turn-to-turn continuity (brief #6: follow-ups must not lose scope) ───

/**
 * Two-tier continuation law, §4c restatement (2026-11-13 brief: "'now',
 * 'and', ordinary pronouns, or a short question are INSUFFICIENT proof of
 * continuation"; the 2026-11-03 audit #5 lesson — "every short request
 * counted as continuation" carried a prior purchase into "Write a short
 * poem" — stays fully intact). Tier 1: GENUINE ANAPHORA ONLY
 * (it/its/them/this/that/same/again) anywhere in the turn. Tier 2: a bare
 * elliptical FRAGMENT — leading connectives stripped (a leading "and"/
 * "now"/"too" adds nothing), then at most six tokens OPENING with an
 * interrogative, preposition, article, or "only". Neither tier PROVES
 * continuation by itself: mergeTaskScope applies this predicate ONLY when
 * a previous non-empty scope exists, so the antecedent is a real prior
 * subject — a connective, a pronoun, or a short question with nothing to
 * resolve against never conjures a scope. A full request with its own verb
 * ("Write a short poem") is never a follow-up.
 */
export function isFollowUp(prompt: string): boolean {
  const toks = tokenize(prompt);
  if (toks.length === 0) return false;
  if (toks.some((t) => FOLLOW_CUES.has(t.clean))) return true;
  let i = 0;
  while (i < toks.length && CONTINUATION_SCAFFOLD.has(toks[i].clean)) i += 1;
  const rest = toks.slice(i);
  if (rest.length === 0 || rest.length > 6) return false;
  const head = rest[0].clean;
  return (
    isInterrog(head) || PREPS.has(head) || ARTICLES.has(head) || ONLY_LEAD.has(head)
  );
}

/**
 * Merge the previous turn's scope with this turn's derivation.
 * 1. A fresh derivation with DESTINATIONS replaces (explicit target change
 *    wins outright).
 * 2. An intent-only turn (intent, no destinations): on an anaphoric
 *    follow-up, KEEP the previous destinations — the research-cue heuristic
 *    must not erase an operate destination ("What is its rating?" keeps
 *    Zepto) — while the turn's own restrictions/authorizations merge in.
 *    NON-INHERITANCE LAW (2026-11-05 repair, brief #3): the turn keeps its
 *    OWN derived intent. An anaphoric research question about the previous
 *    site ("What is its rating?") continues the SUBJECT (targets) but never
 *    the previous turn's ACTION — an inferred operate/site scope must not
 *    become an immutable permission boundary on a later research turn.
 *    Continuation of an ongoing site task still survives through rule 3
 *    (a pure follow-up with no intent of its own inherits the scope
 *    whole), which is what browser-session operate continuity relies on:
 *    "add bread too" derives NO intent (a targetless turn can never be
 *    operate — the ladder at the intent decision), so it carries the
 *    session via rule 3 on the additive-anaphora cue "too" (§4c law).
 *    Non-anaphoric intent turns stand alone.
 * 3. A derivation with neither intent nor destinations inherits the previous
 *    scope on a genuine follow-up; otherwise the topic changed and the
 *    scope RESETS.
 * Mirrors Rust `merge_task_scope`.
 */
export function mergeTaskScope(prev: TaskScope | null, prompt: string): TaskScope {
  const derived = deriveTaskScope(prompt);
  if (derived.targets.length > 0) return derived;
  const toks = tokenize(prompt);
  const anaphoric = toks.some((t) => FOLLOW_CUES.has(t.clean));
  const selfTask = carriesOwnTask(prompt);
  if (prev && prev.intent !== "none") {
    if (derived.intent !== "none") {
      if (anaphoric && !selfTask) {
        return {
          intent: derived.intent,
          targets: prev.targets,
          excludedPhrases: [...new Set([...prev.excludedPhrases, ...derived.excludedPhrases])],
          authorizedHosts: [...new Set([...prev.authorizedHosts, ...derived.authorizedHosts])],
        };
      }
      return derived;
    }
    if (!selfTask && isFollowUp(prompt)) return prev;
  }
  return derived;
}

/**
 * F04 SELF-TASK LAW (2026-11-15). Words the harness knows as scaffolding,
 * shopping/UI nouns, site verbs, research verbs and anaphora cues are ALL
 * closed class here (NON_CONTENT_SETS), so a token that is a CONTENT token in
 * the leading slot of a turn is by construction not an action this domain's
 * task machinery can perform: it is a fresh predicate. Requiring a second
 * content token after it keeps elliptical noun fragments ("the chargers
 * again", "pizza too", "on the checkout page") working as continuations, which
 * is what an ongoing browser session legitimately relies on.
 * Therefore a pronoun inside a turn that names its own action AND its own
 * matter ("Write a poem about it", "Translate this into French") is
 * language-level reference, NOT proof that the human still authorizes the
 * previous ACTION or the previous destination. Conversation continuity,
 * evidence scope and action authorization are separate; a pronoun is not a
 * permission. Deterministic: no brand tables, no per-example word list, no
 * model call. Mirrors `carries_own_task` in `ruke-server/src/task_scope.rs`.
 */
export function carriesOwnTask(prompt: string): boolean {
  const toks = tokenize(prompt);
  if (toks.length === 0) return false;
  let i = 0;
  while (i < toks.length && NON_HEAD_OPENERS.has(toks[i].clean)) i += 1;
  if (i >= toks.length) return false;
  if (!isContentToken(toks[i].clean)) return false;
  return toks.slice(i + 1).some((t) => isContentToken(t.clean));
}

/**
 * Fold the conversation's USER turns (oldest → newest, current turn LAST)
 * into one scope by replaying the same turn-to-turn merge law. Deterministic
 * and stateless: the chat routes (TS route.ts ⇔ Rust chat pipeline) derive
 * the turn's scope with this instead of needing a server-side session store.
 * Mirrors Rust `fold_task_scope`.
 */
export function foldTaskScope(userPrompts: string[]): TaskScope {
  let prev: TaskScope | null = null;
  for (const p of userPrompts) {
    if (!p || !p.trim()) continue;
    prev = mergeTaskScope(prev, p);
  }
  return prev ?? { intent: "none", targets: [], excludedPhrases: [], authorizedHosts: [] };
}
