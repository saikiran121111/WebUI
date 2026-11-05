/**
 * tools.ts — P2 model-facing web tools: `web_search` + `read_page`.
 *
 * SOLE OWNER (TS-ownership rollback 2026-11-03): the Rust twin
 * `crates/ruke-websearch/src/tools.rs` was removed. Tool descriptions,
 * the guidance/directive constants, the failure taxonomy, the budget
 * table, and the result envelopes live only here; the Rust chat transport
 * serves them through the TS create-RPC and keeps the guidance/directive
 * bytes ONLY as fallback consts (`ruke-server`'s `chat/web_loop.rs`). The
 * loop that calls these executors lives in `lib/chat/web-tool-loop.ts`
 * (TS turns) and in the Rust transport `chat/web_loop.rs` (Rust turns).
 *
 * Design laws (RICH RESULTS ADDENDUM + §11.6/§11.13/§11.14/§11.18):
 * - Tool results are VALIDATED STRUCTURED DATA flowing on the
 *   "tool/retriever → validated structured result → RichResult envelope"
 *   path. Nothing here ever fabricates a UI value.
 * - Walls are access controls: auth/CAPTCHA/rate/robots outcomes are
 *   represented STRUCTURALLY in the §11.13 `RetrievalFailure` taxonomy —
 *   never bypassed, never silently dropped.
 * - §11.14: every tool round belongs to ONE search session with a
 *   depth-keyed budget; exhaustion returns an HONEST envelope
 *   (`ok:false, error:"budget_exhausted"` + remainingBudget counters).
 * - §11.18: URL-shaped queries get READ semantics, never engine queries.
 * - read_page is batched: ONE tool round buys N pages (critical under
 *   the round budget — mirrors the browser `Tabs.content({urls[]})` shape).
 */
import { metasearch, normalizeUrl } from "./metasearch";
import { extractUrl, renumberPackets } from "./extractor";
import { applySegmentFilter } from "./segment-filter";
import { collectRouteLinks, focusTokens } from "./route-links";
import { isSafeUrlWithDns } from "./ssrf";
import type { SearchDecision, RankedResult } from "./types";
import { retrievalModeForFreshness } from "./types";
import { domainWithin } from "./domain-match";
import {
  isEnforceableScope,
  resolveTaskScope,
  scopeHosts,
  type TaskScope,
} from "../decision/task-scope";
import {
  recordResearchTurn,
  type JournalSource,
  type JournalTurn,
} from "../persistence/research-journal";

/* ── §11.13 RetrievalFailure taxonomy (⇔ Rust `RetrievalFailure`) ──────── */

/**
 * Wire spellings are snake_case; the §11.13 taxonomy names map:
 *   timeout(Timeout) dns_failure(DnsFailure) http_status(HttpStatus)
 *   rate_limited(RateLimited) robots_denied(RobotsDenied)
 *   auth_required(AuthRequired) captcha_required(CaptchaRequired)
 *   unsupported_mime(UnsupportedMime) content_too_large(ContentTooLarge)
 *   parse_failure(ParseFailure) unsafe_destination(UnsafeDestination)
 *   cancelled(Cancelled)
 */
export type RetrievalFailure =
  | "timeout"
  | "dns_failure"
  | "http_status"
  | "rate_limited"
  | "robots_denied"
  | "auth_required"
  | "captcha_required"
  | "unsupported_mime"
  | "content_too_large"
  | "parse_failure"
  | "unsafe_destination"
  | "cancelled"
  // TS-only §7 addition (no legacy §11.13/Rust counterpart): an
  // in-scope URL that 302s to a site OUTSIDE the task scope — the read
  // is honestly refused rather than laundering off-site content past
  // the scope wall (§7 final-origin admission recheck).
  | "off_scope_redirect";

export interface RetrievalFailureEntry {
  url?: string;
  query?: string;
  failure: RetrievalFailure;
  detail?: string;
}

/** Everything the classifier may inspect about one failed retrieval. */
export interface FailureProbe {
  aborted?: boolean;
  status?: number;
  errorMessage?: string;
  /** The extractor's stress-test classification, when one exists. */
  classification?: string;
}

// Literal contains-lists ONLY (no regex metacharacters): the Rust side
// matches the SAME needles with `str::contains` on lowercased text, so the
// two engines are parity BY CONSTRUCTION — no \b/.? drift to discover later.
const NEEDLE_GROUPS: [RetrievalFailure, string[]][] = [
  ["unsafe_destination", ["ssrf", "unsafe"]],
  ["robots_denied", ["robots"]],
  ["captcha_required", ["captcha", "challenge"]],
  ["rate_limited", ["429", "rate limit", "rate-limit", "ratelimit", "too many requests"]],
  ["auth_required", ["401", "403", "unauthoriz", "forbidden"]],
  ["content_too_large", ["too large", "maxbodylength", "oversize", "content too large"]],
  ["unsupported_mime", ["mime", "unsupported media"]],
  ["dns_failure", ["enotfound", "eai_again", "getaddrinfo", "name resolution", "dns"]],
  ["timeout", ["etimedout", "esockettimedout", "timeout", "deadline", "aborterror"]],
];

/**
 * Pure deterministic classifier (⇔ Rust `classify_retrieval_failure`).
 * Fixed order — vectors pinned in BOTH test suites; do not re-order
 * without re-pinning every vector:
 *   1 aborted → cancelled
 *   2 extractor classification map (login wall, bot block, page budget,
 *     js shell)
 *   3 message needles (ssrf → robots → captcha → rate → auth → size →
 *     mime → dns → timeout)
 *   4 explicit HTTP status ≥ 400 → http_status
 *   5 FAIL_NETWORK_OR_CRASH with no other signal → http_status (DOCUMENTED
 *     DEFAULT: the extractor collapsed every network shape into one bucket;
 *     without a message or status there is nothing more honest to say)
 *   6 everything else → parse_failure
 */
