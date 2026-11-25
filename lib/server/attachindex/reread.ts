import { readDocumentViaCapability, type RunJob } from "../extract/document-capability";
import { embedOne } from "./embed";
import { applyRegionReread, uploadPath, type RegionRereadUpdate } from "./store";
import type { FrameEntry, LoadedIndex } from "./types";

/**
 * F152 targeted reread: the user (or model) asks for a CLOSER read of one
 * figure in an indexed document THIS turn. The law:
 *  - resolve the region(s) the question aims at — only frames whose unit the
 *    retrieved passages name (pageCues) are candidates, and only an EXPLICIT
 *    closer-read request triggers work;
 *  - run ONLY the needed inspection: the job payload carries the exact region
 *    ids, so every other region's cached evidence stands untouched;
 *  - use the result in the SAME answer (returned lines are appended to this
 *    turn's evidence block);
 *  - refresh ONLY the selected region durably (pixels + state + recovered
 *    passage), so ordinary follow-ups reuse the cached evidence.
 * Recovered text is persisted with its unit header, engine and region id —
 * merged with source location, never fused into native text.
 */

/**
 * Conservative explicit-request scan (ASCII, mirrored by the Rust port):
 * only an unambiguous closer-read phrasing triggers a reread; an ordinary
 * visual question rides the cached evidence, and a count/threshold/filename
 * never decides anything.
 */
export const REREAD_REQUEST =
  /(look|read|show|check|inspect)\s+(it\s+)?(closer|closely|up\s+close|again)|closer\s+look|re-?read|zoom(\s+in)?|enlarg|in\s+more\s+detail|more\s+detail|can\s+you\s+read|read\s+(the|this|that)\s+(label|text|figure|chart|legend)/i;

export interface RereadOutcome {
  /** Per-region lines for this turn's evidence block (empty = nothing ran). */
  lines: string[];
  /** Region ids actually re-inspected — the invocation proof. */
  regions: string[];
}

/** Words a label shares with every frame of its unit — naming one figure needs more. */
const UNIT_WORD = /^(pages?|slides?|sheets?|paragraphs?|cells?|figures?|units?|images?)$/;

/**
 * F152 region granularity: a page/slide/sheet can carry SEVERAL figures, and a
 * closer read of ONE of them must leave the neighbour's cached evidence untouched
 * (selecting by unit re-inspected every picture on the page and mixed their text).
 * Within each named unit, frames the question points at are picked by
 *  - the figure ordinal ("figure 2" → the region whose part ends "/image:1"), and
 *  - a word the frame's label carries that the question also uses ("the picture at
 *    C4" matches the label "sheet 2, cell C4");
 * and when the question names none of them, the whole unit stays in scope — the
 * established unit-level law, never narrowed to nothing.
 */
