/**
 * Claim rules: turn per-source facts into per-CLAIM verdicts.
 *
 * A claim is `verified` only when at least one PRIMARY source for that claim
 * type states it and the primary sources agree. A `conflict` lists BOTH
 * values — never a silently averaged or "approximate" one (the reported table
 * printed "~₹16-17K" while its own evidence said ₹18,992 and ₹21,999).
 * Everything else is `unverified`, and unverified means the answer may not
 * state it and may not link it.
 */
import { canBeTheItem, claimEligibility, isSerpLike } from "./link-eligibility";
import { pricesConflict, type AvailabilityState, type SourceFactSet } from "./fact-ledger";
import type { EntityMatcher } from "./entity";
import type { Scenario } from "./scenarios";
import type {
  ClaimStatus,
  ClaimType,
  ClaimVerdict,
  FactHit,
  SourceKind,
  SourceVerdict,
  VerifiedLink,
} from "./types";

/** What a source can support when it carries no usable fact for this ask. */
const ROLE_LIMITATION: Record<SourceKind, { verdict: string; supports: string }> = {
  serp: {
    verdict: "Does not establish current stock for the exact variant.",
    supports: "product discovery only",
  },
  product: {
    verdict: "Product page fetched, but no price or stock data could be parsed from it.",
    supports: "page fetch only",
  },
  "product-listing": {
    verdict: "Category listing of many products — not the requested item's own page.",
    supports: "a list of candidates only",
  },
  "price-aggregator": {
    verdict: "Price-comparison site — an aggregated figure, not the seller's live price.",
    supports: "an estimated price",
  },
  "job-posting": {
    verdict: "Job posting page for the requested role.",
    supports: "the posting itself",
  },
  "review-listing": {
    verdict: "Review or directory listing — it can rate something, it cannot confirm stock.",
    supports: "ratings and reviews only",
  },
  poi: {
    verdict: "Map place entry for the requested category.",
    supports: "place data (address, hours, rating)",
  },
  reference: {
    verdict: "Reference article — contains no product, price or stock data.",
    supports: "definitions only",
  },
  community: {
    verdict: "Community discussion — opinions, not authoritative listings.",
    supports: "anecdotes only",
  },
  article: {
    verdict: "News or editorial article — it may quote a price, it cannot confirm stock.",
    supports: "a quoted figure",
  },
  other: {
    verdict: "A general web page — nothing here was checkable for this question.",
    supports: "no checkable data",
  },
};

/** Fact types that make a source "carry weight" for the current ask. */
const CLAIM_FACT_TYPES: Record<ClaimType, string[]> = {
  price: ["price"],
  availability: ["availability"],
  existence: ["product-name", "job-title", "locality"],
  "item-link": [],
  "job-open": ["posted", "job-title"],
  rating: ["rating"],
  "review-count": ["review-count"],
  "open-now": ["open-now"],
  "deliverable-to": ["deliver-to"],
  version: ["version"],
};

export interface AdjudicateOptions {
  accessoryAsk: boolean;
  /** PIN / locality the user asked about delivery to, when applicable. */
  deliveryTarget?: string;
  /** Injectable clock for tests. */
  today?: Date;
}

export interface AdjudicationResult {
  claims: ClaimVerdict[];
  sources: SourceVerdict[];
  itemLinks: VerifiedLink[];
  /** URLs that must never be presented as the item (SERP/listing pages). */
  ineligibleUrls: string[];
}

function availabilityStateOf(f: FactHit): AvailabilityState | null {
  const v = f.value.toLowerCase();
  if (/in stock|in-store|online only/.test(v)) return "in-stock";
  if (/limited/.test(v)) return "limited";
  if (/pre-?order|back-?order|not yet/.test(v)) return "preorder";
  if (/out of stock|sold out|discontinued|unavailable/.test(v)) return "unavailable";
  return null;
}

function daysAgo(iso: string, today: Date): number | null {
  const t = Date.parse(iso);
  if (Number.isFinite(t)) return Math.floor((today.getTime() - t) / 86_400_000);
  const rel = iso.match(/(\d+)\s*(day|week|month)s?\s*ago/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    return n * (unit === "week" ? 7 : unit === "month" ? 30 : 1);
  }
  const mdy = iso.match(/([A-Z][a-z]{2,8})\s+(\d{1,2}),?\s+(\d{4})/);
  if (mdy) {
    const t2 = Date.parse(`${mdy[1]} ${mdy[2]}, ${mdy[3]}`);
    if (Number.isFinite(t2)) return Math.floor((today.getTime() - t2) / 86_400_000);
  }
  return null;
}