export function classifyRetrievalFailure(p: FailureProbe): RetrievalFailure {
  if (p.aborted) return "cancelled";
  const cls = p.classification ?? "";
  if (cls === "FAIL_SILENT_LOGIN_WALL") return "auth_required";
  if (cls === "FAIL_SILENT_BOT_BLOCK") return "captcha_required";
  if (cls === "PAGE_BUDGET_TIMEOUT") return "timeout";
  if (cls === "FAIL_EMPTY_JS_SHELL") return "parse_failure";
  const m = (p.errorMessage ?? "").toLowerCase();
  if (m !== "") {
    for (const [failure, needles] of NEEDLE_GROUPS) {
      for (const needle of needles) {
        if (m.includes(needle)) return failure;
      }
    }
  }
  if (typeof p.status === "number" && p.status >= 400) return "http_status";
  if (cls === "FAIL_NETWORK_OR_CRASH") return "http_status";
  return "parse_failure";
}

/* ── depth-keyed budgets (⇔ Rust `WebToolBudget`/`budget_for_depth`) ──── */

export type WebToolDepth = SearchDecision["depth"]; // "quick" | "standard" | "deep"

/** ⇔ `browser_loop.rs MAX_TOOL_ROUNDS` — the hard chat-side ceiling. */
export const WEB_TOOL_MAX_ROUNDS_CAP = 20;

export interface WebToolBudget {
  maxSearchCalls: number;
  maxReadUrls: number;
  maxToolRounds: number;
}

export function webToolBudgetFor(depth: WebToolDepth): WebToolBudget {
  const raw: WebToolBudget =
    depth === "quick"
      ? { maxSearchCalls: 1, maxReadUrls: 6, maxToolRounds: 2 }
      : depth === "deep"
        ? { maxSearchCalls: 4, maxReadUrls: 20, maxToolRounds: 6 }
        : { maxSearchCalls: 2, maxReadUrls: 12, maxToolRounds: 4 };
  return { ...raw, maxToolRounds: Math.min(raw.maxToolRounds, WEB_TOOL_MAX_ROUNDS_CAP) };
}

/* ── the session (§11.14 tracking) ─────────────────────────────────────── */

/**
 * P3b action-record law (staged-research brief §7–§8: "a tool request is
 * not a successful search/read"): one entry per tool action the turn
 * ACTUALLY attempted, rejections included. Server-owned — the model's own
 * account of what it did is never trusted. Travels to the client on the
 * `web_meta` researchLedger and to Rust via the exec RPC.
 */
export interface ToolActionRecord {
  tool: string;
  /** Model tool round this action ran in (0 before the first round). */
  round: number;
  /** false ⇒ the call was REJECTED and no lookup ran at all. */
  ok: boolean;
  /** Rejection code when ok=false (invalid_arguments, budget_exhausted…). */
  error?: string;
  /** lookups this call requested (queries + routed URLs / read URLs) */
  requested: number;
  /** SERP items + successfully fetched pages actually returned */
  retrieved: number;
  /** individual lookups that came back failed (engine error, wall, block) */
  failed: number;
  /**
   * WS18 (audit 2026-11-05 item 18): counts alone cannot answer "which
   * action, when". `id` is SERVER-MINTED, unique inside the session
   * (`<searchSessionId>-a<n>`); `at` is the ISO-8601 record stamp. Both
   * are stamped centrally in recordAction — no call site can skip them.
   */
  id: string;
  at: string;
  /**
   * WS18 exact provenance (absent when the action parsed/attempted
   * nothing — never a phantom field): `queries`/`urls` name the exact
   * targets the action was issued against, INCLUDING refusals (a budget
   * or validation rejection must say WHAT it refused); `failures` pairs
   * every failed lookup with its classifier code; `sources` are the
   * sourceIds of the [S#] packets THIS action minted.
   */
  queries?: string[];
  urls?: string[];
  failures?: { target: string; code: string }[];
  sources?: string[];
}

export interface WebToolSession {
  searchSessionId: string;
  budget: WebToolBudget;
  searchesUsed: number;
  readUrlsUsed: number;
  roundsUsed: number;
  actionLedger: ToolActionRecord[];
  /** [S#] continuation after the pipeline's packets (citation-map seed). */
  nextSource: number;
  /** Focus fallback: the user prompt the tool loop was built for. */
  queryContext: string;
  /**
   * Task-scope audit (2026-11-02, brief #1/#6): the server-owned operational
   * scope for this conversation. The MODEL CANNOT WIDEN IT — tool arguments
   * never merge into or bypass this contract; it only ever narrows as
   * targets resolve against real SERP evidence. `null` ⇒ no enforcement
   * (legacy direct-session callers). Mirrors Rust `WebToolSession.scope`.
   */
  scope: TaskScope | null;
  /**
   * §9 (audit 2026-11-04): the gate's retrieval policy, carried from the
   * search decision (freshness "realtime" ⇒ live_required). A live_required
   * turn's read_page NEVER replays the SQLite page cache — stale cached
   * bytes can never answer "the price right now", same law as the pipeline
   * (pipeline.ts liveRequired ⇔ here).
   */
  liveRequired: boolean;
  /**
   * Repair (brief 2026-11-05 §5): the conversation this session serves, so
   * every successful `web_search` journals its sources AS THEY ARE FOUND.
   * Recording lives HERE (the tool-session layer) — one implementation
   * serving both the TS loop and the Rust transport — never in a chat
   * route that only exists when a gate bundle ran. `null` ⇒ no journaling
   * (stateless direct-session callers).
   */
  conversation: WebToolConversation | null;
}

/** Conversation identity a tool session journals research under. */
export interface WebToolConversation {
  id: string;
  /** Session date stamp the turn was built under (provenance label). */
  currentDate: string;
}

