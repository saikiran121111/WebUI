/**
 * The verification STAGE: pure functions the pipeline calls between rerank
 * and evidenceBlock.
 *
 *   deriveEntity → buildFactSets → adjudicateSources → VerificationLedger
 *
 * `verificationBlock()` renders that ledger into the prompt contract the main
 * model must obey; `ledgerToWire()` is the browser-facing form (X-Web-Ledger)
 * that renders the Evidence-trail rows and the inline claim pills.
 */
import type { EvidencePacket, SearchDecision } from "../web-search/types";
import { deriveEntity, type EntityMatcher } from "./entity";
import { buildFactSets, type SourceFactSet } from "./fact-ledger";
import { adjudicateSources } from "./claim-rules";
import { detectScenario, type Scenario } from "./scenarios";
import type { ClaimStatus, LedgerWire, VerificationLedger } from "./types";

export interface LedgerEntity extends EntityMatcher {}

export interface BuildLedgerInput {
  userPrompt: string;
  /** Keyword queries the gate planned (entity-first) — used to derive the entity. */
  queries: string[];
  decision?: SearchDecision;
  packets: EvidencePacket[];
  /** Injectable clock (tests). */
  today?: Date;
}

/** The place/PIN the user asked about delivery for, if any. */
export function extractDeliveryTarget(prompt: string): string | undefined {
  const pin = prompt.match(/\b\d{6}\b/);
  if (pin) return pin[0];
  const m = prompt.match(
    /\b(?:deliver(?:ed)?|ship(?:ped)?|deliverable|available for delivery)\s+(?:to|in|at)\s+([a-z0-9 ,._-]{3,40}?)(?:\b[,.]|\?|$|\s+(?:in|and|with|for)\b)/i,
  );
  return m ? m[1].trim() : undefined;
}

export interface BuiltLedger {
  ledger: VerificationLedger;
  entity: EntityMatcher;
  scenario: Scenario;
  factSets: SourceFactSet[];
  ineligibleUrls: string[];
  deliveryTarget?: string;
}

/** Deterministic adjudication of the retrieved packets. No model, no network. */
export function buildLedger(input: BuildLedgerInput): BuiltLedger {
  const entity = deriveEntity(input.userPrompt, input.queries);
  const scenario = detectScenario(input.userPrompt, input.decision);
  const deliveryTarget = extractDeliveryTarget(input.userPrompt);
  const factSets = buildFactSets(input.packets, entity, {
    accessoryAsk: entity.accessoryAsk,
    today: input.today,
  });
  const adjudicated = adjudicateSources(entity, factSets, scenario, {
    accessoryAsk: entity.accessoryAsk,
    deliveryTarget,
    today: input.today,
  });

  const ledger: VerificationLedger = {
    scenario: scenario.id,
    taskLabel: scenario.taskLabel,
    icon: scenario.icon,
    entity: entity.phrase,
    claims: adjudicated.claims,
    sources: adjudicated.sources,
    itemLinks: adjudicated.itemLinks,
  };
  return {
    ledger,
    entity,
    scenario,
    factSets,
    ineligibleUrls: adjudicated.ineligibleUrls,
    deliveryTarget,
  };
}

const CONTRACT = [
  "VERIFICATION CONTRACT (mandatory):",
  "1. State only values whose status is VERIFIED below. Quote them exactly — never round, average, or restate them from memory.",
  "2. Where a claim is CONFLICT, present BOTH values and say the sources disagree. Never invent a range like \"~₹16-17K\".",
  "3. Where a claim is UNVERIFIED, say plainly that you could not confirm it. For an unverified claim give NO value, NO stock statement and NO link — an apology for guessing is better than a confident wrong fact.",
  "4. Every URL you emit must be copied verbatim from a numbered [S#] source above. Never compose, shorten, extend or \"improve\" a URL, and never present a search-results or category page as the product/job/place itself — in particular NEVER construct a search URL (e.g. `amazon.in/s?k=…` or `…?q=…`); if the only [S#] URL for the item is a search or aggregator page, label it honestly as a search/aggregator page, not as the item's own listing.",
  "5. A source whose `supports:` line names a limitation cannot back a stronger claim than that limitation allows.",
  // Inline attribution is what lets the UI stamp each fact with the verdict its
  // source earned. Without it the answer carries bare URLs and the user cannot
  // see WHICH source established WHICH figure.
  "6. Mark every fact you state with its source inline, e.g. `₹18,992 [S2]` or `currently unavailable [S2]`. A figure with no marker next to it is treated by the interface as unattributed.",
  "7. Fact-to-source alignment: never attribute a spec (e.g. an \"OIS camera\" or \"IP68\") or a price to an item unless the cited [S#] passage states that exact spec/price for that exact model and variant. A figure found on an accessory, case, or different-model page is never a fact about the item.",
  "8. Never present as available or as a recommendation something the verdicts mark otherwise: out-of-stock/sold-out/discontinued products, closed or withdrawn job postings, past events, closed venues, videos not confirmed watchable, or books not confirmed readable/purchasable. State the live status with its [S#] marker instead; recommend only alternatives a VERIFIED source covers, and only within the budget the user stated.",
].join("\n");