/* ── per-source verdict rows (the Evidence-trail card) ───────────────────── */

function sourceVerdictFor(
  set: SourceFactSet,
  entity: EntityMatcher,
  scenario: Scenario,
  opts: AdjudicateOptions,
): SourceVerdict {
  const primaryClaim = scenario.claims[0];
  // What this page CAN speak to (eligibility) is judged against the claim the
  // user asked; which of its facts are relevant is judged against the first
  // asked claim it actually carries data for. Keying both on claims[0] made a
  // seller's product page read "no price or stock data could be parsed" under
  // an item-link ask, because item-link's fact type is the product name — while
  // the very same page had verified the price and stock claims. The row must
  // not contradict the verdicts printed above it.
  const factClaim =
    scenario.claims.find((c) =>
      (CLAIM_FACT_TYPES[c] ?? []).some((t) => set.facts.some((f) => f.type === t)),
    ) ?? primaryClaim;
  const usable = set.facts.filter((f) => (CLAIM_FACT_TYPES[factClaim] ?? []).includes(f.type));
  const eligible = claimEligibility(set.kind, primaryClaim);
  const accessoryRejection = set.rejections.find((r) => r.reason === "accessory-listing");
  const entityRejection = set.rejections.find((r) => r.reason === "entity-mismatch");
  const staleRejection = set.rejections.find((r) => r.reason === "stale");

  const supportValues = (limit: number) =>
    [...new Set(usable.map((f) => f.value))].slice(0, limit).join(" · ");

  let status: ClaimStatus = "unverified";
  let verdictLine = ROLE_LIMITATION[set.kind].verdict;
  let supportsLine = ROLE_LIMITATION[set.kind].supports;

  // The source-kind limitation comes first: a search-results page is limited
  // structurally, and labelling it "accessory listing" (because one of its
  // result tiles is a phone case) would hide what the user needs to know.
  if (eligible === "none") {
    status = "unverified";
    if (isSerpLike(set.kind)) {
      verdictLine =
        primaryClaim === "price"
          ? "Shows product listings; it does not establish the price of the exact variant."
          : ROLE_LIMITATION.serp.verdict;
      supportsLine = "product discovery only";
    }
  } else if (accessoryRejection && !opts.accessoryAsk) {
    status = "unverified";
    verdictLine = `Accessory listing (${accessoryRejection.value}), not the requested product.`;
    supportsLine = "accessory pricing only";
  } else if (usable.length > 0 && set.entityMatched) {
    const primaries = eligible === "primary";
    status = primaries ? "verified" : "unverified";
    if (primaries) {
      if (set.kind === "product" && usable.some((f) => f.type === "price")) {
        verdictLine = "Price found and matched to the requested product.";
      } else if (set.kind === "product" && usable.some((f) => f.type === "availability")) {
        verdictLine = "Stock status read directly from the seller's product page.";
      } else if (set.kind === "job-posting") {
        verdictLine = "Job posting for the requested role, read from the posting itself.";
      } else if (set.kind === "poi") {
        verdictLine = "Place data read from a map place entry for the requested area.";
      } else if (set.kind === "price-aggregator") {
        verdictLine = `Price-comparison page reporting ${supportValues(2)}.`;
      } else {
        verdictLine = `${set.roleLabel} states the ${factClaim.replace(/-/g, " ")} for the requested item.`;
      }
      supportsLine = supportValues(3);
    } else {
      verdictLine = `${ROLE_LIMITATION[set.kind].verdict} It reports ${supportValues(2)}, which is corroborating only.`;
      supportsLine = supportValues(2);
    }
  } else if (set.entityMatched && set.kind === "product") {
    verdictLine = "Product page for the requested item, but no price or stock data could be parsed from it.";
    supportsLine = "existence of the listing only";
    status = "unverified";
  } else if (entityRejection && !set.entityMatched) {
    verdictLine = "Facts on this page belong to a different product than the one asked about.";
    supportsLine = "no facts about the requested item";
    status = "unverified";
  }

  if (staleRejection && status === "verified") {
    supportsLine += ` (price listed as valid only until ${staleRejection.value})`;
  }

  return {
    sourceId: set.sourceId,
    url: set.url,
    domain: set.domain,
    title: set.title,
    kind: set.kind,
    roleLabel: set.roleLabel,
    status,
    verdictLine,
    supportsLine,
    facts: set.facts,
    rejections: set.rejections,
  };
}