/** Hostname of a tool-supplied URL ("" on parse failure — fail closed). */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function makeWebToolSession(
  depth: WebToolDepth,
  citationSeed: number,
  queryContext: string,
  scope: TaskScope | null = null,
  liveRequired = false,
  conversation: WebToolConversation | null = null,
): WebToolSession {
  return {
    searchSessionId: "ws-" + Math.random().toString(36).slice(2, 10),
    budget: webToolBudgetFor(depth),
    searchesUsed: 0,
    readUrlsUsed: 0,
    roundsUsed: 0,
    actionLedger: [],
    nextSource: Math.max(1, citationSeed),
    queryContext: queryContext.slice(0, 500),
    scope,
    liveRequired,
    conversation,
  };
}

export function remainingBudget(session: WebToolSession) {
  return {
    searches: Math.max(0, session.budget.maxSearchCalls - session.searchesUsed),
    readUrls: Math.max(0, session.budget.maxReadUrls - session.readUrlsUsed),
    rounds: Math.max(0, session.budget.maxToolRounds - session.roundsUsed),
  };
}

/** Append one action-record entry stamped with the current model round.
 *  WS18: the unique id and timestamp are stamped HERE — provenance is
 *  enforced by construction, every call site cannot opt out. */
export function recordAction(
  session: WebToolSession,
  rec: Omit<ToolActionRecord, "round" | "id" | "at">,
): void {
  session.actionLedger.push({
    ...rec,
    round: session.roundsUsed,
    id: `${session.searchSessionId}-a${session.actionLedger.length + 1}`,
    at: new Date().toISOString(),
  });
}

/**
 * Repair (brief 2026-11-05 §5): journal the sources a `web_search` round
 * actually returned, under the session's conversation. Incremental by
 * design — a session that dies mid-loop still leaves its findings in the
 * journal, so a later turn's rehydration sees real evidence. Best-effort:
 * journaling failure must never break a tool round.
 */
export function journalWebSearchSources(
  session: WebToolSession,
  queries: string[],
  freshness: string,
  results: { url: string; title: string; snippet: string; domain: string; publishedDate?: string }[],
): void {
  const conv = session.conversation;
  if (!conv || !conv.id.trim() || results.length === 0) return;
  const turn: JournalTurn = {
    at: Date.now(),
    currentDate: conv.currentDate,
    queries: queries.slice(0, 8),
    freshness,
    sources: results.slice(0, 12).map((r): JournalSource => ({
      url: r.url,
      title: r.title,
      domain: r.domain,
      publishedAt: r.publishedDate ?? "",
      fetchedAt: new Date().toISOString(),
      excerpt: r.snippet,
    })),
  };
  recordResearchTurn(conv.id, turn);
}

/**
 * P3b grounded-release law: the action record phrased as a constraint the
 * model must answer against (injected on the forced final round). An empty
 * ledger returns "" — no record, no message.
 */
export function summarizeActionLedger(session: WebToolSession): string {
  const ledger = session.actionLedger;
  if (ledger.length === 0) return "";
  const lines = ledger.map((r) =>
    r.ok
      ? `- ${r.tool} round ${r.round}: ${r.requested} lookup(s) requested → ${r.retrieved} retrieved, ${r.failed} failed.`
      : `- ${r.tool} round ${r.round}: REJECTED (${r.error ?? "unknown"}) — the lookup never ran.`,
  );
  const requested = ledger.reduce((n, r) => n + r.requested, 0);
  const retrieved = ledger.reduce((n, r) => n + r.retrieved, 0);
  const failed = ledger.reduce((n, r) => n + r.failed, 0);
  const rejected = ledger.filter((r) => !r.ok).length;
  return [
    "RESEARCH ACTION RECORD (server-issued from actual tool outcomes, not the model's account):",
    ...lines,
    `Total: ${ledger.length} tool action(s): ${requested} lookup(s) requested, ${retrieved} retrieved, ${failed} failed, ${rejected} rejected.`,
    "A failed, blocked or empty lookup is NOT evidence that the requested fact does not exist: never conclude nonexistence from a lookup that failed. Say plainly what could not be retrieved, and present anything no successful search or read supports as unverified background knowledge, never as research output.",
  ].join("\n");
}

/** A citation the tool loop must merge into the [S#] citation map. */
export interface CitationSeed {
  sourceId: string;
  url: string;
  title: string;
  domain: string;
  publishedAt?: string;
}

/* ── model-visible tool definitions (⇔ Rust `model_tools()`) ──────────── */

// Byte-locked by the cross-file probe in __tests__/web-search/web-tools.test.ts.
export const WEB_SEARCH_TOOL_DESCRIPTION =
  "Search the public web for fresh evidence this turn. Never repeat a query already used: missing_claims must name what the current evidence cannot answer, and queries must be NEW keyword-form searches (3-6 keywords, entity-anchored). URLs written by the human belong in read_page, not here.";

export const READ_PAGE_TOOL_DESCRIPTION =
  "Fetch up to 8 public web pages as readable text in ONE call (one tool round buys N pages). Pass the exact URLs; unsafe or blocked pages come back as structured failures, never as guesses. focus (optional) prunes off-topic sections of the fetched pages against the given terms.";

export interface WebToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export function webToolDefinitions(): WebToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "web_search",
        description: WEB_SEARCH_TOOL_DESCRIPTION,
        parameters: {
          type: "object",
          properties: {
            queries: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              maxItems: 4,
              description: "new keyword-form searches (3-6 keywords each); never repeat a query already run this turn",
            },
            missing_claims: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              maxItems: 6,
              description: "the specific facts the current evidence cannot answer",
            },
            desired_source_types: {
              type: "array",
              items: { type: "string", enum: ["general", "news", "docs", "code", "academic", "forum"] },
              description: "optional source-family preference; the first entry steers the query intent",
            },
            freshness: {
              type: "string",
              enum: ["none", "day", "week", "month", "year", "realtime", "any"],
              description: "time scope of the facts sought (omit for timeless facts)",
            },
            reason: {
              type: "string",
              description: "one short line: why this search is needed",
            },
          },
          required: ["queries", "missing_claims"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_page",
        description: READ_PAGE_TOOL_DESCRIPTION,
        parameters: {
          type: "object",
          properties: {
            urls: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              maxItems: 8,
              description: "exact page URLs to read; batch every URL you need into ONE call",
            },
            focus: {
              type: "string",
              description: "optional terms used to prune off-topic sections of the fetched pages",
            },
            timeoutMs: {
              type: "integer",
              minimum: 1000,
              maximum: 60000,
              description: "optional wall clock for the whole batch in ms (default 20000)",
            },
          },
          required: ["urls"],
          additionalProperties: false,
        },
      },
    },
  ];
}

