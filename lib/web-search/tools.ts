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
import { domainWithin } from "./domain-match";
import {
  isEnforceableScope,
  resolveTaskScope,
  scopeHosts,
  type TaskScope,
} from "../decision/task-scope";

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
  };
}

export function remainingBudget(session: WebToolSession) {
  return {
    searches: Math.max(0, session.budget.maxSearchCalls - session.searchesUsed),
    readUrls: Math.max(0, session.budget.maxReadUrls - session.readUrlsUsed),
    rounds: Math.max(0, session.budget.maxToolRounds - session.roundsUsed),
  };
}

/** Append one action-record entry stamped with the current model round. */
export function recordAction(
  session: WebToolSession,
  rec: Omit<ToolActionRecord, "round">,
): void {
  session.actionLedger.push({ ...rec, round: session.roundsUsed });
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

/**
 * Focus-window block cut: when the focus matches past the plain prefix,
 * center the window on the focus's LAST occurrence (requested facts
 * typically sit after the boilerplate intro, not before it). Prefix
 * matches keep the byte-identical plain cut.
 */
function cutPassageWindow(t: string, words: string[]): string {
  const low = t.toLowerCase();
  let pos = -1;
  for (const w of words) {
    const i = low.lastIndexOf(w);
    if (i > pos) pos = i;
  }
  if (pos < MAX_PASSAGE_CHARS) return t.slice(0, MAX_PASSAGE_CHARS) + "…";
  const start = Math.min(pos - Math.floor(MAX_PASSAGE_CHARS / 2), t.length - MAX_PASSAGE_CHARS);
  return "…" + t.slice(start, start + MAX_PASSAGE_CHARS) + "…";
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
    // Focus-window law (universal research-depth audit 2026-11-05): a
    // blind 2000-char prefix cannot reach a requested fact that sits
    // past a long intro. When a focus word matches deeper in a block,
    // center the returned window on its last occurrence and mark both
    // cuts with an ellipsis; the block-level truncation flag below then
    // discloses honestly that page content was discarded.
    const fWords = focusTokens(focus || session.queryContext);
    const blocks: string[] = [];
    let blocksCut = false;
    for (const p of packet.passages) {
      const t = p.passageText;
      if (t.trim() === "") continue;
      if (t.length > MAX_PASSAGE_CHARS) {
        blocksCut = true;
        blocks.push(cutPassageWindow(t, fWords));
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
        truncated: kept.length < blocks.length || blocksCut,
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

function budgetExhaustedEnvelope(session: WebToolSession, tool: string, what: string) {
  recordAction(session, { tool, ok: false, error: "budget_exhausted", requested: 0, retrieved: 0, failed: 0 });
  return {
    ok: false,
    tool,
    searchSessionId: session.searchSessionId,
    error: "budget_exhausted",
    detail: `${what} budget spent (${tool === "web_search" ? session.budget.maxSearchCalls + " search call(s)" : session.budget.maxReadUrls + " URL read(s)"}). Answer from the evidence you already have and state plainly what is still missing.`,
    remainingBudget: remainingBudget(session),
  };
}

function invalidArgsEnvelope(session: WebToolSession, tool: string, detail: string) {
  recordAction(session, { tool, ok: false, error: "invalid_arguments", requested: 0, retrieved: 0, failed: 0 });
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
    return invalidArgsEnvelope(session, "web_search", "queries[] (1-4) and missing_claims[] (1+) are both required");
  }
  if (session.searchesUsed >= session.budget.maxSearchCalls) {
    return budgetExhaustedEnvelope(session, "web_search", "web_search");
  }
  session.searchesUsed += 1;

  const freshness = typeof args.freshness === "string"
    ? (args.freshness as SearchDecision["freshness"])
    : "any";
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
  });
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
    return invalidArgsEnvelope(session, "read_page", "urls[] must hold 1-8 absolute http(s) URLs");
  }
  const allowed = Math.max(0, session.budget.maxReadUrls - session.readUrlsUsed);
  if (allowed === 0) {
    return budgetExhaustedEnvelope(session, "read_page", "read_page");
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
  });
  return out;
}
