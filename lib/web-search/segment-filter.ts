/**
 * §11.12 — fetch-side query-focused dynamic segment filtering (LOCAL-ONLY).
 *
 * Parity doc §11.12 ("the single biggest new item"): fetched pages must not
 * flood the rerank pool with off-query prose and boilerplate. The reranker
 * already scores chunks against the query AFTER fetch; this module is the
 * fetch-side half of the law — applied by the pipeline at the two SERP
 * extraction hops (main waves + gap hop), BEFORE packets join the rerank
 * pool. Allowed signals only: existing tokenize(), query-term coverage,
 * heading awareness, junk patterns. No cloud model, ever.
 *
 * Conservative by construction (one failed source must never gut an
 * answer):
 *   - no query terms          ⇒ inert (fixture/scripted seams unaffected),
 *   - [Structured Page Facts] ⇒ inert (P5 metadata binding + §11.12
 *                               "preserve structure/metadata" law),
 *   - ≤2 blocks               ⇒ inert,
 *   - page with NO covered non-atomic block ⇒ inert (never empties a page),
 *   - atomic blocks (fenced code, pipe tables), query-covered blocks and
 *     heading blocks are always kept;
 *   - the only drops: junk-penalty ≥ 0.8 boilerplate (any size), and
 *     zero-coverage prose ≥ 200 chars on an otherwise-covered page;
 *   - nothing droppable       ⇒ the ORIGINAL bytes are returned verbatim
 *     (no CRLF/blank-line rewrite when nothing changes).
 *
 * Rust twin: `filter_passage_segments` / `apply_segment_filter` in
 * `rust-backend/crates/ruke-websearch/src/reranker.rs` — vector-for-vector
 * (pinned in `__tests__/web-search/retrieval-quality.test.ts` and the Rust
 * inline suite; change one side, change both in the same commit).
 */
import type { EvidencePacket } from "./types";
import { junkPenalty, tokenize } from "./reranker";

interface Block {
  text: string;
  /** fenced code / pipe table — always kept ("preserve structure") */
  atomic: boolean;
}

const TABLE_ROW_RE = /^\s*\|/;
const HEADING_RE = /^#{1,6}\s/;

/**
 * Line scan ⇔ Rust `scan_blocks` — identical rules, deliberately explicit
 * (no regex-engine cleverness diverging between V8 and the regex crate):
 * blank line closes a block; a heading line opens a fresh block; fenced
 * regions (``` open/close, incl. same-line inline fences) and runs of
 * pipe-table rows become one atomic block each.
 */
function scanBlocks(cleaned: string): Block[] {
  const blocks: Block[] = [];
  let cur: string[] = [];
  let curAtomic = false;
  let inFence = false;

  const flush = () => {
    if (cur.length === 0) return;
    const text = cur.join("\n").trim();
    if (text) blocks.push({ text, atomic: curAtomic });
    cur = [];
    curAtomic = false;
  };

  for (const line of cleaned.split("\n")) {
    const t = line.trim();

    if (inFence) {
      cur.push(line);
      if (t.startsWith("```")) {
        inFence = false;
        flush();
      }
      continue;
    }
    if (t.startsWith("```")) {
      // same-line open+close (```x```): its own atomic block, stays outside
      const inlineClose = t.length > 3 && t.endsWith("```");
      if (inlineClose) {
        flush();
        blocks.push({ text: t, atomic: true });
      } else {
        flush();
        cur = [line];
        curAtomic = true;
        inFence = true;
      }
      continue;
    }
    if (t === "") {
      flush();
      continue;
    }
    if (TABLE_ROW_RE.test(line)) {
      if (cur.length > 0 && !curAtomic) flush();
      cur.push(line);
      curAtomic = true;
      continue;
    }
    if (HEADING_RE.test(t)) {
      flush();
      cur = [line];
      curAtomic = false;
      continue;
    }
    if (cur.length > 0 && curAtomic) flush(); // table ran into prose
    cur.push(line);
  }
  flush();
  return blocks;
}

function covered(text: string, qTerms: Set<string>): boolean {
  for (const term of tokenize(text)) {
    if (qTerms.has(term)) return true;
  }
  return false;
}

/**
 * Drop fetch-side segments that cannot serve the query. Returns the
 * ORIGINAL `markdown` bytes whenever the filter is inert or drops nothing;
 * otherwise the kept blocks joined with "\n\n" (CRLF normalized, exactly
 * when a drop happened).
 */
export function filterPassageSegments(markdown: string, queryText: string): string {
  const qTerms = new Set(tokenize(queryText));
  if (qTerms.size === 0) return markdown;
  // Structured facts ride the same passage bytes (extractor joins them);
  // P5 needs them and §11.12 forbids stripping structure/metadata.
  if (markdown.includes("[Structured Page Facts]")) return markdown;

  const cleaned = markdown.replace(/\r\n/g, "\n");
  const blocks = scanBlocks(cleaned);
  if (blocks.length <= 2) return markdown;

  const cov = blocks.map((b) => covered(b.text, qTerms));
  const coveredAny = cov.some((c, i) => c && !blocks[i].atomic);
  if (!coveredAny) return markdown;

  const kept = blocks.filter((b, i) => {
    if (b.atomic || cov[i]) return true;
    if (HEADING_RE.test(b.text)) return true;
    if (junkPenalty(b.text) >= 0.8) return false;
    if (b.text.length >= 200) return false;
    return true;
  });
  if (kept.length === 0 || kept.length === blocks.length) return markdown;
  return kept.map((b) => b.text).join("\n\n");
}

/**
 * Apply the filter to every passage of a freshly extracted batch — the
 * pipeline hop that keeps Rust and TS byte-parity at the rerank input.
 * Prompt-URL/transcript and SERP-baseline packets never go through here.
 */
export function applySegmentFilter(packets: EvidencePacket[], queryText: string): void {
  const q = queryText.trim();
  if (packets.length === 0 || q === "") return;
  for (const packet of packets) {
    for (const passage of packet.passages ?? []) {
      passage.passageText = filterPassageSegments(passage.passageText, q);
    }
  }
}
