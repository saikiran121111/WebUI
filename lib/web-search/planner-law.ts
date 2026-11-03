/**
 * P4 — Deterministic planner law (§11.5/§11.6/§11.14/§11.17/§11.21).
 *
 * A pure, model-free law layer that derives domain control, coarse
 * localization, expected source types, budgets, sufficiency, and the
 * gap-demand contract from the user prompt + gate decision. The gate wire
 * schema (SearchDecisionSchema) is deliberately NOT extended — the model
 * cannot be trusted to emit these fields, and Rust `parse_search_decision`
 * enforces a strict top-level allowlist. Everything here is deterministic
 * text law so the answer never depends on an extra LLM call (§11.22).
 *
 * Domain-control law (search-policy correction 2026-11-02):
 * `blockedDomains` is a HARD exclusion populated ONLY when the USER
 * explicitly blocks a domain (a block-scope segment they wrote) or a
 * request-level domain policy requires it — never auto-populated because
 * a source is merely weaker. Reddit/Quora/Wikipedia/forums are NEVER
 * blocked by default: their weakness is a RANKING problem owned by the
 * soft source-authority prior in the existing reranking layer
 * (`reranker.ts` → `authorityMultiplier`). This module only EXPRESSes
 * preferences (allowedDomains = hard positive restriction, preferredDomains
 * = positive ranking bias); the reranker decides strength. No duplicate
 * decision logic here.
 *
 * Privacy law (§11.17/§11.22): `location` is only a coarse phrase lifted
 * from the user's own words — never a precise IP, coordinates, or derived
 * geolocation. Nothing here sends account data to providers; the location
 * only rides into derived queries. AMENDED 2026-11-04 (user instruction):
 * when a LOCAL-intent query names no place, the law may fall back to the
 * system's own coarse country name (OS locale region) — this is a local
 * app, the machine IS the user's location authority; still country-level
 * only, never coordinates.
 *
 * Historical Rust mirror (removed with the crate, 2026-11-03 TS rollback):
 * planner_law.rs. Regex parity
 * notes: patterns here avoid lookaround; the location regexes use
 * Unicode word/letter semantics on BOTH sides (JS /u flag ⇔ Rust default
 * Unicode mode) — a deliberate divergence from the ASCII-`\b` legacy
 * planner regexes, documented in the Rust header.
 */
import type { EvidencePacket, EvidencePassage, RankedResult, SearchDecision } from "./types";
import type { CoverageReport, PlannedQuery } from "./query-planner";
import { sourceClass } from "./query-planner";
import { isEnforceableScope, registrableHost, scopeHosts, type TaskScope } from "../decision/task-scope";
import { systemRegionName } from "./local-context";

/* ── budget (§11.21) ─────────────────────────────────────────────────── */

export interface SearchBudget {
  /** Hard ceiling on planned sub-queries (planQueries cap). */
  maxQueryWaves: number;
  /** First-hop page-fetch ceiling (mirrors READ_MAX_PAGES). */
  maxPageFetches: number;
  /** 2nd-hop / wave page-fetch ceiling (mirrors extractAll(gap, 3)). */
  maxGapPageFetches: number;
  /** §11.6 deep-research follow-up query budget (deep depth only). */
  demandWaveQueries: number;
  /** Final passage ceiling (mirrors rerank top-k 15). */
  maxPassages: number;
}

/**
 * Fast-search vs deep-research duality (§11.22): the same primitives run
 * at every depth; only the demand-wave follow-up budget widens for deep.
 * Ceilings mirror the constants already enforced by pipeline.ts
 * (READ_MAX_PAGES=10, gap extractAll=3, rerank k=15) — kept in sync by
 * the P4 tests, not re-imported (planner-law must not import pipeline).
 */
export function budgetForDepth(depth: SearchDecision["depth"]): SearchBudget {
  const base: SearchBudget = {
    maxQueryWaves: 4,
    maxPageFetches: 10,
    maxGapPageFetches: 3,
    demandWaveQueries: 0,
    maxPassages: 15,
  };
  // A two-word factual query never gets an investigation budget: the wave
  // only arms at depth "deep" (§11.21).
  if (depth === "deep") base.demandWaveQueries = 2;
  return base;
}

