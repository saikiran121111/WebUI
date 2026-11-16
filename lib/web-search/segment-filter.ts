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
 * SOLE OWNER (TS-ownership rollback 2026-11-03): the Rust twin
 * `filter_passage_segments` / `apply_segment_filter` (reranker.rs,
 * removed) shared these vectors; they stay pinned in
 * `__tests__/web-search/retrieval-quality.test.ts`.
 */
import type { EvidencePacket } from "./types";
import { mapSpansThroughKept } from "./range-math";
import { junkPenalty, tokenize } from "./reranker";

interface Block {
  text: string;
  /** fenced code / pipe table — always kept ("preserve structure") */
  atomic: boolean;
  /** F06 (2026-11-16 brief): exact [start, end) span of `text` inside
   *  the scanned string. Byte-true ranges are what make a dropped block
   *  addressable (and therefore recoverable) instead of merely deleted. */
  from: number;
  to: number;
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
  let cur: Array<{ text: string; from: number; to: number }> = [];
  let curAtomic = false;
  let inFence = false;
  let pos = 0;

  const flush = () => {
    if (cur.length === 0) return;
    // A flushed run is always CONTIGUOUS in `cleaned` (every line that is not
    // pushed closes the run), so the joined text spans exactly
    // [cur[0].from, cur[last].to); only the outer trim moves the ends.
    const first = cur[0];
    const last = cur[cur.length - 1];
    const text = cur.map((l) => l.text).join("\n").trim();
    if (text) {
      const lead = first.text.length - first.text.trimStart().length;
      const trail = last.text.length - last.text.trimEnd().length;
      blocks.push({ text, atomic: curAtomic, from: first.from + lead, to: last.to - trail });
    }
    cur = [];
    curAtomic = false;
  };

  for (const line of cleaned.split("\n")) {
    const from = pos;
    const to = pos + line.length;
    pos = to + 1;
    const t = line.trim();

    if (inFence) {
      cur.push({ text: line, from, to });
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
        blocks.push({
          text: t,
          atomic: true,
          from: from + (line.length - line.trimStart().length),
          to: to - (line.length - line.trimEnd().length),
        });
      } else {
        flush();
        cur = [{ text: line, from, to }];
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
      cur.push({ text: line, from, to });
      curAtomic = true;
      continue;
    }
    if (HEADING_RE.test(t)) {
      flush();
      cur = [{ text: line, from, to }];
      curAtomic = false;
      continue;
    }
    if (cur.length > 0 && curAtomic) flush(); // table ran into prose
    cur.push({ text: line, from, to });
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
  return filterPassageSegmentsReport(markdown, queryText).text;
}

/**
 * F06 (2026-11-16 brief): the SAME filter decision, reported with its
 * addresses. `kept` are the [start, end) spans of the surviving blocks in
 * the LF-normalized input (the coordinate space of a filtered view is the
 * canonical LF space, because a filtered view is rebuilt from `cleaned`
 * bytes); everything else is `changed: true` and simply is NOT in the
 * working view anymore - it is still in the source, at a known range.
 */
export interface SegmentFilterReport {
  text: string;
  changed: boolean;
  kept: Array<[number, number]>;
}

export function filterPassageSegmentsReport(
  markdown: string,
  queryText: string,
): SegmentFilterReport {
  const keepAll = (): SegmentFilterReport => ({
    text: markdown,
    changed: false,
    kept: [[0, markdown.length]],
  });
  const qTerms = new Set(tokenize(queryText));
  if (qTerms.size === 0) return keepAll();
  // Structured facts ride the same passage bytes (extractor joins them);
  // P5 needs them and §11.12 forbids stripping structure/metadata.
  if (markdown.includes("[Structured Page Facts]")) return keepAll();

  const cleaned = markdown.replace(/\r\n/g, "\n");
  const blocks = scanBlocks(cleaned);
  if (blocks.length <= 2) return keepAll();

  const cov = blocks.map((b) => covered(b.text, qTerms));
  const coveredAny = cov.some((c, i) => c && !blocks[i].atomic);
  if (!coveredAny) return keepAll();

  const kept = blocks.filter((b, i) => {
    if (b.atomic || cov[i]) return true;
    if (HEADING_RE.test(b.text)) return true;
    if (junkPenalty(b.text) >= 0.8) return false;
    if (b.text.length >= 200) return false;
    return true;
  });
  if (kept.length === 0 || kept.length === blocks.length) return keepAll();
  return {
    text: kept.map((b) => b.text).join("\n\n"),
    changed: true,
    kept: kept.map((b) => [b.from, b.to] as [number, number]),
  };
}

/**
 * Apply the filter to every passage of a freshly extracted batch — the
 * pipeline hop that keeps the rerank input noise-controlled.
 * Prompt-URL/transcript and SERP-baseline packets never go through here.
 *
 * §5c (2026-11-13 brief): narrowing the working view must never be
 * irreversible destruction — important facts may use synonyms or
 * explanations with no direct query-term overlap. Whenever a pass mutates
 * a passage, the complete pre-filter bytes are kept on
 * `originalPassageText` (addressable with the passage url), first-writer-
 * wins across the main-wave and gap-hop passes, and unchanged passages
 * carry no copy at all. Bounded ranking/context windows stay honest.
 */
export function applySegmentFilter(packets: EvidencePacket[], queryText: string): void {
  const q = queryText.trim();
  if (packets.length === 0 || q === "") return;
  for (const packet of packets) {
    for (const passage of packet.passages ?? []) {
      const report = filterPassageSegmentsReport(passage.passageText, q);
      if (!report.changed) continue;
      if (passage.originalPassageText === undefined) {
        passage.originalPassageText = passage.passageText;
        passage.filterKeptRanges = report.kept;
      } else {
        // A later hop filters the WORKING VIEW, so its kept ranges live in
        // view coordinates; compose them through the earlier provenance to
        // stay expressed against the one true original (first-writer-wins).
        const prior = passage.filterKeptRanges;
        passage.filterKeptRanges =
          Array.isArray(prior) && prior.length > 0
            ? mapSpansThroughKept(prior, report.kept)
            : report.kept;
      }
      passage.passageText = report.text;
    }
  }
}

/**
 * F06: translate byte spans stated in JOINED-VIEW coordinates back to
 * canonical source coordinates. `kept` are the canonical spans whose
 * slices, joined with the two-char "\n\n" separator, ARE the view text - so
 * the view position of a segment is known exactly, and a view span that
 * crosses a synthetic join yields one canonical span per segment it
 * touched (that is honest: the served text really did come from both).
 */

/** F06: view/canonical address algebra lives in range-math.ts (a leaf the
 *  test doubles of this module cannot mock away). */
export { mapSpansThroughKept };