/**
 * The `<verification>` block appended after the evidence block. Length is
 * bounded (≤8 source rows, ≤200 chars per line) so the contract never
 * out-grows the evidence it polices.
 */
export function verificationBlock(ledger: VerificationLedger, ineligibleUrls: string[] = []): string {
  const cap = (s: string, n = 220) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const lines: string[] = [
    "",
    "<verification>",
    `Deterministic audit of the evidence for this request. Entity: "${ledger.entity || "unresolved"}". Intent: ${ledger.taskLabel}.`,
    "",
    "CLAIM VERDICTS:",
  ];
  for (const c of ledger.claims) {
    lines.push(`- ${c.type} [${c.status.toUpperCase()}] ${cap(c.line)}`);
  }
  lines.push("", "SOURCE VERDICTS:");
  for (const s of ledger.sources.slice(0, 8)) {
    lines.push(
      `- [${s.sourceId}] ${s.roleLabel} (${s.domain}) [${s.status.toUpperCase()}] ${cap(s.verdictLine, 160)} supports: ${cap(s.supportsLine, 120)}`,
    );
  }

  const blockedLinks = ledger.claims.find((c) => c.type === "item-link" && c.status === "unverified");
  lines.push("", "URL RULES FOR THIS TURN:");
  if (ledger.itemLinks.length > 0) {
    lines.push(
      `Allowed as "the item page": ${ledger.itemLinks.map((l) => `${l.url} [${l.sourceId}]`).join(" | ")}`,
    );
  } else if (blockedLinks) {
    lines.push("No verified item page exists. Emit NO direct product/job/place link this turn.");
  }
  const ineligible = ineligibleUrls.slice(0, 6);
  if (ineligible.length > 0) {
    lines.push(`Never present these as the item (they are listings/search pages): ${ineligible.join(" | ")}`);
  }

  lines.push("", CONTRACT, "</verification>");
  return lines.join("\n");
}

/**
 * Browser-facing form (X-Web-Ledger). Quotes stay server-side. Bounded on
 * purpose: this rides in an HTTP response header next to X-Web-Citations, so
 * rows are capped and every line length-capped.
 */
export function ledgerToWire(ledger: VerificationLedger): LedgerWire {
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const MAX_WIRE_SOURCES = 12;
  return {
    scenario: ledger.scenario,
    taskLabel: ledger.taskLabel,
    icon: ledger.icon,
    entity: clip(ledger.entity, 80),
    claims: ledger.claims.map((c) => ({
      type: c.type,
      status: c.status,
      values: c.values.slice(0, 4),
      sourceIds: c.sourceIds.slice(0, 6),
    })),
    // Verified rows first: if the cap bites, the verdicts the user needs to
    // see survive.
    sources: [...ledger.sources]
      .sort((a, b) => rankForWire(b.status) - rankForWire(a.status))
      .slice(0, MAX_WIRE_SOURCES)
      .map((s) => ({
        sourceId: s.sourceId,
        kind: s.kind,
        roleLabel: s.roleLabel,
        status: s.status,
        verdictLine: clip(s.verdictLine, 160),
        supportsLine: clip(s.supportsLine, 100),
      })),
    itemLinks: ledger.itemLinks.slice(0, 4),
  };
}

function rankForWire(status: ClaimStatus): number {
  if (status === "verified") return 3;
  if (status === "conflict") return 2;
  if (status === "unverified") return 1;
  return 0;
}