/* ── planner law (§11.17) ────────────────────────────────────────────── */

export interface PlannerLaw {
  allowedDomains: string[];
  blockedDomains: string[];
  preferredDomains: string[];
  /**
   * Task-scope audit 2026-11-02 (brief #5/#6): the VERIFIED hosts of a
   * server-derived TaskScope when it is enforceable. A MANDATORY
   * operational boundary — distinct from allowedDomains (an "only use
   * X" preference the USER wrote) and preferredDomains (a ranking
   * bias). When non-empty, applyDomainControl admits evidence ONLY
   * inside mandatory ∪ allowed for EVERY origin (brief #9), and
   * companion-query emission gets first claim on the capped plan slots
   * (brief #4: scope companions must not die at the plan cap).
   * Empty ⇒ behavior is byte-identical to the pre-audit baseline.
   */
  mandatoryHosts: string[];
  /** Coarse localization phrase from the user's own words, or null. */
  location: string | null;
  /** "pdf" | "github" | "profiles" | "official_docs" | "reviews" |
   *  "pricing" | "news" | "papers" | "forums" | "code" (deduped). */
  expectedSourceTypes: string[];
  budget: SearchBudget;
}

// Sentence segmentation must NOT shred dotted domains: a "." splits only
// when it ends a sentence (whitespace or end-of-text follows), while "!",
// "?", and newlines always split. No lookaround (regex-crate parity):
// `(?:\s|$)` consumes the terminator. ⇔ re_segment_split in planner_law.rs.
const SEGMENT_SPLIT_RE = /(?:[!?\n]+|\.(?:\s|$))/;
const DOMAIN_TOKEN_RE = /(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}/gi;
const SITE_OP_RE = /\bsite:\s*([a-z0-9][a-z0-9.:-]*(?:\/[^\s]*)?)/gi;
const ONLY_SCOPE_RE =
  /\bonly\s+(?:search|searching|use|using|check|checking|consult|look|refer|stick|restrict|trust|results?|from)\b/i;
const BLOCK_SCOPE_RE =
  /\b(?:don'?t|do\s+not|never|avoid|skip|exclude|without)\b/i;
/** Platform names usable as block verbs without a written domain token.
 *  NEVER a default block-list: consulted ONLY inside block-scope segments
 *  the USER wrote (policy correction 2026-11-02 — weak sources are softly
 *  ranked in reranker.ts, never blocked by default). */
const BLOCK_NAMES_RE =
  /\b(?:reddit|quora|facebook|instagram|twitter|pinterest|medium|tiktok|youtube|4chan)s?\b/gi;
const NAME_TO_DOMAIN: Record<string, string> = {
  reddit: "reddit.com", quora: "quora.com", facebook: "facebook.com",
  instagram: "instagram.com", twitter: "twitter.com", pinterest: "pinterest.com",
  medium: "medium.com", tiktok: "tiktok.com", youtube: "youtube.com", "4chan": "4chan.org",
};
const OFFICIAL_SOURCE_RE =
  /\bofficial\s+sources?\b|\bonly\s+official\b|\bstick\s+to\s+official\b|\bofficial\s+(?:documentation|docs)\b/i;
// (BRAND_DOCS_RE / BRAND_DOCS_REV_RE / BRAND_STOPWORDS deleted by the
// task-scope audit 2026-11-02, brief #5: they fabricated preferred
// domains via inferBrandDomain ("search xyz docs" → xyz.com). Docs
// expectations survive via sourceClass → expectedSourceTypes below;
// operational/site-bound phrasing reaches the law through the
// TaskScope's mandatoryHosts instead — see lib/decision/task-scope.ts.)

const LOCAL_INTENT_RE =
  /\b(weather|forecast|temperature|humidity|air\s+quality|aqi|restaurant|cafe|coffee\s+shop|food|delivery|hotel|motel|guesthouse|shop|store|market|mall|nearby|near\s+me|around\s+me|close\s+by|event|concert|meetup|webinar|festival|job|vacancy|hiring|opening|salon|clinic|hospital|dentist|doctor|plumber|electrician|mechanic|gym|tour|travel|flight|train|bus|route|directions|traffic|real\s+estate|rent|rental)s?\b/i;
// Unicode letter semantics on BOTH sides (JS /u ⇔ Rust default Unicode).
const LOCATION_PHRASE_RE =
  /\b(?:near|around|close\s+to|in|from)\s+([A-Z][\p{Ll}'’]{2,24}(?:\s+(?:[a-z]{1,3}|[A-Z][\p{Ll}'’]{2,24})){0,2})/gu;