/* ── claim-level adjudication ────────────────────────────────────────────── */

interface FactRef {
  sourceId: string;
  kind: SourceKind;
  fact: FactHit;
}

function collect(factSets: SourceFactSet[], type: string, claim: ClaimType): { primary: FactRef[]; secondary: FactRef[] } {
  const primary: FactRef[] = [];
  const secondary: FactRef[] = [];
  for (const set of factSets) {
    if (!set.entityMatched) continue;
    const elig = claimEligibility(set.kind, claim);
    if (elig === "none") continue;
    for (const fact of set.facts) {
      if (fact.type !== type) continue;
      (elig === "primary" ? primary : secondary).push({ sourceId: set.sourceId, kind: set.kind, fact });
    }
  }
  return { primary, secondary };
}

function uniqueValues(refs: FactRef[]): string[] {
  return [...new Set(refs.map((r) => r.fact.value))];
}
function ids(refs: FactRef[]): string[] {
  return [...new Set(refs.map((r) => r.sourceId))];
}

function adjudicatePrice(entity: EntityMatcher, factSets: SourceFactSet[]): ClaimVerdict {
  const { primary, secondary } = collect(factSets, "price", "price");
  if (primary.length > 0) {
    const byCurrency = new Map<string, number[]>();
    for (const r of primary) {
      const c = r.fact.currency ?? "?";
      const list = byCurrency.get(c) ?? [];
      if (typeof r.fact.numeric === "number") list.push(r.fact.numeric);
      byCurrency.set(c, list);
    }
    let conflict = false;
    for (const nums of byCurrency.values()) if (pricesConflict(nums)) conflict = true;
    const values = uniqueValues(primary);
    if (conflict) {
      return {
        type: "price",
        status: "conflict",
        values,
        sourceIds: ids(primary),
        line: `Seller pages give DIFFERENT prices for ${entity.phrase}: ${values.join(" vs ")}. Quote both and say they conflict; never average them or round them into a range like "~₹16-17K".`,
      };
    }
    return {
      type: "price",
      status: "verified",
      values,
      sourceIds: ids(primary),
      line: `Price of ${entity.phrase} verified from the seller's own page: ${values[0]}. Use this value and this only — do not round it or restate it from memory.`,
    };
  }
  if (secondary.length > 0) {
    const values = uniqueValues(secondary);
    return {
      type: "price",
      status: "unverified",
      values,
      sourceIds: ids(secondary),
      line: `Only secondary sources (news/comparison sites) mention ${values.join(" / ")} for ${entity.phrase}; no seller page confirms it. If you mention a figure you must attribute it and say the seller has not confirmed it.`,
      note: "unconfirmed by any seller page",
    };
  }
  return {
    type: "price",
    status: "unverified",
    values: [],
    sourceIds: [],
    line: `No source stated a price for ${entity.phrase}. Do NOT give any price, estimate, range or "around ₹X" figure — say you could not confirm the price.`,
  };
}

function adjudicateAvailability(entity: EntityMatcher, factSets: SourceFactSet[]): ClaimVerdict {
  const { primary, secondary } = collect(factSets, "availability", "availability");
  const statesOf = (refs: FactRef[]) =>
    refs
      .map((r) => ({ state: availabilityStateOf(r.fact), value: r.fact.value, sourceId: r.sourceId }))
      .filter((x) => x.state !== null) as { state: AvailabilityState; value: string; sourceId: string }[];

  const pStates = statesOf(primary);
  if (pStates.length > 0) {
    const set = new Set(pStates.map((s) => s.state));
    const values = uniqueValues(primary);
    if (set.size > 1) {
      return {
        type: "availability",
        status: "conflict",
        values,
        sourceIds: ids(primary),
        line: `Seller pages disagree on stock for ${entity.phrase}: ${values.join(" vs ")}. Say the sources disagree and list each source's state — do not pick one.`,
      };
    }
    const state = [...set][0];
    if (state === "unavailable") {
      return {
        type: "availability",
        status: "verified",
        values,
        sourceIds: ids(primary),
        line: `Verified NOT available: the seller's own page states ${values[0]}. Never say it is available, in stock, or orderable; if you suggest alternatives label them as suggestions.`,
      };
    }
    const qualifier = state === "preorder" ? "pre-order only, not immediately shippable" : state === "limited" ? "listed as limited stock" : "in stock";
    return {
      type: "availability",
      status: "verified",
      values,
      sourceIds: ids(primary),
      line: `Availability verified from the seller's page: ${qualifier} (${values[0]}). State exactly that — no stronger claim than the page allows.`,
    };
  }
  if (secondary.length > 0) {
    const values = uniqueValues(secondary);
    return {
      type: "availability",
      status: "unverified",
      values,
      sourceIds: ids(secondary),
      line: `Stock for ${entity.phrase} is NOT verified (only non-seller pages mention ${values.join(" / ")}). Do not state stock at all — say you could not confirm it.`,
      note: "stock stated only by non-authoritative sources",
    };
  }
  return {
    type: "availability",
    status: "unverified",
    values: [],
    sourceIds: [],
    line: `No source established current stock for ${entity.phrase}. Do not claim availability, "in stock", "currently unavailable" or delivery timing — say you could not confirm stock.`,
  };
}