/* ── read_page core: one URL → one packet (shared by both executors) ──── */

const TOOL_SEARCH_CAP = 10; // results fetched per query
const MAX_RESULTS = 10; // fused results shown per web_search envelope
const MAX_SNIPPET_CHARS = 300;
const MAX_PASSAGES_PER_PAGE = 6;
const MAX_PASSAGE_CHARS = 2000;
const READ_PAGE_TEXT_BUDGET = 20000; // shared across every page of a batch
const URL_SHAPE = /^https?:\/\//i;

// Boilerplate-token frequency saturation: past this many matches a focus
// term is generic scaffolding, however many times the page repeats it.
const FOCUS_FREQ_CAP = 60;

/**
 * Focus-window selection (universal research-depth law, refined by audit
 * 2026-11-05 item 11 / WS11): a blind 2000-char prefix cannot reach a
 * requested fact past a long intro — but a SINGLE window centered on the
 * LAST occurrence of ANY focus term lets a generic boilerplate footer
 * (repeating tokens already present near the answer) displace the earlier
 * actual fact, and two distant facts keep only the last. SECTION-AWARE
 * SELECTION: rank the document's whole sections by DISTINCT focus-token
 * coverage (each token weighted by rarity, 1/frequency, so a boilerplate
 * tail repeating already-covered generic tokens scores nothing); take the
 * best sections whole and non-overlapping until the MAX_PASSAGE_CHARS
 * budget is spent, with a rarity-centered window inside an oversized
 * section. Matches confined to the plain prefix keep the byte-identical
 * plain cut. `dropped` counts contiguous clusters of focus-matched
 * content left outside the returned windows, so the entry can disclose
 * remaining sections and offer a continuation handle (re-read with a new
 * focus).
 */
function selectFocusWindows(t: string, words: string[]): { text: string; dropped: number } {
  const plainCut = () => ({ text: t.slice(0, MAX_PASSAGE_CHARS) + "…", dropped: 0 });
  const low = t.toLowerCase();
  const occ = new Map<string, number[]>();
  let beyondPrefix = false;
  for (const w of words) {
    const positions: number[] = [];
    let i = low.indexOf(w);
    while (i !== -1) {
      if (positions.length >= FOCUS_FREQ_CAP) {
        if (i >= MAX_PASSAGE_CHARS) beyondPrefix = true;
        break;
      }
      positions.push(i);
      if (i >= MAX_PASSAGE_CHARS) beyondPrefix = true;
      i = low.indexOf(w, i + w.length);
    }
    if (positions.length > 0) occ.set(w, positions);
  }
  let maxPos = -1;
  for (const ps of occ.values()) maxPos = Math.max(maxPos, ps[ps.length - 1]);
  if (occ.size === 0 || (!beyondPrefix && maxPos < MAX_PASSAGE_CHARS)) return plainCut();
  const weight = new Map<string, number>();
  for (const [w, ps] of occ) weight.set(w, 1 / Math.min(ps.length, FOCUS_FREQ_CAP));

  // Section inventory (paragraph granularity — same granularity the
  // §11.12 segment filter and the extractor's markdown structure use).
  const sections: Array<{ start: number; end: number }> = [];
  let sStart = 0;
  const sepRe = /\n\n+/g;
  let m: RegExpExecArray | null;
  while ((m = sepRe.exec(t)) !== null) {
    sections.push({ start: sStart, end: m.index });
    sStart = m.index + m[0].length;
  }
  sections.push({ start: sStart, end: t.length });

  const uncoveredScore = (from: number, to: number, covered: Set<string>) => {
    let s = 0;
    for (const [w, ps] of occ) {
      if (covered.has(w)) continue;
      if (ps.some((p) => p >= from && p < to)) s += weight.get(w)!;
    }
    return s;
  };
  const bestUncoveredPos = (from: number, to: number, covered: Set<string>) => {
    let pos = -1;
    let bw = -1;
    for (const [w, ps] of occ) {
      if (covered.has(w)) continue;
      for (const p of ps) {
        if (p < from || p >= to) continue;
        if (weight.get(w)! > bw) {
          bw = weight.get(w)!;
          pos = p;
        }
      }
    }
    return pos;
  };
  const markCovered = (from: number, to: number, covered: Set<string>) => {
    for (const [w, ps] of occ) {
      if (!covered.has(w) && ps.some((p) => p >= from && p < to)) covered.add(w);
    }
  };

  const covered = new Set<string>();
  const chosen: Array<{ start: number; end: number }> = [];
  let used = 0;
  for (;;) {
    const remaining = MAX_PASSAGE_CHARS - used;
    if (remaining <= 0) break;
    let bi = -1;
    let bs = 0;
    for (let si = 0; si < sections.length; si++) {
      const sc = uncoveredScore(sections[si].start, sections[si].end, covered);
      if (sc > bs || (sc > 0 && sc === bs && bi !== -1 && sections[si].start < sections[bi].start)) {
        bs = sc;
        bi = si;
      }
    }
    if (bi === -1) break;
    const sec = sections[bi];
    const secLen = sec.end - sec.start;
    if (secLen <= remaining) {
      chosen.push({ start: sec.start, end: sec.end });
      used += secLen;
      markCovered(sec.start, sec.end, covered);
    } else if (remaining >= 300) {
      // Oversized section: a rarity-centered window inside it, then stop —
      // no other section can share the spent budget.
      const center = bestUncoveredPos(sec.start, sec.end, covered);
      const start = Math.max(sec.start, Math.min(center - Math.floor(remaining / 2), sec.end - remaining));
      chosen.push({ start, end: start + remaining });
      markCovered(start, start + remaining, covered);
      break;
    } else break;
  }
  if (chosen.length === 0) return plainCut();
  chosen.sort((a, b) => a.start - b.start);

  const outside: number[] = [];
  for (const ps of occ.values()) {
    for (const p of ps) if (!chosen.some((r) => p >= r.start && p < r.end)) outside.push(p);
  }
  outside.sort((a, b) => a - b);
  let dropped = 0;
  let last = Number.NEGATIVE_INFINITY;
  for (const p of outside) {
    if (p - last > 200) dropped++;
    last = p;
  }

  let text = chosen
    .map((r, i) => (i > 0 || r.start > 0 ? "…" : "") + t.slice(r.start, r.end))
    .join(" […] ");
  if (chosen[chosen.length - 1].end < t.length) text += "…";
  return { text, dropped };
}