// Pure domain helpers moved to ./domain-match (P7 browser-fix 2026-11-02) so
// client-side importers (rich-results.ts) never drag this module's server-only
// query-planner/metasearch/net chain (impit native) into the Next bundle.
// Re-exported here — planner-law's public surface is unchanged.
import { domainWithin, normalizeDomain } from "./domain-match";
export { domainWithin, normalizeDomain };

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    const m = DOMAIN_TOKEN_RE.exec(url);
    DOMAIN_TOKEN_RE.lastIndex = 0;
    return m ? m[0] : "";
  }
}

function pushUnique(list: string[], v: string): void {
  const d = normalizeDomain(v);
  if (d && !list.includes(d)) list.push(d);
}

function extractLocation(prompt: string): string | null {
  if (!LOCAL_INTENT_RE.test(prompt)) return null;
  LOCATION_PHRASE_RE.lastIndex = 0;
  const m = LOCATION_PHRASE_RE.exec(prompt);
  if (!m) return null;
  const name = m[1].replace(/\s+/g, " ").trim();
  if (!name) return null;
  // Coarse-only law: never more than 3 words, never coordinates.
  const words = name.split(" ").slice(0, 3);
  return words.join(" ");
}

/**
 * System-derived coarse location (user instruction 2026-11-04): a
 * LOCAL-intent query that names no place ("restaurants near me",
 * "delivery") uses this machine's own country — a local app's system
 * locale IS the user's location context, and it is now also sent to
 * the model so it can interpret the answer. Coarse-only law unchanged:
 * one country name, never coordinates, never a street.
 */
function systemLocationFallback(prompt: string): string | null {
  if (!LOCAL_INTENT_RE.test(prompt)) return null;
  return systemRegionName();
}

/**
 * Derive the deterministic planner law from the user prompt + gate
 * decision. Gate `queries[].preferred_domains` always merge into the
 * law's preferred list (model suggested sources are honored as
 * preference, never as an allow-list).
 *
 * `scope` (task-scope audit, brief #5): when the server-derived task
 * scope is enforceable, its verified hosts become MANDATORY — a hard
 * operational boundary kept strictly apart from these soft research
 * preferences. Optional parameter: existing 2-arg callers keep their
 * exact behavior (mandatoryHosts = []). Mirrors Rust `derive_law`.
 */