function adjudicateExistence(entity: EntityMatcher, factSets: SourceFactSet[]): ClaimVerdict {
  const primaries = factSets.filter(
    (s) =>
      s.entityMatched &&
      (s.kind === "product" || s.kind === "job-posting" || s.kind === "poi" || s.kind === "reference"),
  );
  if (primaries.length > 0) {
    return {
      type: "existence",
      status: "verified",
      values: [entity.phrase],
      sourceIds: primaries.map((s) => s.sourceId),
      line: `${entity.phrase} exists as a real page on: ${primaries.map((s) => s.domain).join(", ")}. Only reference those pages.`,
    };
  }
  const seenOnlyInSerp = factSets.filter((s) => isSerpLike(s.kind) && s.entityMatched);
  if (seenOnlyInSerp.length > 0) {
    return {
      type: "existence",
      status: "unverified",
      values: [],
      sourceIds: seenOnlyInSerp.map((s) => s.sourceId),
      line: `${entity.phrase} was seen only inside search-results listings, never on its own page. Do not assert it is listed/available — say you found only listings and could not open the item page.`,
    };
  }
  return {
    type: "existence",
    status: "unverified",
    values: [],
    sourceIds: [],
    line: `The evidence does not establish that ${entity.phrase} exists as claimed. Say what you could not confirm instead of asserting it.`,
  };
}

function adjudicateItemLink(
  entity: EntityMatcher,
  factSets: SourceFactSet[],
  accessoryAsk: boolean,
): { verdict: ClaimVerdict; itemLinks: VerifiedLink[]; ineligibleUrls: string[] } {
  // An accessory page names the requested product ("Back Cover for Honor 200
  // 5G") and has a product-shaped URL, so kind + entity binding alone would
  // hand it over as the item. The fact ledger already rejected its facts as
  // accessory-listing; that rejection also disqualifies its URL.
  const accessoryPage = (s: SourceFactSet) =>
    !accessoryAsk && s.rejections.some((r) => r.reason === "accessory-listing");
  const eligible = factSets.filter(
    (s) => canBeTheItem(s.kind) && s.entityMatched && !accessoryPage(s),
  );
  const serpTrap = factSets.filter((s) => isSerpLike(s.kind) && s.entityMatched);
  const itemLinks: VerifiedLink[] = eligible.map((s) => ({
    url: s.url,
    sourceId: s.sourceId,
    roleLabel: s.roleLabel,
  }));
  const ineligibleUrls = factSets
    .filter((s) => !canBeTheItem(s.kind) || accessoryPage(s))
    .map((s) => s.url);

  if (itemLinks.length > 0) {
    return {
      verdict: {
        type: "item-link",
        status: "verified",
        values: itemLinks.map((l) => l.url),
        sourceIds: itemLinks.map((l) => l.sourceId),
        line:
          `The only pages the evidence supports as THE item itself are: ${itemLinks.map((l) => `[${l.sourceId}] ${l.url}`).join("; ")}. ` +
          "You may link only those. Never compose, shorten, guess or 'improve' a URL, and never present a search-results or category page as the product link.",
      },
      itemLinks,
      ineligibleUrls,
    };
  }
  return {
    verdict: {
      type: "item-link",
      status: "unverified",
      values: [],
      sourceIds: [],
      line:
        `NO page in the evidence qualifies as the ${entity.phrase} item page` +
        (serpTrap.length > 0
          ? ` — the ${serpTrap.map((s) => s.domain).join(", ")} URLs retrieved are search-results/listing pages (they show other products, not the item). Do not give any "direct link": say the item page could not be verified and offer to re-check.`
          : " — do not give any direct link; say the item page could not be verified."),
      note: serpTrap.length > 0 ? "only SERP/listing pages available" : undefined,
    },
    itemLinks: [],
    ineligibleUrls,
  };
}