export function pickRegionFrames(frames: FrameEntry[], question: string): FrameEntry[] {
  const q = (question ?? "").toLowerCase();
  const qTokens = new Set(q.match(/[a-z0-9]+/g) ?? []);
  const ordinals = new Set<number>();
  for (const m of q.matchAll(/figure\s*#?\s*(\d+)/g)) ordinals.add(Number(m[1]));
  const byUnit = new Map<number, FrameEntry[]>();
  for (const f of frames) {
    const list = byUnit.get(f.at) ?? [];
    list.push(f);
    byUnit.set(f.at, list);
  }
  const out: FrameEntry[] = [];
  for (const list of byUnit.values()) {
    if (list.length < 2) { out.push(...list); continue; }
    const hits = list.filter(f => {
      const image = /\/image:(\d+)$/.exec(String(f.region ?? ""));
      if (image && ordinals.has(Number(image[1]) + 1)) return true;
      for (const t of String(f.label ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        // Digits name the UNIT ordinal ("page 1"), not the figure — matching
        // them would hit every frame of the unit and defeat the narrowing.
        if (UNIT_WORD.test(t) || /^\d+$/.test(t)) continue;
        if (qTokens.has(t)) return true;
      }
      return false;
    });
    out.push(...(hits.length ? hits : list));
  }
  return out.sort((a, b) => a.at - b.at);
}

export async function rereadRegions(
  attId: string,
  question: string,
  index: LoadedIndex,
  cueUnits: number[],
  opts: { runJob?: RunJob; signal?: AbortSignal; missingPassage?: boolean } = {},
): Promise<RereadOutcome> {
  // Region resolution: when the question itself names a unit ("the legend on
  // slide 2"), THAT is the requested figure — retrieval's cue set can be
  // wider (adjacency expansion pulls a neighbour passage in), and a closer
  // read of one figure must never re-inspect the neighbour. A request that
  // names no unit falls back to the units the retrieved passages name.
  const named = new Set<number>();
  for (const m of (question ?? "").matchAll(/(?:slide|page|sheet|unit|figure)\s*#?\s*(\d+)/gi)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) named.add(n);
  }
  const units = named.size ? named : new Set(cueUnits);
  const frames = pickRegionFrames(
    (index.meta.frames ?? []).filter(f => f.region && f.label && units.has(f.at)),
    question ?? "",
  );
  // F153 §3 (⇔ ruke-attach reread.rs): a MISSING retrieved passage is a
  // reason to try a targeted read when the original is available — the user
  // uploaded the document, the answer should speak about it. The question's
  // own named unit is the targeting (the cue set is empty when nothing was
  // retrieved); a missing-passage question naming no unit targets nothing
  // and runs ZERO inspection. Wording changes never hide missing evidence.
  const asked = REREAD_REQUEST.test(question ?? "");
  const targetsNamed = !!opts.missingPassage && named.size > 0;
  if (!frames.length || !(asked || targetsNamed)) return { lines: [], regions: [] };
  const src = uploadPath(attId);
  if (!src) return { lines: [], regions: [] };

  const cap = await readDocumentViaCapability(src, {
    ...(opts.runJob ? { runJob: opts.runJob } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    regions: frames.map(f => f.region as string),
  });
  if (cap.state !== "ready") return { lines: [], regions: [] };

  const updates: RegionRereadUpdate[] = [];
  const lines: string[] = [];
  for (const f of frames) {
    const region = f.region as string;
    const vp = cap.doc.visualPages.find(v => v.region === region);
    if (!vp) continue;
    const recognized = cap.doc.units.filter(u => u.provenance === "ocr" && u.unit === f.at);
    const text = recognized.map(u => u.text).filter(t => t.trim()).join("\n").trim();
    const eng = recognized.map(u => [u.engine, u.language].filter(Boolean).join(" / ")).find(Boolean) ?? "";
    // Dedup law: identical text already persisted for THIS region id is reused,
    // never appended twice; identical labels in DIFFERENT places stay separate
    // because region ids (the dedup key) differ.
    const head = text.slice(0, 80);
    const already = head !== "" && index.chunks.some(c => c.text.includes(`region ${region}]`) && c.text.includes(head));
    let bytes: Buffer;
    try {
      bytes = Buffer.from(vp.dataUrl.replace(/^data:image\/png;base64,/, ""), "base64");
    } catch {
      continue;
    }
    if (!bytes.length) continue;
    const chunkText = text && !already ? `### ${f.label}\n[text re-read by ${eng || "the selected engine"}, region ${region}]\n${text}` : null;
    let vec: number[] = [];
    if (chunkText) {
      try {
        vec = await embedOne(chunkText, opts.signal);
      } catch {
        vec = []; // embed unavailable: the text serves THIS turn only; no half-vector chunk
      }
    }
    updates.push({
      file: f.file,
      bytes,
      state: vp.region_state ?? (text ? "recognised" : "skipped"),
      text: chunkText,
      vec,
    });
    if (text && !already) {
      lines.push(`[re-read of ${f.label}, region ${region}${eng ? `, engine ${eng}` : ""}]\n${text}`);
    } else if (!text) {
      lines.push(
        `[re-read of ${f.label}, region ${region}]: the inspection ran again and recovered no text ` +
        `(state ${vp.region_state ?? "skipped"}); the refreshed picture is what this turn answers from.`,
      );
    }
    // already → the passage is retrieved as cached evidence; no duplicate line.
  }
  if (updates.length) await applyRegionReread(attId, updates);
  return { lines, regions: updates.length ? frames.filter(f => updates.some(u => u.file === f.file)).map(f => f.region as string) : [] };
}

/**
 * The production RegionReader shape used by buildAttachmentTurn (see turn.ts).
 * F153 §3: the turn also says whether THIS attachment's retrieval came up
 * empty (missingPassage) — a missing passage is a targeted-read reason — and
 * receives the full outcome so the refreshed crops can ride paired.
 */
export type RegionReader = (
  attId: string,
  question: string,
  index: LoadedIndex,
  cueUnits: number[],
  missingPassage: boolean,
) => Promise<RereadOutcome>;

export function makeRegionReader(opts: { runJob?: RunJob; signal?: AbortSignal } = {}): RegionReader {
  return async (attId, question, index, cueUnits, missingPassage) =>
    rereadRegions(attId, question, index, cueUnits, { ...opts, missingPassage });
}