export function derivePlannerLaw(
  userPrompt: string,
  decision: SearchDecision,
  scope?: TaskScope,
): PlannerLaw {
  const allowed: string[] = [];
  const blocked: string[] = [];
  const preferred: string[] = [];
  const mandatory: string[] =
    scope && isEnforceableScope(scope)
      ? [...new Set(scopeHosts(scope).map(normalizeDomain).filter(Boolean))]
      : [];

  for (const seg of userPrompt.split(SEGMENT_SPLIT_RE)) {
    const domains = (seg.match(DOMAIN_TOKEN_RE) ?? []).map(normalizeDomain);
    // Plural-tolerant lookup: "don't use reddits" still blocks reddit.com.
    const names = (seg.match(BLOCK_NAMES_RE) ?? []).flatMap((n) => {
      const k = n.toLowerCase();
      const d = NAME_TO_DOMAIN[k] ?? NAME_TO_DOMAIN[k.replace(/s$/, "")];
      return d ? [d] : [];
    });
    const tokens = [...new Set([...domains, ...names])];
    if (tokens.length === 0) continue;
    if (ONLY_SCOPE_RE.test(seg)) {
      for (const d of tokens) pushUnique(allowed, d);
    } else if (BLOCK_SCOPE_RE.test(seg)) {
      for (const d of tokens) pushUnique(blocked, d);
    }
  }

  // Explicit site: operators in the USER PROMPT are user-directed scoping
  // (§11.17). Gate-emitted site: stays targeted-query guidance only.
  SITE_OP_RE.lastIndex = 0;
  let sm: RegExpExecArray | null;
  while ((sm = SITE_OP_RE.exec(userPrompt)) !== null) {
    pushUnique(allowed, sm[1]);
  }

  // Preferred ≠ allowed: an "official sources" demand must never
  // fabricate an allow-list (§11.17) — it only steers the expected
  // source type below. The old BRAND_DOCS brand-inference block was
  // deleted by the task-scope audit (brief #5): it invented domains.
  // "do this in Blinkit" / "only use Blinkit" now arrive as the
  // TaskScope's mandatory hosts — derived from the user's words,
  // resolved only through validated retrieval evidence.

  for (const q of decision.queries) {
    for (const d of q.preferred_domains ?? []) pushUnique(preferred, d);
  }

  // Contradiction law: an explicit block always wins over preference;
  // "only" (allowed) and "don't" (blocked) on the same domain → block wins.
  for (const d of blocked) {
    const ai = preferred.indexOf(d); if (ai >= 0) preferred.splice(ai, 1);
  }

  const expected: string[] = [];
  const cls = sourceClass(userPrompt);
  const classMap: Record<string, string> = {
    pdf: "pdf", github: "github", linkedin: "profiles", docs: "official_docs",
    review: "reviews", pricing: "pricing",
  };
  const want = cls ? classMap[cls] : undefined;
  if (want) expected.push(want);
  if (OFFICIAL_SOURCE_RE.test(userPrompt) && !expected.includes("official_docs")) expected.push("official_docs");
  for (const q of decision.queries) {
    const imap: Record<string, string> = { news: "news", academic: "papers", forum: "forums", code: "code", docs: "official_docs" };
    const w = imap[q.intent];
    if (w && !expected.includes(w)) expected.push(w);
  }

  return {
    allowedDomains: allowed,
    blockedDomains: blocked,
    preferredDomains: preferred,
    mandatoryHosts: mandatory,
    location: extractLocation(userPrompt) ?? systemLocationFallback(userPrompt),
    expectedSourceTypes: expected,
    budget: budgetForDepth(decision.depth),
  };
}

/**
 * Attach or REFRESH the mandatory scope hosts on an existing law.
 * The pipeline derives the law BEFORE the first hop resolves an
 * unresolved target; once resolveTaskScope verifies the host from
 * real retrieval evidence, the gap/demand waves that ride this same
 * law object must enforce it. Mutates and returns the law (the
 * pipeline holds it as a const reference; in-place refresh keeps
 * every downstream consumer honest). Mirrors Rust `apply_scope_to_law`.
 */
export function applyScopeToLaw(law: PlannerLaw, scope: TaskScope | null | undefined): PlannerLaw {
  law.mandatoryHosts =
    scope && isEnforceableScope(scope)
      ? [...new Set(scopeHosts(scope).map(normalizeDomain).filter(Boolean))]
      : [];
  return law;
}

