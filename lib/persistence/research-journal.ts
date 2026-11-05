import fs from "node:fs";
import path from "node:path";
import type { EvidenceBundle } from "@/lib/web-search/pipeline";

/**
 * WS05 (audit 2026-11-05, repair item 5) — the SERVER-OWNED research
 * journal, one document per conversation.
 *
 * Before this module, research evidence lived only inside the live turn:
 * the citation map and evidence block were rebuilt per turn, so a
 * follow-up (or any turn after reload/compaction) had no server-side
 * record that a document was EVER fetched — dangling citation aliases and
 * model-answered-from-memory were the symptoms. The journal fixes the
 * authority direction: the server records what IT fetched (url, title,
 * domain, published date, fetch date, passage excerpt) under the
 * conversation id, and follow-ups rehydrate from THAT — never from
 * client-provided text or UI metadata, which is not proof of a fetch.
 *
 * Trust law: this file (`<safe-id>.research.json`) is written ONLY by
 * server code (the chat route and the internal research bridge). The
 * client-owned conversation document POST (`<safe-id>.json`, merge.ts)
 * can never reach this filename. Rehydration reads journal state the
 * client cannot forge. The conversation id is storage identity only — it
 * is never treated as evidence of anything.
 *
 * Persistence mirrors lib/persistence/disk.ts exactly: same DATA_DIR
 * computed at module load, same id sanitizer.
 */

const DATA_DIR = process.env.WEBUI_DATA_DIR ?? path.join(process.env.HOME!, ".local-intelligence", "conversations");

/** A fetched document as the server attests it. */
export interface JournalSource {
  url: string;
  title: string;
  domain: string;
  publishedAt?: string;
  /** ISO instant the server fetched it — provenance, never model prose. */
  fetchedAt: string;
  /** Short passage excerpt carried forward for later turns (bounded). */
  excerpt: string;
  /**
   * MHR-E (brief 2026-11-05): the actually-served fetched passages with
   * their §refs, beyond the 500-char preview. A search snippet is a
   * pointer; these are EVIDENCE — a follow-up turn rehydrates real
   * fetched text it can cite by ref, not just the headline. Bounded
   * (see MAX_JOURNAL_PASSAGES): memory, not an archive.
   */
  passages?: { ref: string; text: string }[];
}

/** One completed research turn, from the server's point of view. */
export interface JournalTurn {
  at: number;
  currentDate?: string;
  queries: string[];
  freshness: string;
  sources: JournalSource[];
}

// Bounded retention: the journal is a follow-up memory, not an archive.
const MAX_TURNS = 24;
const MAX_SOURCES = 12;
const MAX_EXCERPT = 500;
// MHR-E: passages ride alongside the excerpt so follow-ups rehydrate
// fetched EVIDENCE, not a 500-char headline — but still bounded: three
// passages of 700 chars per document is a memory, not a document store.
const MAX_JOURNAL_PASSAGES = 3;
const JOURNAL_PASSAGE_CHARS = 700;

/** Same sanitizer as disk.ts — ids are already safe; be defensive. */
function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Journal path for a conversation. SEPARATE from the conversation
 * document file (`${safe}.json`) by the `.research.json` suffix — the
 * conversation-save POST can never write or clobber the journal.
 */
export function researchJournalFile(conversationId: string): string {
  return path.join(DATA_DIR, `${safeId(conversationId)}.research.json`);
}

function clampTurn(turn: JournalTurn): JournalTurn {
  return {
    at: Number.isFinite(turn.at) ? turn.at : Date.now(),
    currentDate: turn.currentDate,
    queries: turn.queries.filter((q) => typeof q === "string" && q.trim()).slice(0, 12),
    freshness: turn.freshness,
    sources: turn.sources
      .filter((s) => s && typeof s.url === "string" && s.url)
      .slice(0, MAX_SOURCES)
      .map((s) => ({
        url: s.url,
        title: s.title ?? "",
        domain: s.domain ?? "",
        publishedAt: s.publishedAt,
        fetchedAt: s.fetchedAt ?? new Date().toISOString(),
        excerpt: (s.excerpt ?? "").slice(0, MAX_EXCERPT),
        ...(Array.isArray(s.passages)
          ? {
              passages: s.passages
                .filter((p) => p && typeof p.ref === "string" && typeof p.text === "string")
                .slice(0, MAX_JOURNAL_PASSAGES)
                .map((p) => ({ ref: p.ref, text: p.text.slice(0, JOURNAL_PASSAGE_CHARS) })),
            }
          : {}),
      })),
  };
}

/** Append one completed research turn. Inert on an empty conversation id. */
export function recordResearchTurn(conversationId: string, turn: JournalTurn): void {
  if (!conversationId.trim()) return;
  const turns = readResearchJournal(conversationId);
  turns.push(clampTurn(turn));
  const fp = researchJournalFile(conversationId);
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(turns.slice(-MAX_TURNS)), "utf-8");
  } catch {
    // Journaling is best-effort: a disk failure must never break or fake
    // a research turn (Rule 2.4 — web failures degrade, never error out).
  }
}

/** Missing, unreadable or corrupt journals read as empty — never throws. */
export function readResearchJournal(conversationId: string): JournalTurn[] {
  if (!conversationId.trim()) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(researchJournalFile(conversationId), "utf-8"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t: any) => t && typeof t === "object" && Array.isArray(t.sources))
      .map((t: any) => clampTurn(t as JournalTurn));
  } catch {
    return [];
  }
}