interface PageAttempt {
  entry: Record<string, unknown>;
  citation: CitationSeed | null;
  failure: RetrievalFailureEntry | null;
}

/**
 * Fetch ONE URL through the hardened pipeline stack: SSRF+DNS guard →
 * synthetic RankedResult (engine "tool-read", origin "retrieval") →
 * `extractUrl` (every tier, cache, Jina, Wayback) → §11.12 segment filter
 * → session-scoped [S#] numbering. Never throws; every outcome is
 * structured (entry and/or failure). `charBudgetLeft` is the shared
 * read_page allowance; a page that cannot fit any passage is omitted
 * honestly (title-only) instead of half-shown.
 */
async function readOneUrl(
  session: WebToolSession,
  url: string,
  focus: string,
  deadline: number,
  charBudgetLeft: number,
): Promise<PageAttempt> {
  let safe = false;
  try {
    safe = await isSafeUrlWithDns(url);
  } catch {
    safe = false;
  }
  if (!safe) {
    return {
      entry: { url, fetched: false },
      citation: null,
      failure: {
        url,
        failure: "unsafe_destination",
        detail: "the SSRF guard rejected this URL or one of its resolved addresses",
      },
    };
  }

  let domain = url;
  try {
    domain = new URL(url).hostname;
  } catch {
    /* unreachable: URL_SHAPE already gated */
  }
  const synthetic: RankedResult = {
    url,
    canonical: normalizeUrl(url),
    title: "",
    snippet: "",
    engine: "tool-read",
    domain,
    rrf: 0,
    engines: ["tool-read"],
    engineRanks: {},
    origin: "retrieval",
  };

  try {
    // §9: a live_required session's read never serves the page cache —
    // the 4th extractUrl arg carries the gate's policy to this path too.
    const packet = await extractUrl(synthetic, deadline, 0, session.liveRequired);
    applySegmentFilter([packet], focus || session.queryContext);
    renumberPackets([packet], session.nextSource);
    session.nextSource += 1;
    const classification = (packet as { classification?: string }).classification ?? "";
    // §7 final-origin recheck: an on-scope URL can 302 ACROSS a
    // registrable boundary and serve content from a site the scope law
    // would never admit. admitReadUrls checked the REQUESTED URL; the
    // FINAL primary document must pass the same wall, or the redirect
    // launders off-site content into a site-bound answer. With an armed
    // scope the read fails honestly, naming the landing site; with no
    // boundary the page is kept and the entry carries the final origin
    // truthfully (redirectedTo) — the passages already name the site
    // that served them.
    const redirected = classification === "SUCCESS_REDIRECTED" && packet.url !== url;
    if (redirected) {
      const sHosts =
        session.scope && isEnforceableScope(session.scope) ? scopeHosts(session.scope) : [];
      if (sHosts.length > 0 && !sHosts.some((h) => domainWithin(hostOf(packet.url), h))) {
        return {
          entry: { url, fetched: false, redirectedTo: packet.url },
          citation: null,
          failure: {
            url,
            failure: "off_scope_redirect",
            detail:
              `${url} now resolves to ${packet.url}, outside the task scope (${sHosts.join(", ")}) — ` +
              "content from the landing site was not read",
          },
        };
      }
    }
    // Focus-window law (universal research-depth audit 2026-11-05,
    // refined by WS11): several non-overlapping windows are ranked by
    // distinct, rarity-weighted focus coverage instead of one window on
    // the last match; the block-level truncation flag and the
    // dropped-sections disclosure below report honestly what was left
    // outside the returned windows.
    const fWords = focusTokens(focus || session.queryContext);
    const blocks: string[] = [];
    let blocksCut = false;
    let droppedSections = 0;
    for (const p of packet.passages) {
      const t = p.passageText;
      if (t.trim() === "") continue;
      if (t.length > MAX_PASSAGE_CHARS) {
        blocksCut = true;
        const win = selectFocusWindows(t, fWords);
        blocks.push(win.text);
        droppedSections += win.dropped;
      } else {
        blocks.push(t);
      }
      if (blocks.length >= MAX_PASSAGES_PER_PAGE) break;
    }
    const hasText = blocks.length > 0;
    let failure: RetrievalFailureEntry | null = null;
    if (classification.startsWith("FAIL") || classification === "PAGE_BUDGET_TIMEOUT") {
      failure = {
        url,
        failure: classifyRetrievalFailure({ classification }),
        detail: classification || undefined,
      };
    }
    if (!hasText) {
      return {
        entry: { url, title: packet.title || domain, fetched: false },
        citation: null,
        failure: failure ?? { url, failure: "parse_failure", detail: "no readable text" },
      };
    }
    // Shared per-batch char allowance: trim whole passages, never split one.
    let used = 0;
    const kept: string[] = [];
    for (const b of blocks) {
      if (used + b.length > charBudgetLeft) break;
      used += b.length;
      kept.push(b);
    }
    if (kept.length === 0) {
      return {
        entry: { url, title: packet.title || domain, fetched: true, omitted: "char_budget" },
        citation: null,
        failure,
      };
    }
    const citation: CitationSeed = {
      sourceId: packet.sourceId,
      url: packet.url,
      title: packet.title,
      domain: packet.domain,
      ...(packet.publishedAt !== undefined ? { publishedAt: packet.publishedAt } : {}),
    };
    // Route inventory (universal research-depth law): real links inside
    // the FETCHED content are surfaced so the investigator can follow a
    // named detail/catalog route with one bounded read instead of
    // re-searching. Inventory only — the follow-up fetch is what makes
    // it evidence.
    const routeLinks = collectRouteLinks(packet.url, packet.passages);
    return {
      entry: {
        url,
        title: packet.title || domain,
        domain: packet.domain,
        ...(redirected ? { redirectedTo: packet.url } : {}),
        ...(packet.publishedAt !== undefined ? { publishedDate: packet.publishedAt } : {}),
        extraction: packet.extraction,
        ...(classification ? { classification } : {}),
        sourceId: packet.sourceId,
        passages: kept,
        // Honest disclosure: content was discarded either by dropping
        // whole passage blocks OR by windowing/cutting inside them.
        // WS11: a window drop is not invisible — count the focus-matched
        // clusters left outside the returned windows and hand the
        // investigator an explicit continuation affordance.
        truncated: kept.length < blocks.length || blocksCut,
        ...(droppedSections > 0
          ? {
              droppedSections,
              continuationHint:
                "focus-matched sections beyond the window budget were not returned; call read_page again on this URL with a different focus to retrieve them",
            }
          : {}),
        ...(routeLinks.length > 0 ? { links: routeLinks } : {}),
      },
      citation,
      failure,
    };
  } catch (err: unknown) {
    return {
      entry: { url, fetched: false },
      citation: null,
      failure: {
        url,
        failure: classifyRetrievalFailure({ errorMessage: err instanceof Error ? err.message : String(err) }),
      },
    };
  }
}