/* ── corroborated destination verification (audit 2026-11-03 items 3/5;
 * live symptom 2026-11-04: "zepto should search zepto") ────────────────
 *
 * The TaskScope law resolves destinations by EQUALITY ONLY: the
 * normalized brand must equal the registrable label. That law is NOT
 * touched here — brand≠domain identities (Zepto → zeptonow.com) must
 * never resolve on string similarity alone, because resemblance is
 * not identity (zeptodiscounts.com is not Zepto).
 *
 * But the live SERP carries identity evidence a bare URL cannot show:
 * when a result's TITLE opens with the brand phrase as its leading
 * words AND the domain's registrable label belongs to the brand's own
 * word family (the label starts with the brand phrase), the site is
 * speaking for itself — that IS the destination, verified by evidence
 * rather than invented. Both signals are required:
 *   - title-leading only (timesofindia.com's "Zepto expands…") =
 *     third-party COVERAGE, never a destination;
 *   - label-prefix only (zeptodiscounts.com with any other title) =
 *     resemblance, never identity;
 *   - ≥2 distinct label families both self-claiming the brand =
 *     genuine ambiguity — nothing is verified (a squatter loudly
 *     titling itself "Zepto…" earns exactly that ambiguity).
 * Hosts within ONE label family (zeptonow.com + zeptonow.in) agree on
 * identity: the most-corroborated registrable host of the single
 * family is verified.
 *
 * A verified destination joins plannerLaw.preferredDomains: the site:
 * companion wave, the fusion preferred-boost, and the reranker's
 * user-designated authority tier all ride it (ORDER, never an
 * admission wall — mandatoryHosts remains the user's explicit-scope
 * boundary alone). Universal by construction: no brand table, no TLD
 * guessing, no website list — evidence comes only from the SERP the
 * engines already returned. */
export interface DestinationEvidenceRow {
  url: string;
  title?: string;
}

const normIdentity = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** True when the title OPENS with the phrase at a word boundary
 *  (leading quotes/brackets/ellipsis stripped; unicode-safe boundary
 *  because JS `\b` is ASCII-only). */
