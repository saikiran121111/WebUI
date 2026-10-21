/**
 * Candidate entities — the NAMED THINGS hiding inside discovery sources.
 *
 * Hop 1 of a recommendation ask ("best phone under 20000 on amazon") returns
 * listicles and search pages. They NAME the actual products — Honor 200 5G,
 * iQOO Z9 5G, OnePlus Nord CE 4 — but a listicle is a secondary source: it
 * cannot establish that one specific product is buyable TODAY at one specific
 * store. That is the Discovery → Live-Entity-Verification split: the names come
 * from hop 1, the live state has to come from the entity's OWN page.
 *
 * This module reads the names deterministically out of the discovery sources'
 * own structure (headings, numbered listicle entries, bold runs, link text).
 * An LLM call to enumerate them was deliberately NOT used: an unverified model
 * guess about "what exists" is the exact failure class the whole verification
 * layer exists to stop, and it would be structurally identical across listicle
 * formats anyway.
 *
 * Purity contract: candidate phrases are harvested from SEARCH_OR_CATEGORY_PAGE
 * and EDITORIAL_LISTICLE sources only (per the entity-validator's urlType).
 * Canonical pages are full of "Products related to this item" rails —
 * harvesting from them would manufacture entities the user never asked about.
 * The module itself is pure (no network, no model, no side effects); it takes
 * `import type` from web-search so web-verify keeps no runtime edge into it.
 */
import type { EvidencePacket } from "../web-search/types";
import type { EntityValidationReport } from "../web-search/entity-validator";
import { hasAccessoryPhrase } from "./accessory-phrase";

export interface CandidateEntity {
  /** Display form as cleaned from the source, e.g. "Honor 200 5G". */
  phrase: string;
  /** Lower-collapsed form used for dedupe and matching. */
  normalized: string;
  /** Times named across all discovery sources (ranking key). */
  mentions: number;
  /** Discovery sources that named it. */
  sourceIds: string[];
  /** Their domains — used by the hop planner to avoid re-visiting them. */
  domains: string[];
}

export interface CandidateOptions {
  /** Cap on returned candidates (the hop budget, not a discovery cap). */
  max?: number;
  /** Skip accessory-named candidates (phone CASES are not phone candidates). */
  excludeAccessories?: boolean;
  /** Normalized phrases to skip — usually the user's own entity, which the
   *  claim-driven hop already handles. */
  excludePhrases?: string[];
}

/* ── structural harvest patterns ─────────────────────────────────────────── */

const HEADING_RE = /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
const NUMBERED_RE = /^[ \t]*(?:no\.?\s+)?\d{1,2}[.):][ \t]+(.+?)[ \t]*$/gm;
const BOLD_RE = /\*\*([^*\n]{3,80})\*\*/g;
const LINKTEXT_RE = /\[([^\]\n]{3,80})\]\((?:[^)\n]*)\)/g;

/** Segment separators inside one harvested line: comparisons and sub-titles. */
const SEGMENT_SPLIT_RE = /\s*\|\s*|\s+vs\.?\s+|\s+versus\s+|\s+—+\s+|\s*:{1,3}\s+/;

/**
 * Headings that are section furniture, never entity names. The reported class
 * of failure is a hop aimed at "Conclusion"; the reported class ONE is the
 * reverse (recommending an item nobody verified), so this list is generous —
 * a missed candidate costs one wasted search, a generic candidate that slips
 * through costs the same AND teaches nothing.
 */
const GENERIC_HEADING_RE =
  /^(?:introduction|overview|background|conclusions?|final verdict|our verdict|verdict|bottom line|summary|highlights?|tldr|faq|frequently asked questions?|key (?:features|takeaways|points|specs?|differences|details)|table of contents|also (?:read|check|see|watch|view)(?: more)?|related (?:articles?|posts?|products?|items?|links?|videos?|stories)|more (?:stories|products|articles|posts)|our (?:top )?picks?|top picks?|editors? picks?|criteria|methodology|how we (?:test|tested|rated|review\w*)|pros(?: and|,)? cons?|buying guide|specs?(?: and|,)? (?:price|design|comparison)|price (?:and|,)? specs?|price comparison|product comparison(?: table)?|comparison table|in (?:conclusion|summary)|to (?:conclude|sum up)|disclaimer|authors?(?: bio)?|you (?:may|might) (?:also|like|enjoy)|deals? (?:of|for) the week|similar (?:products|items|books)|customers? also (?:bought|viewed|searched|asked)|add to (?:cart|wishlist)|sign in|subscribe|newsletter|skip to (?:content|navigation|main)|privacy policy|terms(?: of use| and conditions)?|cookies?|categories?|filters?|sort by|in stock|on sale|best sellers?|new arrivals?|trending|featured|questions?|answers|reviews?|comments?)\b/i; // headings arrive capitalised ("Also Read")

/** Phrases that ask a question or name a category instead of an entity. */
const NON_ENTITY_START_RE =
  /^(?:how|what|when|where|why|which|who|whom|is|are|was|can|should|do|does|vs|compare|comparison|review(?:s)? of|all|shop|browse|view|buy|order|see)\b/i;