/** Shared batch reader — returns the page entries + failures + citations. */
async function readUrlBatch(
  session: WebToolSession,
  urls: string[],
  focus: string,
  deadline: number,
): Promise<{ pages: Record<string, unknown>[]; failures: RetrievalFailureEntry[]; citations: CitationSeed[]; omittedCount: number }> {
  const pages: Record<string, unknown>[] = [];
  const failures: RetrievalFailureEntry[] = [];
  const citations: CitationSeed[] = [];
  let charBudgetLeft = READ_PAGE_TEXT_BUDGET;
  let omittedCount = 0;
  for (const url of urls) {
    const attempt = await readOneUrl(session, url, focus, deadline, charBudgetLeft);
    pages.push(attempt.entry);
    if (attempt.failure) failures.push(attempt.failure);
    if (attempt.citation) citations.push(attempt.citation);
    const entry = attempt.entry as { passages?: string[]; omitted?: string };
    if (Array.isArray(entry.passages)) {
      for (const b of entry.passages) charBudgetLeft -= b.length;
      if (charBudgetLeft < 0) charBudgetLeft = 0;
    }
    if (entry.omitted === "char_budget") omittedCount += 1;
  }
  return { pages, failures, citations, omittedCount };
}

/** WS18 failure provenance: target + classifier code per failed lookup. */
function failureProvenance(
  f: RetrievalFailureEntry[],
): { target: string; code: string }[] | undefined {
  return f.length === 0
    ? undefined
    : f.map((e) => ({ target: e.query ?? e.url ?? "?", code: String(e.failure) }));
}

function budgetExhaustedEnvelope(
  session: WebToolSession,
  tool: string,
  what: string,
  targets?: { queries?: string[]; urls?: string[] },
) {
  // WS18: a refusal still names WHAT it refused — a ledger full of bare
  // zeros cannot support truthful "what was attempted" diagnostics.
  recordAction(session, {
    tool, ok: false, error: "budget_exhausted", requested: 0, retrieved: 0, failed: 0,
    queries: targets?.queries && targets.queries.length > 0 ? targets.queries : undefined,
    urls: targets?.urls && targets.urls.length > 0 ? targets.urls : undefined,
  });
  return {
    ok: false,
    tool,
    searchSessionId: session.searchSessionId,
    error: "budget_exhausted",
    detail: `${what} budget spent (${tool === "web_search" ? session.budget.maxSearchCalls + " search call(s)" : session.budget.maxReadUrls + " URL read(s)"}). Answer from the evidence you already have and state plainly what is still missing.`,
    remainingBudget: remainingBudget(session),
  };
}

function invalidArgsEnvelope(
  session: WebToolSession,
  tool: string,
  detail: string,
  targets?: { queries?: string[]; urls?: string[] },
) {
  // WS18: record the PARSEABLE target subset when args were partly valid
  // (empty after filtering ⇒ no phantom field, nothing was usable).
  recordAction(session, {
    tool, ok: false, error: "invalid_arguments", requested: 0, retrieved: 0, failed: 0,
    queries: targets?.queries && targets.queries.length > 0 ? targets.queries : undefined,
    urls: targets?.urls && targets.urls.length > 0 ? targets.urls : undefined,
  });
  return {
    ok: false,
    tool,
    searchSessionId: session.searchSessionId,
    error: "invalid_arguments",
    detail,
    remainingBudget: remainingBudget(session),
  };
}

/**
 * Task-scope + read-budget admission for fetched URLs (2026-11-04 audit
 * fix): web_search URL-shaped queries used to bypass BOTH checks that
 * read_page enforces — the scope gate ran nowhere and readUrlsUsed was
 * incremented past the cap. One chokepoint, both callers. Returns the URLs
 * actually admitted (budget consumed is recorded here, never by callers).
 */