function adjudicateJobOpen(entity: EntityMatcher, factSets: SourceFactSet[], today: Date): ClaimVerdict {
  const postings = factSets.filter((s) => s.kind === "job-posting" && s.entityMatched);
  if (postings.length === 0) {
    return {
      type: "job-open",
      status: "unverified",
      values: [],
      sourceIds: [],
      line: `No job posting page for ${entity.phrase} was opened. Do not say a job is open, hiring, or apply-able; say the posting could not be verified.`,
    };
  }
  const posted = postings
    .flatMap((s) => s.facts.filter((f) => f.type === "posted"))
    .map((f) => ({ value: f.value, days: daysAgo(f.value, today), sourceId: "" }));
  const fresh = posted.filter((p) => p.days !== null && p.days >= 0 && p.days <= 45);
  if (fresh.length > 0) {
    return {
      type: "job-open",
      status: "verified",
      values: fresh.map((p) => p.value),
      sourceIds: [...new Set(postings.map((s) => s.sourceId))],
      line: `Posting verified as recent (${fresh.map((p) => p.value).join(", ")}). You may say it is currently listed; do not claim the vacancy is still open beyond what the page states.`,
    };
  }
  const stale = posted.filter((p) => p.days !== null && p.days > 45);
  if (stale.length > 0) {
    return {
      type: "job-open",
      status: "conflict",
      values: stale.map((p) => p.value),
      sourceIds: [...new Set(postings.map((s) => s.sourceId))],
      line: `The posting(s) date from ${stale.map((p) => p.value).join(", ")} — possibly closed. Say the listing may no longer accept applications and link it so the user can check, rather than presenting it as open.`,
    };
  }
  return {
    type: "job-open",
    status: "unverified",
    values: [],
    sourceIds: [...new Set(postings.map((s) => s.sourceId))],
    line: "A posting page was opened but its posting date could not be read. Say you could not confirm whether it is still open.",
  };
}

function adjudicateRating(entity: EntityMatcher, factSets: SourceFactSet[], wantCount: boolean): ClaimVerdict {
  const { primary } = collect(factSets, wantCount ? "review-count" : "rating", wantCount ? "review-count" : "rating");
  const values = uniqueValues(primary);
  if (primary.length === 0) {
    return {
      type: wantCount ? "review-count" : "rating",
      status: "unverified",
      values: [],
      sourceIds: [],
      line: `No verified ${wantCount ? "review count" : "rating"} for ${entity.phrase}. Do not invent one; say it was not confirmed${wantCount ? "" : " (a raw star value from a single unverified page is not a rating you may state)"}."`,
    };
  }
  if (!wantCount) {
    const nums = primary.map((r) => r.fact.numeric).filter((n): n is number => typeof n === "number");
    if (nums.length >= 2 && Math.max(...nums) - Math.min(...nums) > 0.4) {
      return {
        type: "rating",
        status: "conflict",
        values,
        sourceIds: ids(primary),
        line: `Sources disagree on the rating: ${values.join(" vs ")}. Report both with their sources instead of picking one.`,
      };
    }
  }
  return {
    type: wantCount ? "review-count" : "rating",
    status: "verified",
    values,
    sourceIds: ids(primary),
    line: `${wantCount ? "Review count" : "Rating"} verified: ${values[0]} (from ${ids(primary).join(", ")}). State it exactly as sourced.`,
  };
}