/** Conversation deletion parity: removing the conversation removes the journal. */
export function deleteResearchJournal(conversationId: string): void {
  if (!conversationId.trim()) return;
  try {
    fs.unlinkSync(researchJournalFile(conversationId));
  } catch {
    /* nothing to remove */
  }
}

/** Map a completed research bundle onto a journal turn (server-side only). */
export function journalTurnFromBundle(bundle: EvidenceBundle, currentDate?: string): JournalTurn {
  return {
    at: Date.now(),
    currentDate,
    queries: bundle.searchGate.decision.queries.map((q) => q.query),
    freshness: bundle.searchGate.decision.freshness,
    sources: bundle.packets.map((p) => ({
      url: p.url,
      title: p.title ?? "",
      domain: p.domain ?? "",
      publishedAt: p.publishedAt,
      fetchedAt: new Date().toISOString(),
      excerpt: p.passages[0]?.passageText ?? "",
    })),
  };
}

function tokens(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/\p{L}+|\p{N}+/gu) ?? []).filter((w) => w.length > 2),
  );
}

/**
 * Pick the journal turns a follow-up should see: turns whose queries,
 * titles or domains share a content token with the prompt (≥1 overlap),
 * most-recent first, bounded (default 2 — the audit law is "relevant",
 * not "everything we ever fetched").
 */
export function selectPriorEvidence(
  turns: JournalTurn[],
  prompt: string,
  opts?: { maxTurns?: number },
): JournalTurn[] {
  const pt = tokens(prompt);
  if (pt.size === 0) return [];
  const scored = turns
    .map((t) => {
      const et = tokens(
        [t.queries.join(" "), ...t.sources.map((s) => `${s.title} ${s.domain} ${s.url}`)].join(" "),
      );
      let score = 0;
      for (const w of pt) if (et.has(w)) score++;
      return { t, score };
    })
    .filter((x) => x.score >= 1)
    .sort((a, b) => b.t.at - a.t.at);
  return scored.slice(0, opts?.maxTurns ?? 2).map((x) => x.t);
}

/**
 * Re-alias prior sources CONTINUING AFTER the current turn's max S-id
 * ("S"+max passed in; "" ⇒ start at S1): a deterministic, collision-free
 * numbering so the rehydrated aliases are real citation targets the UI
 * pills and the citation map both understand. Dedupes one document across
 * turns to a single alias (first occurrence — callers pass newest-first).
 */
export function buildPriorEvidenceBlock(
  turns: JournalTurn[],
  currentMaxSourceId: string,
): { block: string; citations: Record<string, { sourceId: string; url: string; title: string; domain: string; publishedAt?: string }> } {
  const citations: Record<string, { sourceId: string; url: string; title: string; domain: string; publishedAt?: string }> = {};
  if (turns.length === 0) return { block: "", citations };
  const base = Number(/\d+$/.exec(currentMaxSourceId ?? "")?.[0] ?? 0) || 0;
  const seen = new Map<string, string>(); // url -> alias
  // MHR-E: one document may be read across turns (block 1 early, a
  // continuation's block 7 later). Group by URL FIRST so every journaled
  // §passage of that document lands under the ONE alias the url law
  // mints for it — deduped by §ref, capped, first-seen wins the label
  // and provenance, and the url still appears exactly once.
  const grouped = new Map<string, { source: JournalSource; freshness: string; refs: Map<string, string> }>();
  for (const t of turns) {
    for (const s of t.sources) {
      let g = grouped.get(s.url);
      if (!g) {
        g = { source: s, freshness: t.freshness, refs: new Map() };
        grouped.set(s.url, g);
      }
      for (const p of s.passages ?? []) {
        if (p && typeof p.ref === "string" && typeof p.text === "string" && !g.refs.has(p.ref)) {
          g.refs.set(p.ref, p.text);
        }
      }
    }
  }
  const lines: string[] = [];
  for (const [url, g] of grouped) {
    const s = g.source;
    const alias = `S${base + seen.size + 1}`;
    seen.set(url, alias);
    citations[alias] = { sourceId: alias, url: s.url, title: s.title, domain: s.domain, publishedAt: s.publishedAt };
    const provenance = [
      `fetched ${(s.fetchedAt ?? "").slice(0, 10) || "unknown"}`,
      s.publishedAt ? `published ${s.publishedAt}` : null,
      `freshness: ${g.freshness || "unknown"}`,
    ]
      .filter(Boolean)
      .join("; ");
    // §-addressed passages when the journal has them; legacy preview only
    // for pre-MHR-E turns, so old journals keep their exact bytes.
    const passageLines = [...g.refs.entries()]
      .slice(0, MAX_JOURNAL_PASSAGES)
      .map(([ref, text]) => `    ${ref}: "${text}"`);
    lines.push(
      `[${alias}] ${s.title} — ${s.domain} — ${url}\n    ${provenance}\n` +
        (passageLines.length > 0 ? passageLines.join("\n") : `    passage: "${s.excerpt}"`),
    );
  }
  const block = [
    "<prior_research_evidence>",
    "Documents this SAME server fetched in EARLIER turns of this conversation. The fetch dates below are server-attested provenance, not model claims; answer follow-ups from these passages when they cover the question, cite them by their [S#] aliases, and qualify anything they do not cover.",
    ...lines,
    "</prior_research_evidence>",
  ].join("\n");
  return { block, citations };
}