function admitReadUrls(session: WebToolSession, urls: string[], notices: string[]): string[] {
  const allowed = Math.max(0, session.budget.maxReadUrls - session.readUrlsUsed);
  const sHosts = session.scope && isEnforceableScope(session.scope)
    ? scopeHosts(session.scope)
    : [];
  const admitted = sHosts.length === 0
    ? urls
    : urls.filter((u) => sHosts.some((h) => domainWithin(hostOf(u), h)));
  if (admitted.length < urls.length) {
    const blocked = urls.filter((u) => !admitted.includes(u));
    for (const u of blocked.slice(0, 3)) {
      notices.push(`read blocked: ${hostOf(u) || u} is outside the task scope (${sHosts.join(", ")})`);
    }
    if (blocked.length > 3) {
      notices.push(`(${blocked.length - 3} more off-scope reads blocked)`);
    }
  }
  const keep = admitted.slice(0, allowed);
  if (keep.length < admitted.length) {
    notices.push(`read budget exhausted: ${admitted.length - keep.length} URL(s) dropped (remaining ${allowed})`);
  }
  session.readUrlsUsed += keep.length;
  return keep;
}

/* ── web_search executor ───────────────────────────────────────────────── */

function mapIntent(raw: unknown): SearchDecision["queries"][number]["intent"] {
  const list = Array.isArray(raw) ? raw : [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const v = item.toLowerCase().trim();
    if (v === "news" || v === "docs" || v === "code" || v === "academic" || v === "forum") {
      return v;
    }
  }
  return "general";
}

/**
 * Execute one `web_search` round (⇔ Rust `exec_web_search`). `citations`
 * is an OUT channel — page reads routed here number their packets into the
 * session and the loop merges them into the [S#] map (the model-visible
 * JSON stays clean).
 */
export async function execWebSearchTool(
  session: WebToolSession,
  args: Record<string, unknown>,
  citations: CitationSeed[],
): Promise<Record<string, unknown>> {
  const notices: string[] = [];
  const queries = (Array.isArray(args.queries) ? args.queries : [])
    .filter((q): q is string => typeof q === "string" && q.trim() !== "")
    .map((q) => q.trim())
    .slice(0, 4);
  const missing = (Array.isArray(args.missing_claims) ? args.missing_claims : [])
    .filter((c): c is string => typeof c === "string" && c.trim() !== "");
  if (queries.length === 0 || missing.length === 0) {
    return invalidArgsEnvelope(session, "web_search", "queries[] (1-4) and missing_claims[] (1+) are both required", { queries });
  }
  if (session.searchesUsed >= session.budget.maxSearchCalls) {
    return budgetExhaustedEnvelope(session, "web_search", "web_search", { queries });
  }
  session.searchesUsed += 1;

  const freshness = typeof args.freshness === "string"
    ? (args.freshness as SearchDecision["freshness"])
    : "any";
  // WS14 (audit 2026-11-05 item 14): effective freshness PER OPERATION.
  // The gate's session policy is a floor, never a ceiling — a realtime
  // web_search call's URL-shaped reads went through the UNCHANGED session
  // policy, so a cached page body (Tier 0, incl. cached render tiers) or a
  // Wayback snapshot could answer "the price right now". Strengthening is
  // monotonic within the turn: once live reads are required, later reads
  // inherit them (a softer later op never re-opens the page cache). The
  // strengthened session.liveRequired is the SAME arg readOneUrl already
  // passes to extractUrl (~:601) — page cache, render-cache and archive
  // tiers all gate on it; the engine leg carries the op's freshness
  // directly (metasearch below). Exact mapping: only "realtime" is
  // live_required; "day"/"week" (live_preferred — a query-cache write-TTL
  // law) must NOT flip this binary.
  if (retrievalModeForFreshness(freshness) === "live_required") {
    session.liveRequired = true;
  }
  const intent = mapIntent(args.desired_source_types);
  const focus = typeof args.reason === "string" ? args.reason : "";

  // §11.18: URL-shaped "queries" are READ semantics, never engine queries.
  const searchQueries: string[] = [];
  const readUrls: string[] = [];
  for (const q of queries) {
    if (URL_SHAPE.test(q)) {
      readUrls.push(q);
      notices.push(`url-shaped query routed to read_page semantics: ${q}`);
    } else {
      searchQueries.push(q);
    }
  }

  const failures: RetrievalFailureEntry[] = [];
  const queryResults: { query: string; intent: string; resultCount: number }[] = [];
  const merged: RankedResult[] = [];
  const seen = new Set<string>();
  if (searchQueries.length > 0) {
    const perQuery = await Promise.all(
      searchQueries.map(async (query) => {
        try {
          const rs = await metasearch([{ query, intent, freshness }], TOOL_SEARCH_CAP);
          return { query, rs };
        } catch (err: unknown) {
          failures.push({
            query,
            failure: classifyRetrievalFailure({ errorMessage: err instanceof Error ? err.message : String(err) }),
          });
          return { query, rs: [] as RankedResult[] };
        }
      }),
    );
    for (const { query, rs } of perQuery) {
      queryResults.push({ query, intent, resultCount: rs.length });
      for (const r of rs) {
        const key = normalizeUrl(r.url);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(r);
      }
    }
  }

  // Task-scope admission (audit 2026-11-02, brief #4/#6/#9): a site-bound
  // operational scope is enforced on evidence ADMITTED to this session —
  // off-scope results are dropped with HONEST notices (never silent), and
  // unresolved targets resolve ONLY through real SERP urls (validated PSL
  // hosts), never a fabricated domain. The session scope only narrows.
  // No mandatory hosts (unresolved-only scope) ⇒ discovery stays legal,
  // matching planner-law's two-mode domain control.
  if (session.scope && isEnforceableScope(session.scope)) {
    if (session.scope.targets.some((t) => t.state === "unresolved")) {
      session.scope = resolveTaskScope(session.scope, merged.map((r) => r.url));
    }
    const hosts = scopeHosts(session.scope);
    if (hosts.length > 0) {
      const dropped: string[] = [];
      for (let i = merged.length - 1; i >= 0; i -= 1) {
        const r = merged[i];
        const host = hostOf(r.url) || r.domain;
        if (!hosts.some((h) => domainWithin(host, h))) {
          dropped.push(host || r.domain || "?");
          merged.splice(i, 1);
        }
      }
      for (const d of dropped.slice(0, 3)) {
        notices.push(`off-scope result dropped: ${d} (task scope: ${hosts.join(", ")})`);
      }
      if (dropped.length > 3) {
        notices.push(`(${dropped.length - 3} more off-scope results dropped)`);
      }
    }
  }

  const results = merged.slice(0, MAX_RESULTS).map((r) => ({
    url: r.url,
    title: r.title,
    snippet: r.snippet.length > MAX_SNIPPET_CHARS ? r.snippet.slice(0, MAX_SNIPPET_CHARS) + "…" : r.snippet,
    domain: r.domain,
    ...(r.publishedDate !== undefined ? { publishedDate: r.publishedDate } : {}),
    engine: r.engine,
    origin: r.origin ?? "search",
  }));

  const out: Record<string, unknown> = {
    ok: true,
    tool: "web_search",
    searchSessionId: session.searchSessionId,
    queryResults,
    resultsReturned: results.length,
    results,
    remainingBudget: remainingBudget(session),
  };
  if (readUrls.length > 0) {
    // §11.18 + audit 2026-11-04: url-shaped queries go through the SAME
    // admission law as read_page (scope gate + read budget), never a
    // no-check fast path.
    const keep = admitReadUrls(session, readUrls, notices);
    if (keep.length > 0) {
      const batch = await readUrlBatch(session, keep, focus, Date.now() + 20000);
      out.pages = batch.pages;
      batch.failures.forEach((f) => failures.push(f));
      batch.citations.forEach((c) => citations.push(c));
      if (batch.omittedCount > 0) notices.push(`${batch.omittedCount} page(s) omitted: read_page char budget spent`);
    }
  }
  if (failures.length > 0) out.failures = failures;
  if (notices.length > 0) out.notices = notices;
  // Entry-shape law: only FAILED pages carry fetched:false; a successful
  // read rides with NO fetched key at all (fetched:true appears solely on
  // char-budget omissions) — so honest retrieval counts fetched !== false.
  const pagesOk = (out.pages as Record<string, unknown>[] | undefined)
    ?.filter((p) => p.fetched !== false).length ?? 0;
  recordAction(session, {
    tool: "web_search",
    ok: true,
    requested: queryResults.length + readUrls.length,
    retrieved: results.length + pagesOk,
    failed: failures.length,
    // WS18 exact provenance: every target this call was issued against,
    // the URL-shaped reads it routed, each failed lookup's classifier
    // code, and the [S#] sources THIS action minted.
    queries: queries.length > 0 ? queries : undefined,
    urls: readUrls.length > 0 ? readUrls : undefined,
    failures: failureProvenance(failures),
    sources: citations.length > 0 ? citations.map((c) => c.sourceId) : undefined,
  });
  // Journal what was REALLY retrieved (post-admission `results`, never the
  // raw merged list): what lands in the journal is exactly what the model
  // was allowed to see.
  journalWebSearchSources(session, searchQueries, freshness, results);
  return out;
}