function titleLeadsPhrase(title: string, phrase: string): boolean {
  const core = title.replace(/^[\s"'“”‘’(\[\]…]+/, "");
  if (!core) return false;
  const esc = phrase
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  if (!esc) return false;
  try {
    return new RegExp(`^${esc}(?![\\p{L}\\p{N}])`, "iu").test(core);
  } catch {
    return false;
  }
}

export function corroborateDestinations(
  scope: TaskScope,
  rows: DestinationEvidenceRow[],
): { phrase: string; host: string }[] {
  const out: { phrase: string; host: string }[] = [];
  for (const t of scope.targets) {
    if (t.state !== "unresolved" || !t.phrase) continue;
    const pn = normIdentity(t.phrase);
    if (!pn) continue;
    // label family → (registrable host → corroborating-row count)
    const families = new Map<string, Map<string, number>>();
    for (const row of rows) {
      const host = registrableHost(String(row.url ?? "").trim());
      if (!host) continue;
      const label = host.split(".")[0] ?? "";
      const ln = normIdentity(label);
      if (!ln || !ln.startsWith(pn)) continue;
      if (!titleLeadsPhrase(String(row.title ?? ""), t.phrase)) continue;
      const fam = families.get(ln) ?? new Map<string, number>();
      fam.set(host, (fam.get(host) ?? 0) + 1);
      families.set(ln, fam);
    }
    // zero families = no evidence; two+ families = honest ambiguity —
    // in both cases NOTHING is verified (the target stays unresolved).
    if (families.size !== 1) continue;
    let best = "";
    let bestCount = -1;
    for (const [host, count] of [...families.values()][0]) {
      if (count > bestCount) {
        best = host;
        bestCount = count;
      }
    }
    if (best) out.push({ phrase: t.phrase, host: best });
  }
  return out;
}

/* ── plan application (§11.5/§11.17) ─────────────────────────────────── */

function querySiteDomains(query: string): string[] {
  const out: string[] = [];
  for (const m of query.matchAll(/site:\s*([a-z0-9][a-z0-9.:-]*)(?:\/[^\s]*)?/gi)) {
    out.push(normalizeDomain(m[1]));
  }
  return out;
}

function planCoversDomain(plan: PlannedQuery, domain: string): boolean {
  const d = normalizeDomain(domain);
  if ((plan.preferredDomains ?? []).some((p) => normalizeDomain(p) === d)) return true;
  return querySiteDomains(plan.query).some((s) => s === d || s.endsWith("." + d) || d.endsWith("." + s));
}

/**
 * Emit site-scoped companion queries for allowed/preferred domains that
 * no existing plan already scopes — honoring the existing 4-plan cap and
 * never repeating a scoped domain. Purely additive: planQueries is
 * untouched, so existing behavior (and goldens) stay byte-identical.
 */
export function applyPlannerLaw(plans: PlannedQuery[], law: PlannerLaw): PlannedQuery[] {
  // Mandatory scope hosts get first claim on the capped companion slots
  // (brief #4: scope companions must never die at the plan ceiling).
  // planQueries already emitted the `origin: "scope"` companions for
  // resolved targets, so planCoversDomain skips them — this loop only
  // fills genuine gaps (late-resolved hosts included).
  const targets = [...law.mandatoryHosts, ...law.allowedDomains, ...law.preferredDomains];
  if (targets.length === 0 || plans.length === 0) return plans;
  const out = [...plans];
  const base = out[0].query;
  for (const d of targets) {
    if (out.length >= law.budget.maxQueryWaves) break;
    if (out.some((p) => planCoversDomain(p, d))) continue;
    out.push({
      query: `${base} site:${d}`.slice(0, 200),
      intent: "general",
      preferredDomains: [d],
      origin: "preferred",
    });
  }
  return out;
}

/**
 * Hard domain control on merged results (§11.17). Two modes:
 *  - No mandatory scope (mandatoryHosts empty): baseline behavior —
 *    results the USER directed (origin "user" — pasted URLs) are exempt
 *    from the allowed/blocked law, because the user's own link is never
 *    a casualty of a domain law they wrote for OTHER sources.
 *  - Mandatory scope armed (task-scope audit, brief #6/#9): the task's
 *    operational boundary binds EVERY origin. Off-scope evidence must
 *    never be admitted into a target-labelled answer packet — and a
 *    user-pasted URL only survives when it is itself inside the scope
 *    (a user's explicit extra site is already folded into the scope's
 *    authorizedHosts by deriveTaskScope, so genuine user intent is
 *    never the casualty here).
 */
export function applyDomainControl(results: RankedResult[], law: PlannerLaw): RankedResult[] {
  if (
    law.allowedDomains.length === 0 &&
    law.blockedDomains.length === 0 &&
    law.mandatoryHosts.length === 0
  ) {
    return results;
  }
  return results.filter((r) => {
    const host = r.domain || hostOf(r.url);
    if (law.mandatoryHosts.length === 0) {
      // Legacy path — order preserved byte-for-byte (user exempt first).
      if (r.origin === "user") return true;
      if (law.blockedDomains.some((d) => domainWithin(host, d))) return false;
      if (law.allowedDomains.length > 0 && !law.allowedDomains.some((d) => domainWithin(host, d))) return false;
      return true;
    }
    // Mandatory mode: blocked first, then the scope admission rule.
    if (law.blockedDomains.some((d) => domainWithin(host, d))) return false;
    if (
      law.mandatoryHosts.some((d) => domainWithin(host, d)) ||
      law.allowedDomains.some((d) => domainWithin(host, d))
    ) {
      return true;
    }
    return false;
  });
}

/* ── sufficiency (§11.14) ────────────────────────────────────────────── */

export interface SufficiencyReport {
  enoughSources: boolean;
  keyClaimsSupported: boolean;
  freshnessOk: boolean;
  primaryPresent: boolean;
  independentDomains: boolean;
  contradictionSuspected: boolean;
  pagesUseful: boolean;
  /** All gates pass cleanly → stop early, spend nothing more. */
  stopEarly: boolean;
  /** Distinct usable (non-snippet-only) evidence domains. */
  sourceDomains: string[];
  /** Metric words carrying conflicting values (feeds gap demand). */
  contradictionMetrics: string[];
}

// SUCCESS_* classifications are usable EXCEPT snippet-only extraction
// (§11.14 hard law — a search snippet is not a consulted page).
function countedSourceIds(packets: EvidencePacket[]): Set<string> {
  const ok = new Set<string>();
  for (const p of packets) {
    const cls = p.classification ?? "";
    if (!cls.startsWith("SUCCESS")) continue;
    if (p.extraction === "snippet-only") continue;
    ok.add(p.sourceId);
  }
  return ok;
}

// Contradiction scan: same metric word, different numeric values from
// DIFFERENT sources. Currency symbols stay outside the pattern body so
// the Rust mirror can share the ASCII pattern (post-check adds them).
const METRIC_VALUE_RE =
  /\b(price|cost|salary|revenue|funding|valuation|population|score|rating)\b\D{0,12}?(\d[\d,]*(?:\.\d+)?)/gi;

function detectContradictions(passages: { sourceId: string; passageText: string }[]): { metrics: string[]; suspected: boolean } {
  const byMetric = new Map<string, Map<string, Set<string>>>();
  for (const p of passages) {
    for (const m of p.passageText.matchAll(METRIC_VALUE_RE)) {
      const metric = m[1].toLowerCase();
      const value = m[2].replace(/,/g, "");
      if (!byMetric.has(metric)) byMetric.set(metric, new Map());
      const per = byMetric.get(metric)!;
      if (!per.has(p.sourceId)) per.set(p.sourceId, new Set());
      per.get(p.sourceId)!.add(value);
    }
  }
  const metrics: string[] = [];
  for (const [metric, per] of byMetric) {
    const values = new Set<string>();
    let sourcesWithValues = 0;
    for (const set of per.values()) {
      if (set.size === 0) continue;
      sourcesWithValues += 1;
      for (const v of set) values.add(v);
    }
    if (sourcesWithValues >= 2 && values.size >= 2) metrics.push(metric);
  }
  return { metrics, suspected: metrics.length > 0 };
}

/**
 * §11.14 claim-level pass, reconstructed deterministically from the
 * evidence already in hand — no extra LLM call. Every check maps to a
 * line in the sufficiency checklist; `stopEarly` is true only when the
 * evidence passes cleanly and nothing contradicts.
 */
export function evaluateSufficiency(
  packets: EvidencePacket[],
  topPassages: EvidencePassage[],
  coverage: CoverageReport,
  decision: SearchDecision,
  law: PlannerLaw,
): SufficiencyReport {
  const counted = countedSourceIds(packets);
  const kept = topPassages.filter((p) => counted.has(p.sourceId));
  const sourceDomains = [...new Set(kept.map((p) => p.domain).filter(Boolean))].sort();

  const enoughSources = sourceDomains.length >= 3;
  const independentDomains = sourceDomains.length >= 2;
  const keyClaimsSupported = coverage.coverage >= 0.6;

  const freshnessBanded = ["day", "week", "month", "year", "realtime"].includes(decision.freshness);
  const freshnessOk = !freshnessBanded || kept.some((p) => Boolean(p.publishedAt));

  const primaries = [...law.mandatoryHosts, ...law.allowedDomains, ...law.preferredDomains];
  const primaryPresent =
    primaries.length === 0 ||
    kept.some((p) => primaries.some((d) => domainWithin(p.domain || hostOf(p.url), d)));

  const contradiction = detectContradictions(kept);
  const pagesUseful = counted.size >= 1;

  const gatesPass =
    enoughSources && keyClaimsSupported && freshnessOk && primaryPresent &&
    independentDomains && pagesUseful;

  return {
    enoughSources,
    keyClaimsSupported,
    freshnessOk,
    primaryPresent,
    independentDomains,
    contradictionSuspected: contradiction.suspected,
    pagesUseful,
    stopEarly: gatesPass && !contradiction.suspected,
    sourceDomains,
    contradictionMetrics: contradiction.metrics,
  };
}

/* ── gap demand (§11.6) ──────────────────────────────────────────────── */

/** Exact §11.6 contract shape (snake_case wire vocabulary). */
export interface GapDemand {
  missing_claims: string[];
  queries: string[];
  desired_source_types: string[];
  freshness: SearchDecision["freshness"];
  reason: string;
  remaining_budget: number;
}

const normKey = (q: string): string =>
  q.toLowerCase().replace(/\s+/g, " ").replace(/[^\w\s:./-]/g, "").trim();

const SOURCE_TYPE_WORD: Record<string, string> = {
  official_docs: "official", news: "news", reviews: "review", papers: "paper",
  github: "github", pdf: "pdf", forums: "discussion", code: "code",
};

/**
 * Build the §11.6 gap contract from the sufficiency gaps. NEVER-REPEAT
 * law (§11.6): every candidate variant is checked, case-insensitively,
 * against every query already used this run — a variant ladder
 * (base → "official" → "review" → year) replaces a repeated query, and
 * a base whose whole ladder collides is DROPPED, not emitted.
 */
export function buildGapDemand(
  userPrompt: string,
  coverage: CoverageReport,
  sufficiency: SufficiencyReport,
  decision: SearchDecision,
  law: PlannerLaw,
  usedQueries: string[],
): GapDemand | null {
  if (law.budget.demandWaveQueries <= 0) return null;

  const missing: string[] = [];
  const desired: string[] = [];
  const reasons: string[] = [];
  const year = String(new Date().getUTCFullYear());

  if (!sufficiency.keyClaimsSupported && coverage.missingEntities.length > 0) {
    missing.push(...coverage.missingEntities.slice(0, 4));
    desired.push("official_docs", "news");
    reasons.push("key entities unsupported by evidence");
  }
  if (sufficiency.contradictionSuspected) {
    for (const m of sufficiency.contradictionMetrics) missing.push(`conflicting ${m} across sources`);
    desired.push("reviews", "official_docs");
    reasons.push("conflicting values across sources");
  }
  if (!sufficiency.primaryPresent) {
    missing.push(`primary source (${law.mandatoryHosts[0] ?? law.allowedDomains[0] ?? law.preferredDomains[0] ?? "asked-for source"})`);
    desired.push("official_docs");
    reasons.push("official/primary source missing");
  }
  if (!sufficiency.freshnessOk) {
    missing.push("fresh dated evidence");
    desired.push("news");
    reasons.push(`freshness band "${decision.freshness}" not evidenced`);
  }
  if (!sufficiency.enoughSources) {
    missing.push("additional independent sources");
    desired.push("news", "reviews");
    reasons.push("too few independent domains");
  }
  if (missing.length === 0) return null;

  const entity = coverage.missingEntities[0] ?? userPrompt.trim().split(/\s+/).slice(0, 6).join(" ");
  const bases: string[] = [];
  if (!sufficiency.keyClaimsSupported) {
    bases.push(coverage.gapQuery ?? coverage.missingEntities.slice(0, 3).map((e) => `"${e}"`).join(" "));
  }
  if (sufficiency.contradictionSuspected) {
    bases.push(`${sufficiency.contradictionMetrics[0]} ${entity} official`);
  }
  if (!sufficiency.primaryPresent) {
    const d = law.mandatoryHosts[0] ?? law.allowedDomains[0] ?? law.preferredDomains[0];
    if (d) bases.push(`${entity} site:${d}`);
  }
  if (!sufficiency.freshnessOk) bases.push(`${entity} ${year}`);
  if (!sufficiency.enoughSources) {
    const typeWord = SOURCE_TYPE_WORD[law.expectedSourceTypes[0] ?? ""] ?? "review";
    bases.push(`${userPrompt.trim().split(/\s+/).slice(0, 8).join(" ")} ${typeWord}`);
  }

  const used = new Set(usedQueries.map(normKey));
  const queries: string[] = [];
  for (const base of bases) {
    if (!base.trim()) continue;
    if (queries.length >= law.budget.demandWaveQueries) break;
    for (const suffix of ["", " official", " review", ` ${year}`]) {
      const cand = (base + suffix).trim();
      if (!used.has(normKey(cand))) {
        used.add(normKey(cand));
        queries.push(cand.slice(0, 200));
        break;
      }
    }
  }
  if (queries.length === 0) return null;

  const dedupDesired = [...new Set(desired)];
  return {
    missing_claims: missing.slice(0, 6),
    queries,
    desired_source_types: dedupDesired,
    freshness: decision.freshness,
    reason: reasons.join("; ").slice(0, 200),
    remaining_budget: Math.max(0, law.budget.demandWaveQueries - queries.length),
  };
}
