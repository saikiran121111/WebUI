/**
 * tools.ts — P2 model-facing web tools: `web_search` + `read_page`.
 *
 * Rust twin: `rust-backend/crates/ruke-websearch/src/tools.rs`. Tool
 * descriptions, the guidance/directive constants, the failure taxonomy,
 * the budget table, and the result envelopes are ⇔-locked with the Rust
 * side (byte probes pin the shared string constants; mirrored vector
 * tests pin the classifier and the tables). The loop that calls these
 * executors lives in `lib/chat/web-tool-loop.ts` ⇔ `ruke-server`'s
 * `chat/web_loop.rs`.
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
import { isSafeUrlWithDns } from "./ssrf";
import type { SearchDecision, RankedResult } from "./types";

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
  | "cancelled";

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

export interface WebToolSession {
  searchSessionId: string;
  budget: WebToolBudget;
  searchesUsed: number;
  readUrlsUsed: number;
  roundsUsed: number;
  /** [S#] continuation after the pipeline's packets (citation-map seed). */
  nextSource: number;
  /** Focus fallback: the user prompt the tool loop was built for. */
  queryContext: string;
}

export function makeWebToolSession(
  depth: WebToolDepth,
  citationSeed: number,
  queryContext: string,
): WebToolSession {
  return {
    searchSessionId: "ws-" + Math.random().toString(36).slice(2, 10),
    budget: webToolBudgetFor(depth),
    searchesUsed: 0,
    readUrlsUsed: 0,
    roundsUsed: 0,
    nextSource: Math.max(1, citationSeed),
    queryContext: queryContext.slice(0, 500),
  };
}

export function remainingBudget(session: WebToolSession) {
  return {
    searches: Math.max(0, session.budget.maxSearchCalls - session.searchesUsed),
    readUrls: Math.max(0, session.budget.maxReadUrls - session.readUrlsUsed),
    rounds: Math.max(0, session.budget.maxToolRounds - session.roundsUsed),
  };
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
    const packet = await extractUrl(synthetic, deadline);
    applySegmentFilter([packet], focus || session.queryContext);
    renumberPackets([packet], session.nextSource);
    session.nextSource += 1;
    const classification = (packet as { classification?: string }).classification ?? "";
    const blocks: string[] = [];
    for (const p of packet.passages) {
      const t = p.passageText;
      if (t.trim() === "") continue;
      blocks.push(t.length > MAX_PASSAGE_CHARS ? t.slice(0, MAX_PASSAGE_CHARS) + "…" : t);
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
    return {
      entry: {
        url,
        title: packet.title || domain,
        domain: packet.domain,
        ...(packet.publishedAt !== undefined ? { publishedDate: packet.publishedAt } : {}),
        extraction: packet.extraction,
        ...(classification ? { classification } : {}),
        sourceId: packet.sourceId,
        passages: kept,
        truncated: kept.length < blocks.length,
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
  return {
    ok: false,
    tool,
    searchSessionId: session.searchSessionId,
    error: "invalid_arguments",
    detail,
    remainingBudget: remainingBudget(session),
  };
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
    session.readUrlsUsed += readUrls.length;
    const batch = await readUrlBatch(session, readUrls, focus, Date.now() + 20000);
    out.pages = batch.pages;
    batch.failures.forEach((f) => failures.push(f));
    batch.citations.forEach((c) => citations.push(c));
    if (batch.omittedCount > 0) notices.push(`${batch.omittedCount} page(s) omitted: read_page char budget spent`);
  }
  if (failures.length > 0) out.failures = failures;
  if (notices.length > 0) out.notices = notices;
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
  const keep = urls.slice(0, allowed);
  if (keep.length < urls.length) {
    notices.push(`read budget exhausted: ${urls.length - keep.length} URL(s) dropped (remaining ${allowed})`);
  }
  session.readUrlsUsed += keep.length;

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
  return out;
}