/* ── read_page executor ────────────────────────────────────────────────── */

/** Execute one `read_page` round (⇔ Rust `exec_read_page`). */
export async function execReadPageTool(
  session: WebToolSession,
  args: Record<string, unknown>,
  citations: CitationSeed[],
): Promise<Record<string, unknown>> {
  const urls = (Array.isArray(args.urls) ? args.urls : [])
    .filter((u): u is string => typeof u === "string" && URL_SHAPE.test(u.trim()))
    .map((u) => u.trim())
    .slice(0, 8);
  if (urls.length === 0) {
    return invalidArgsEnvelope(session, "read_page", "urls[] must hold 1-8 absolute http(s) URLs", { urls });
  }
  const allowed = Math.max(0, session.budget.maxReadUrls - session.readUrlsUsed);
  if (allowed === 0) {
    return budgetExhaustedEnvelope(session, "read_page", "read_page", { urls });
  }
  const notices: string[] = [];
  // Task-scope admission for read_page (brief #6/#8): a read_page argument
  // can never BROADEN the scope — an off-scope URL is denied BEFORE the
  // fetch with an honest notice. Shared chokepoint with web_search's
  // url-shaped queries (admitReadUrls) — budget consumption recorded there.
  const keep = admitReadUrls(session, urls, notices);

  const focus = typeof args.focus === "string" && args.focus.trim() !== "" ? args.focus.trim() : "";
  const rawTimeout = typeof args.timeoutMs === "number" ? args.timeoutMs : 20000;
  const timeoutMs = Math.min(60000, Math.max(1000, Math.round(rawTimeout)));
  const deadline = Date.now() + timeoutMs;

  const batch = await readUrlBatch(session, keep, focus, deadline);
  batch.citations.forEach((c) => citations.push(c));
  if (batch.omittedCount > 0) notices.push(`${batch.omittedCount} page(s) omitted: read_page char budget spent`);

  const out: Record<string, unknown> = {
    ok: true,
    tool: "read_page",
    searchSessionId: session.searchSessionId,
    pages: batch.pages,
    remainingBudget: remainingBudget(session),
  };
  if (batch.failures.length > 0) out.failures = batch.failures;
  if (notices.length > 0) out.notices = notices;
  recordAction(session, {
    tool: "read_page",
    ok: true,
    requested: urls.length,
    retrieved: batch.pages.filter((p) => p.fetched !== false).length,
    failed: batch.failures.length,
    // WS18 exact provenance (⇔ the web_search site above).
    urls: urls.length > 0 ? urls : undefined,
    failures: failureProvenance(batch.failures),
    sources: citations.length > 0 ? citations.map((c) => c.sourceId) : undefined,
  });
  return out;
}