/** Embedded category shapes: "phones under 20000", "jobs in 2026". */
const CATEGORY_EMBED_RE =
  /\b(?:under|below|upto|up to|above|around|near|within)\s+₹?\s?\d|\b(?:phones?|smartphones?|mobiles?|laptops?|restaurants?|jobs?|hotels?|movies?|anime|books?)\s+(?:under|below|near|in|for)\b|\b\d{4}\b.{0,12}\b(?:list|guide|review)\b/i;

/** Storage/spec noise inside names: "Nord CE 4 128GB", "… 50MP". */
const SPEC_NOISE_RE = /\b\d{1,3}\s?(?:gb|tb|mp)\b|\bwith\s+\d{2,3}\s?(?:mp|inch|inches)\b/gi;

/* ── cleaning ────────────────────────────────────────────────────────────── */

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;|&lsquo;|&quot;/g, "'")
    .replace(/&nbsp;|&#\d+;/g, " ");
}

/**
 * One harvested line → a displayable entity phrase, or null if it is not one.
 * The order matters: parentheses go first (that is where the ₹17,499 lives in
 * "## 1. Honor 200 5G (₹17,499)"), then prices/ratings, then numbering.
 */
export function cleanCandidateSegment(raw: string): string | null {
  let s = decode(raw);
  s = s.replace(/\([^)]{0,80}\)|\[[^\]]{0,80}\]/g, " ");
  s = s.replace(/(?:₹|Rs\.?|INR|\$|USD)\s?[\d][\d,.]*(?:\s?(?:k|K|L|Lakh|Cr|crore))?\b/g, " ");
  s = s.replace(/\b\d(?:\.\d)?\s*\/\s*5\b/g, " ");
  s = s.replace(/[★☆⭐]/g, " ");
  s = s.replace(/^(?:top|best|worst)\s+\d+\s*[:.\-]?\s+/i, " ");
  s = s.replace(/^(?:no\.?\s+)?#?\d{1,2}[.):][ \t]+/, " ");
  s = s.replace(/^(?:top|best)\s+(?:of|the)?\s*\d*\s*[:.\-]?\s+/i, " ");
  s = s.replace(/^[\s•·\-*#>|]+|[\s•·,;:.!?|]+$/g, "");
  s = s.replace(SPEC_NOISE_RE, " ");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/\s+(?:with|and|for|the|a|an|of|in|to|at|by)$/i, "");
  if (s.length < 4 || s.length > 60) return null;
  if (GENERIC_HEADING_RE.test(s)) return null;
  if (NON_ENTITY_START_RE.test(s)) return null;
  if (CATEGORY_EMBED_RE.test(s)) return null;
  if (!looksEntityLike(s)) return null;
  return s;
}

/**
 * The entity-likeness gate. Two admissible shapes:
 *   • brand + model number ("Honor 200 5G", "Galaxy S24 Ultra") — capital-led,
 *     contains a digit; the brand may be lower-case-led ONLY in its official
 *     form ("iQOO Z9 5G", "vivo V40 Pro"): not a prose opener, and every
 *     following token capital- or digit-led ("Z9", "5G");
 *   • a proper-name run ("Smriti Restaurant", "Senior Frontend Engineer") —
 *     every token capital-led.
 * Lower-case prose that survived the other filters ("the best option") fails
 * here, which is the point: a candidate drives a live search, and a prose
 * fragment wastes the hop.
 */
const PROSE_FIRST_WORD_RE =
  /^(?:the|a|an|my|our|this|that|these|those|your|their|new|best|top|for|of|and|or|with|in|on|to|at|by|from|buy|deal|deals|offer|offers|review|reviews|specs?|price|prices|compare|budget|under)\b/i;

export function looksEntityLike(s: string): boolean {
  const toks = s.split(/\s+/);
  if (toks.length < 2 || toks.length > 7) return false;
  if (/\d/.test(s)) {
    if (/^[A-Z]/.test(s)) return true;
    if (!/^[a-z]/.test(toks[0]) || PROSE_FIRST_WORD_RE.test(s)) return false;
    return toks
      .slice(1)
      .every((t) => /^[A-Z0-9][A-Za-z0-9&'.\-]*$/.test(t));
  }
  if (!/^[A-Z]/.test(s)) return false;
  return toks.every((t) => /^[A-Z][A-Za-z&'.\-]*$/.test(t));
}

function normalizePhrase(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ── harvest ─────────────────────────────────────────────────────────────── */

interface Draft {
  phrase: string;
  normalized: string;
  sourceIds: Set<string>;
  domains: Set<string>;
}

/**
 * Extract the concrete named entities advertised by this run's discovery
 * sources, ranked by how often the sources actually name them.
 */
export function extractCandidateEntities(
  packets: EvidencePacket[],
  reports: EntityValidationReport[],
  opts: CandidateOptions = {},
): CandidateEntity[] {
  const max = opts.max ?? 3;
  const excludeAccessories = opts.excludeAccessories ?? true;
  const excluded = (opts.excludePhrases ?? [])
    .map((p) => normalizePhrase(p))
    .filter((p) => p.length >= 3);

  const packetById = new Map(packets.map((p) => [p.sourceId, p]));
  // Discovery sources only — and of those, search/category pages and listicles
  // (a dictionary "list of" page is not where shopping candidates come from).
  const discovery = reports.filter(
    (r) => r.urlType === "SEARCH_OR_CATEGORY_PAGE" || r.urlType === "EDITORIAL_LISTICLE",
  );

  const drafts = new Map<string, Draft>();
  const discoveryTexts: string[] = [];

  for (const r of discovery) {
    const packet = packetById.get(r.sourceId);
    if (!packet) continue;
    const text = (packet.passages ?? [])
      .map((p) => String(p.passageText ?? ""))
      .join("\n")
      .slice(0, 30_000);
    discoveryTexts.push(text);

    const raws: string[] = [];
    for (const re of [HEADING_RE, NUMBERED_RE, BOLD_RE, LINKTEXT_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) raws.push(m[1]);
    }
    for (const raw of raws) {
      for (const seg of raw.split(SEGMENT_SPLIT_RE)) {
        const phrase = cleanCandidateSegment(seg);
        if (!phrase) continue;
        const norm = normalizePhrase(phrase);
        if (excludeAccessories && hasAccessoryPhrase(norm)) continue;
        if (excluded.some((e) => norm === e || norm.includes(e))) continue;
        const d =
          drafts.get(norm) ??
          { phrase, normalized: norm, sourceIds: new Set<string>(), domains: new Set<string>() };
        d.sourceIds.add(r.sourceId);
        d.domains.add(packet.domain);
        drafts.set(norm, d);
      }
    }
  }

  // Mention rank across the discovery text: a name the source repeats IS the
  // source's recommendation; a name that appears once in one heading may be a
  // throwaway "you might also like".
  const scored: CandidateEntity[] = [];
  for (const d of drafts.values()) {
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeRe(d.normalized)}(?:[^a-z0-9]|$)`, "gi");
    let mentions = 0;
    for (const t of discoveryTexts) mentions += (t.match(re) ?? []).length;
    if (mentions < 1) mentions = 1;
    scored.push({
      phrase: d.phrase,
      normalized: d.normalized,
      mentions,
      sourceIds: [...d.sourceIds],
      domains: [...d.domains],
    });
  }

  // Subsumption: "Honor 200" extracted from a rail plus "Honor 200 5G" from
  // the heading are one candidate. Keep the longer, more specific name.
  scored.sort((a, b) => b.normalized.length - a.normalized.length);
  const kept: CandidateEntity[] = [];
  for (const c of scored) {
    if (kept.some((k) => k.normalized.includes(c.normalized))) continue;
    kept.push(c);
  }

  kept.sort((a, b) => b.mentions - a.mentions || a.normalized.localeCompare(b.normalized));
  return kept.slice(0, Math.max(0, max));
}

/* ── is the candidate already verified? ──────────────────────────────────── */

const VARIANT_SUFFIX_RE = /\s+[45]\s?g$/;

function slugWords(url: string): string {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname + " " + u.search).replace(/[^A-Za-z0-9]+/g, " ");
  } catch {
    return url.replace(/[^A-Za-z0-9]+/g, " ");
  }
}

/**
 * The candidate's OWN page among the current reports — the condition under
 * which NO second hop is needed. Any non-accessory CANONICAL_ENTITY page whose
 * title / structured work name / URL slug names the candidate counts: a
 * canonical page that says "Currently unavailable" is exactly as verified as
 * one that says InStock — the point of the hop is to READ the state, and the
 * state itself is what the answer must not invent.
 *
 * Matching is contiguous-substring with the trailing connectivity generation
 * token ("5G"/"4G") optionally dropped, so "Honor 200 5G" matches
 * "Honor 200 (Coral Pink…)" but "iQOO Z9s Pro" does NOT match the base
 * "iQOO Z9" page — a variant-mismatched canonical page would re-open the
 * exact fact-to-item misattribution the ledger exists to close.
 */
export function canonicalCovering(
  candidate: CandidateEntity,
  reports: EntityValidationReport[],
): EntityValidationReport | null {
  const core = candidate.normalized.replace(VARIANT_SUFFIX_RE, "").trim();
  if (core.length < 4) return null;
  const re = new RegExp(`(?:^|[^a-z0-9])${escapeRe(core)}(?:[^a-z0-9]|$)`, "i");
  for (const r of reports) {
    if (r.isAccessoryOrMismatch) continue;
    if (r.urlType !== "CANONICAL_ENTITY") continue;
    const hay = [
      r.title,
      r.facts.productName ?? "",
      r.facts.jobTitle ?? "",
      slugWords(r.url),
    ]
      .join(" ")
      .toLowerCase();
    if (re.test(hay)) return r;
  }
  return null;
}
