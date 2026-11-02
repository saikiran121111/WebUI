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
 * TS ⇔ Rust parity: ruke-websearch/src/task_scope.rs implements the same
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
import tldts from "tldts";
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

/** Enforcement law (brief #1/#3): research is NEVER scope-enforced. */
export function isEnforceableScope(scope: TaskScope): boolean {
  return scope.intent === "operate" || scope.intent === "site_info" || scope.intent === "compare_sites";
}

/**
 * Browser-activation law (brief #2/#3): a chat turn runs the BROWSER tool
 * loop only for an operational scope (the intent ladder makes "operate"
 * structurally imply ≥1 target). Research/site-info/compare turns route
 * through the scope-enforced research path instead. Panel visibility NEVER
 * decides activation — the client's `browser_session` marker is conversation
 * identity only, and the SERVER decides routing from this contract. The TS
 * side carries no browser engine (route.ts strips the marker); this mirror
 * exists so the contract stays one law in two languages, pinned by the
 * shared vitest/Rust matrix tests. ⇔ `routes_to_browser_turn` in
 * `ruke-websearch/src/task_scope.rs`.
 */
export function routesToBrowserTurn(scope: TaskScope): boolean {
  return scope.intent === "operate";
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
  return tldts.parse(host).domain ?? null;
}

// ─── Word lists (pure language vocabulary — NO brands, NO TLD hints) ───────

const PREPS = new Set(["on", "from", "in", "at", "via", "through"]);

// Operational verbs: things done AT/THROUGH a website. "get/got" deliberately
// absent (false-positive magnet). "open" is both operational and source-ish.
const OP_VERBS = new Set([
  "buy", "buys", "buying", "purchased", "purchases", "purchasing", "purchase",
  "ordered", "orders", "ordering", "order", "booked", "books", "booking", "book",
  "reserved", "reserves", "reserving", "reserve", "rented", "rents", "renting", "rent",
  "subscribed", "subscribes", "subscribing", "subscribe", "paid", "pays", "paying", "pay",
  "checkout", "add", "adds", "adding", "added", "deliver", "delivers", "delivered",
  "ship", "ships", "shipped", "shipping", "apply", "applies", "applying", "applied",
  "renew", "renews", "renewing", "upgrade", "upgrades", "upgrading",
  "use", "uses", "using", "used", "grab", "signup", "register", "registers",
  "do", "does", "did", "done", "doing", "open", "opens", "opening",
]);

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
  "not", "please", "pls", "vs", "versus",
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
const FOLLOW_CUES = new Set(["it", "them", "this", "that", "same", "again", "too", "also", "then", "now", "but", "and", "here", "there"]);

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
      spanEnd: toks[np.lastTok].end,
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
    // Window: up to 8 tokens back (or clause start) must hold an
    // operational/source/cue/compare word — no verb cue, no scope.
    // Window: scan back ≤8 tokens, stopping at the clause boundary — an
    // eligible word from a PREVIOUS clause must not license this NP.
    let eligible = false;
    for (let j = p - 1; j >= Math.max(0, p - 8); j--) {
      if (boundary[j]) break;
      if (eligibleWord(toks[j].clean)) {
        eligible = true;
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
  else if (opSeen) intent = "operate";
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
 * Law: an EQUALITY match (normalized phrase === registrable label) outranks
 * containment; several distinct equality hosts ⇒ ambiguous (clarification
 * territory, brief #4); zero matches leaves the target unresolved — the
 * system never guesses a domain.
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
  const conHosts: string[] = [];
  for (const cRaw of candidates) {
    const host = candidateHost(cRaw);
    if (!host) continue;
    const label = host.split(".")[0] ?? "";
    const ln = norm(label);
    if (!ln) continue;
    const eq = ln === pn;
    const con =
      !eq &&
      ((ln.startsWith(pn) && pn.length >= 4) || (pn.startsWith(ln) && ln.length >= 4));
    if (eq && !eqHosts.includes(host)) eqHosts.push(host);
    else if (con && !conHosts.includes(host)) conHosts.push(host);
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
  if (conHosts.length === 1) {
    return { ...t, state: "resolved", host: conHosts[0], candidates: [], provenance };
  }
  if (conHosts.length > 1) {
    return {
      ...t,
      state: "ambiguous",
      host: "",
      candidates: conHosts.slice().sort().slice(0, Math.max(1, max)),
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

// ─── Turn-to-turn continuity (brief #6: follow-ups must not lose scope) ───

export function isFollowUp(prompt: string): boolean {
  const toks = tokenize(prompt);
  if (toks.length <= 6) return true;
  return toks.some((t) => FOLLOW_CUES.has(t.clean));
}

/**
 * Merge the previous turn's scope with this turn's derivation.
 * A fresh non-empty derivation REPLACES (target changes / unrelated ask
 * must not leak the old constraint); an empty derivation on a follow-up
 * INHERITS (recovery and short follow-ups must not silently broaden scope).
 */
export function mergeTaskScope(prev: TaskScope | null, prompt: string): TaskScope {
  const derived = deriveTaskScope(prompt);
  if (derived.targets.length > 0 || derived.intent !== "none") return derived;
  if (prev && prev.intent !== "none" && isFollowUp(prompt)) return prev;
  return derived;
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