function adjudicateDeliverable(entity: EntityMatcher, factSets: SourceFactSet[], target?: string): ClaimVerdict {
  const { primary } = collect(factSets, "deliver-to", "deliverable-to");
  const values = uniqueValues(primary);
  if (primary.length === 0) {
    return {
      type: "deliverable-to",
      status: "unverified",
      values: [],
      sourceIds: [],
      line: `No source states delivery${target ? ` to ${target}` : ""} for ${entity.phrase}. Do not promise delivery, ETA or COD — say delivery to that area could not be confirmed from the page.`,
    };
  }
  const matchedTarget = target
    ? values.find((v) => v.toLowerCase().includes(target.toLowerCase()) || target.toLowerCase().includes(v.toLowerCase()))
    : values[0];
  if (target && !matchedTarget) {
    return {
      type: "deliverable-to",
      status: "unverified",
      values,
      sourceIds: ids(primary),
      line: `The page mentions delivery to ${values.join(", ")} — which does NOT confirm delivery to ${target}. Say delivery to ${target} was not confirmed.`,
    };
  }
  return {
    type: "deliverable-to",
    status: "verified",
    values: [matchedTarget ?? values[0]],
    sourceIds: ids(primary),
    line: `Delivery information verified as stated on the seller page: ${matchedTarget ?? values[0]}. Quote that wording only — do not extend it into an ETA guarantee.`,
  };
}

function adjudicateVersion(entity: EntityMatcher, factSets: SourceFactSet[]): ClaimVerdict {
  const { primary, secondary } = collect(factSets, "version", "version");
  const values = uniqueValues(primary);
  if (primary.length > 0) {
    return {
      type: "version",
      status: values.length > 1 ? "conflict" : "verified",
      values,
      sourceIds: ids(primary),
      line: values.length > 1
        ? `Docs disagree on the version: ${values.join(" vs ")}. Show both with sources.`
        : `Version verified: ${values[0]}.`,
    };
  }
  const sec = uniqueValues(secondary);
  return {
    type: "version",
    status: "unverified",
    values: sec,
    sourceIds: ids(secondary),
    line: `Version for ${entity.phrase} not confirmed by official docs${sec.length > 0 ? ` (informal sources mention ${sec.join(", ")})` : ""}. Say it is unconfirmed rather than asserting a version.`,
  };
}

/* ── entry point ─────────────────────────────────────────────────────────── */

export function adjudicateSources(
  entity: EntityMatcher,
  factSets: SourceFactSet[],
  scenario: Scenario,
  opts: AdjudicateOptions,
): AdjudicationResult {
  const today = opts.today ?? new Date();
  const sources = factSets.map((s) => sourceVerdictFor(s, entity, scenario, opts));

  const claims: ClaimVerdict[] = [];
  let itemLinks: VerifiedLink[] = [];
  let ineligibleUrls: string[] = [];

  for (const claim of scenario.claims) {
    let verdict: ClaimVerdict;
    switch (claim) {
      case "price":
        verdict = adjudicatePrice(entity, factSets);
        break;
      case "availability":
        verdict = adjudicateAvailability(entity, factSets);
        break;
      case "existence":
        verdict = adjudicateExistence(entity, factSets);
        break;
      case "item-link": {
        const r = adjudicateItemLink(entity, factSets, opts.accessoryAsk);
        verdict = r.verdict;
        itemLinks = r.itemLinks;
        ineligibleUrls = r.ineligibleUrls;
        break;
      }
      case "job-open":
        verdict = adjudicateJobOpen(entity, factSets, today);
        break;
      case "rating":
        verdict = adjudicateRating(entity, factSets, false);
        break;
      case "review-count":
        verdict = adjudicateRating(entity, factSets, true);
        break;
      case "deliverable-to":
        verdict = adjudicateDeliverable(entity, factSets, opts.deliveryTarget);
        break;
      case "version":
        verdict = adjudicateVersion(entity, factSets);
        break;
      default:
        verdict = {
          type: claim,
          status: "not-applicable",
          values: [],
          sourceIds: [],
          line: `Claim type "${claim}" is verified by locality data when Location is on.`,
        };
    }
    // A single unverified claim must not overwrite a verified one downstream:
    // keep the scenario order, the model sees both.
    claims.push(verdict);
  }

  return { claims, sources, itemLinks, ineligibleUrls };
}

/** Claims whose status blocks an assertion of that kind. */
export function blockedClaims(claims: ClaimVerdict[]): ClaimVerdict[] {
  return claims.filter((c) => c.status === "unverified");
}

/** True when the ledger already settles the ask (no verification re-check needed). */
export function claimsSettled(claims: ClaimVerdict[]): boolean {
  const real = claims.filter((c) => c.status !== "not-applicable");
  if (real.length === 0) return true;
  return real.some((c) => c.status === "verified" || c.status === "conflict");
}
