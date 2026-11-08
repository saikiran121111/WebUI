//! `lib/server/attachindex/retrieve.ts` — hybrid (cosine + BM25 → RRF)
//! evidence selection, ported expression-for-expression.
//!
//! Faithful quirks preserved:
//! - `cos`/`bm` are POSITION-indexed arrays while the sort operates on
//!   chunk IDS (`c.i`): an ID outside the array reads `undefined` in JS →
//!   `NaN` comparator → ECMA-262 treats NaN as `+0` (stable Equal), and
//!   `bm[i] > 0` is false for `undefined`. Rust reproduces both via
//!   `num_at` (OOB ⇒ NaN) and `cmp_diff` (NaN ⇒ Equal).
//! - JS `Map` insertion order decides pack's tie-break (sort is stable):
//!   `OrderMap` keeps the original slot on set-on-existing, exactly like
//!   `Map.set` / `Map.set(k, get(k) ?? 0 + …)`.
//! - Budget/env constants are read ONCE (TS reads env at module load;
//!   Rust reads on first use and caches — mid-process env edits are
//!   ignored on both sides). DOCUMENTED env deviations (env is unset in
//!   every supported config): an unparseable value reads NaN in JS; Rust
//!   keeps NaN for the char budget (every `used+cost > NaN` is false ⇔
//!   never truncates, same as JS) but maps a NaN `ATTACH_TOP_K` to 0
//!   (`slice(0, NaN)` is empty in JS — identical); negative TOP_K
//!   (`slice(0, -k)` = all-but-last in JS) clamps to 0 instead.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::OnceLock;

use ruke_skills::jsstr::js_len;

use crate::bm25::{bm25_scores, tokenize};
use crate::format::fmt_stamp;
use crate::router::QueryMode;
use crate::types::{IndexChunk, LoadedIndex};

const RRF_K: f64 = 60.0;

pub(crate) fn env_number(key: &str, default: f64) -> f64 {
    match std::env::var(key) {
        Ok(v) => {
            let v = v.trim();
            if v.is_empty() {
                0.0 // Number("") === 0 in JS
            } else {
                // Hex/Infinity-ish JS-accepted spellings are not produced
                // by any supported config; unparseable ⇒ NaN (JS Number).
                v.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        Err(_) => default,
    }
}

fn char_budget() -> f64 {
    static B: OnceLock<f64> = OnceLock::new();
    *B.get_or_init(|| env_number("ATTACH_RETRIEVE_CHARS", 24000.0))
}

/// NOTES_BUDGET in `turn.ts` reads the SAME env var.
pub(crate) fn notes_budget() -> f64 {
    char_budget()
}

/// PER_REF_BUDGET in `turn.ts` (I05) reads the SAME env var too; the turn
/// layer clamps it against the turn's remaining budget per attachment.
pub(crate) fn per_ref_budget() -> f64 {
    char_budget()
}

fn top_k() -> usize {
    static T: OnceLock<usize> = OnceLock::new();
    *T.get_or_init(|| {
        let t = env_number("ATTACH_TOP_K", 8.0);
        if t.is_nan() || t < 0.0 {
            0
        } else if t > usize::MAX as f64 {
            usize::MAX
        } else {
            t as usize
        }
    })
}

#[derive(Debug, Clone)]
pub struct Evidence {
    pub text: String,
    pub chunk_idxs: Vec<i64>,
    pub frame_ats: Vec<f64>,
    pub truncated: bool,
    /// I20: how many ranked candidates this turn's budget (or the demote
    /// list) left unserved. The turn layer turns that number into an
    /// honest marker instead of letting "more exists, count unknown" stand.
    pub dropped: usize,
}

/// `RetrieveOpts extends RoutedQuery { range? }` — turn.rs builds this
/// from `RoutedQuery`, replacing `blockIndex` with `range` in the
/// sequential branch.
#[derive(Debug, Clone, Default)]
pub struct RetrieveOpts {
    pub mode: QueryMode,
    pub from_sec: Option<f64>,
    pub to_sec: Option<f64>,
    pub range: Option<(i64, i64)>,
    /// Chunk ids already shown to this conversation (I20 demote).
    pub demote: Vec<i64>,
    /// Char budget override; defaults to ATTACH_RETRIEVE_CHARS (I05 turn
    /// budget). JS `opts.budget ?? BUDGET` — a NaN override is honored.
    pub budget: Option<f64>,
}

/// Insertion-ordered id→score map ⇔ JS `Map<number, number>` (set on an
/// existing key updates the value but KEEPS the original position).
#[derive(Default)]
pub(crate) struct OrderMap {
    keys: Vec<i64>,
    vals: Vec<f64>,
    pos: HashMap<i64, usize>,
}

impl OrderMap {
    pub(crate) fn set(&mut self, k: i64, v: f64) {
        match self.pos.get(&k) {
            Some(&p) => self.vals[p] = v,
            None => {
                self.pos.insert(k, self.keys.len());
                self.keys.push(k);
                self.vals.push(v);
            }
        }
    }
    fn get(&self, k: i64) -> Option<f64> {
        self.pos.get(&k).map(|&p| self.vals[p])
    }
    fn has(&self, k: i64) -> bool {
        self.pos.contains_key(&k)
    }
    fn entries(&self) -> Vec<(i64, f64)> {
        self.keys
            .iter()
            .copied()
            .zip(self.vals.iter().copied())
            .collect()
    }
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    let n = a.len().min(b.len());
    let mut s = 0.0f64;
    for i in 0..n {
        s += a[i] * b[i];
    }
    s
}

fn header(c: &IndexChunk) -> String {
    match c.start_sec {
        None => String::new(),
        Some(s) => format!("[{} - {}]", fmt_stamp(s), fmt_stamp(c.end_sec.unwrap_or(s))),
    }
}

fn rrf_fuse(lists: &[Vec<i64>]) -> OrderMap {
    let mut out = OrderMap::default();
    for list in lists {
        for (rank, &id) in list.iter().enumerate() {
            let add = 1.0 / (RRF_K + rank as f64 + 1.0);
            out.set(id, out.get(id).unwrap_or(0.0) + add);
        }
    }
    out
}

/// OOB array read ⇔ JS `arr[i]` on a number-indexed array: `undefined`.
fn num_at(arr: &[f64], id: i64) -> f64 {
    if id >= 0 && (id as usize) < arr.len() {
        arr[id as usize]
    } else {
        f64::NAN
    }
}

/// JS sort comparator result: NaN is treated as `+0` (ECMA-262
/// SortCompare), so NaN and 0 are both Equal.
fn cmp_diff(d: f64) -> Ordering {
    if d.is_nan() || d == 0.0 {
        Ordering::Equal
    } else if d < 0.0 {
        Ordering::Less
    } else {
        Ordering::Greater
    }
}

/// I20: ids in `demote` (passages an earlier turn already served for this
/// attachment) are held back so a follow-up turn sees FRESH passages
/// instead of the same top hits. They are only used when nothing else was
/// picked at all — an honest repeat beats an empty answer. Every unserved
/// candidate is counted in `dropped` for the turn's honest marker.
fn pack(index: &LoadedIndex, priority: &OrderMap, budget: f64, demote: &[i64]) -> Evidence {
    let chunks = &index.chunks;
    let len = chunks.len() as i64;
    let mut ordered: Vec<(i64, f64)> = priority
        .entries()
        .into_iter()
        .filter(|(i, _)| *i >= 0 && *i < len)
        .collect();
    // Stable sort ⇔ JS Array#sort; comparator `b[1] - a[1]` (descending).
    ordered.sort_by(|a, b| cmp_diff(b.1 - a.1));

    // `demote?.length ? new Set(demote) : null` — an empty list means NO
    // demotion channel at all (not "everything is demoted").
    let demote_set: Option<std::collections::HashSet<i64>> = if demote.is_empty() {
        None
    } else {
        Some(demote.iter().copied().collect())
    };
    let (fresh, held): (Vec<(i64, f64)>, Vec<(i64, f64)>) = match &demote_set {
        None => (ordered.clone(), Vec::new()),
        Some(set) => (
            ordered
                .iter()
                .copied()
                .filter(|(i, _)| !set.contains(i))
                .collect(),
            ordered
                .iter()
                .copied()
                .filter(|(i, _)| set.contains(i))
                .collect(),
        ),
    };

    let mut picked: Vec<i64> = Vec::new();
    let mut used: f64 = 0.0;
    let mut truncated = false;
    {
        // Returns how many ids THIS pass picked, so the held fallback can
        // be gated on `!picked.length` (TS) without aliasing `picked`
        // while the closure still owns it.
        let mut fill = |list: &[(i64, f64)]| -> usize {
            let before = picked.len();
            for &(i, _) in list {
                let c = &chunks[i as usize];
                let h = header(c);
                let mut cost = js_len(&c.text) as f64;
                if !h.is_empty() {
                    cost += js_len(&h) as f64 + 1.0;
                }
                if !picked.is_empty() {
                    cost += 2.0;
                }
                if used + cost > budget {
                    truncated = true;
                    continue; // keep scanning — a smaller chunk may still fit
                }
                picked.push(i);
                used += cost;
            }
            picked.len() - before
        };
        if fill(&fresh) == 0 {
            fill(&held);
        }
    }

    let dropped = ordered.len() - picked.len();
    picked.sort(); // `picked.sort((a, b) => a - b)`; ids are unique
    let text = picked
        .iter()
        .map(|&i| {
            let c = &chunks[i as usize];
            let h = header(c);
            if h.is_empty() {
                c.text.clone()
            } else {
                format!("{h}\n{}", c.text)
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let frame_ats = picked
        .iter()
        .filter_map(|&i| chunks[i as usize].start_sec)
        .collect();
    Evidence {
        text,
        chunk_idxs: picked,
        frame_ats,
        truncated,
        dropped,
    }
}

pub fn retrieve_evidence(
    index: &LoadedIndex,
    query: &str,
    query_vec: &[f64],
    opts: &RetrieveOpts,
) -> Evidence {
    let chunks = &index.chunks;
    // `opts.budget ?? BUDGET` (I05): the turn's remaining budget overrides
    // the env default when the caller passes one.
    let budget = opts.budget.unwrap_or_else(char_budget);

    if opts.mode == QueryMode::Sequential {
        if let Some((from, to)) = opts.range {
            let mut p = OrderMap::default();
            let mut i = from;
            while i <= to && i < chunks.len() as i64 {
                if i >= 0 {
                    p.set(i, 1.0);
                }
                i += 1;
            }
            return pack(index, &p, budget, &opts.demote);
        }
    }

    if opts.mode == QueryMode::TimeRange {
        if let Some(from) = opts.from_sec {
            let to = opts.to_sec.unwrap_or(from + 300.0);
            let mut p = OrderMap::default();
            for c in chunks {
                let s = match c.start_sec {
                    Some(s) => s,
                    None => continue,
                };
                if c.end_sec.unwrap_or(s) >= from && s <= to {
                    p.set(c.i, 1.0);
                }
            }
            return pack(index, &p, budget, &opts.demote);
        }
    }

    // Hybrid: cosine (query embedding vs chunk vec) + BM25 → RRF fusion.
    let cos: Vec<f64> = chunks.iter().map(|c| dot(query_vec, &c.vec)).collect();
    let toks: Vec<Vec<String>> = chunks.iter().map(|c| tokenize(&c.text)).collect();
    let bm = bm25_scores(query, &toks);
    let ids: Vec<i64> = chunks.iter().map(|c| c.i).collect();

    // I20: an exhaustive sweep considers EVERY chunk, not the head of each
    // channel — the budget (not a 20-candidate lens) is what caps output.
    let cap = if opts.mode == QueryMode::Exhaustive {
        ids.len()
    } else {
        20
    };
    // I21: an unavailable embedder leaves queryVec empty, and an all-zero
    // cosine channel would vote arbitrary chunk order into the fusion.
    // With no vector there is NO cosine channel: BM25 ranks on its own.
    let has_vec = !query_vec.is_empty();
    let by_cos: Vec<i64> = if has_vec {
        let mut v = ids.clone();
        v.sort_by(|a, b| cmp_diff(num_at(&cos, *b) - num_at(&cos, *a)));
        v.truncate(cap);
        v
    } else {
        Vec::new()
    };

    let mut by_bm = ids;
    by_bm.sort_by(|a, b| cmp_diff(num_at(&bm, *b) - num_at(&bm, *a)));
    by_bm.retain(|i| num_at(&bm, *i) > 0.0);
    by_bm.truncate(cap);

    let lists: Vec<Vec<i64>> = if has_vec {
        vec![by_cos, by_bm]
    } else {
        vec![by_bm]
    };
    let fused = rrf_fuse(&lists);
    let mut seeds = fused.entries();
    seeds.sort_by(|a, b| cmp_diff(b.1 - a.1));
    if opts.mode != QueryMode::Exhaustive {
        seeds.truncate(top_k());
    }

    let mut priority = OrderMap::default();
    for (i, s) in seeds {
        priority.set(i, priority.get(i).unwrap_or(0.0).max(s));
        if opts.mode == QueryMode::PointQa {
            for nb in [i - 1, i + 1] {
                if nb >= 0 && nb < chunks.len() as i64 && !priority.has(nb) {
                    priority.set(nb, s * 0.5);
                }
            }
        }
    }
    pack(index, &priority, budget, &opts.demote)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{IndexChunk, IndexMeta};

    fn idx(chunks: Vec<IndexChunk>) -> LoadedIndex {
        LoadedIndex {
            meta: IndexMeta::default(),
            chunks,
        }
    }
    fn ch(i: i64, start: Option<f64>, end: Option<f64>, text: &str, vec: Vec<f64>) -> IndexChunk {
        IndexChunk {
            i,
            start_sec: start,
            end_sec: end,
            text: text.to_string(),
            vec,
        }
    }

    fn opts(mode: QueryMode) -> RetrieveOpts {
        RetrieveOpts {
            mode,
            ..Default::default()
        }
    }

    #[test]
    fn sequential_range_is_clipped_and_ordered() {
        let index = idx(vec![
            ch(0, None, None, "a", vec![]),
            ch(1, None, None, "b", vec![]),
            ch(2, None, None, "c", vec![]),
        ]);
        let o = RetrieveOpts {
            mode: QueryMode::Sequential,
            range: Some((1, 5)),
            ..Default::default()
        };
        let ev = retrieve_evidence(&index, "zz", &[], &o);
        assert_eq!(ev.chunk_idxs, [1, 2]);
        assert_eq!(ev.text, "b\n\nc");
        assert!(!ev.truncated);
    }

    #[test]
    fn time_range_inclusive_overlap_uses_endsec_fallback() {
        let index = idx(vec![
            ch(0, Some(0.0), Some(60.0), "first", vec![]),
            ch(1, Some(100.0), None, "gapless-end-fallback", vec![]), // endSec ?? startSec
            ch(2, None, None, "no time", vec![]),
        ]);
        let o = RetrieveOpts {
            mode: QueryMode::TimeRange,
            from_sec: Some(50.0),
            to_sec: Some(100.0),
            ..Default::default()
        };
        let ev = retrieve_evidence(&index, "q", &[], &o);
        // chunk0: end 60 >= 50 && 0 <= 100 ✓; chunk1: 100 >= 50 && 100 <= 100 ✓; chunk2 skipped.
        assert_eq!(ev.chunk_idxs, [0, 1]);
        assert_eq!(ev.frame_ats, vec![0.0, 100.0]);
        // chunk1's startSec is NOT null ⇒ the header prints, with the
        // `endSec ?? startSec` fallback twice (100s ⇒ 00:01:40).
        assert_eq!(
            ev.text,
            "[00:00:00 - 00:01:00]\nfirst\n\n[00:01:40 - 00:01:40]\ngapless-end-fallback"
        );
    }

    #[test]
    fn budget_truncation_flag_and_join_cost() {
        // Three 3-char chunks, headers off. budget: 3, then 3+2=5, then 3+2.
        let index = idx(vec![
            ch(0, None, None, "aaa", vec![]),
            ch(1, None, None, "bbb", vec![]),
            ch(2, None, None, "ccc", vec![]),
        ]);
        // budget 10: 3 fits; 3+2=5 → 8 fits; 3+2=5 → 13 > 10 ⇒ truncated.
        let ev = {
            let mut p = OrderMap::default();
            p.set(0, 1.0);
            p.set(1, 1.0);
            p.set(2, 1.0);
            pack(&index, &p, 10.0, &[])
        };
        assert_eq!(ev.chunk_idxs, [0, 1]);
        assert!(ev.truncated);
    }

    #[test]
    fn ordermap_set_keeps_position_and_hybrid_scores() {
        let mut m = OrderMap::default();
        m.set(5, 1.0);
        m.set(7, 2.0);
        m.set(5, 9.0); // keeps slot 0
        assert_eq!(m.entries(), [(5, 9.0), (7, 2.0)]);

        // point_qa seeds pull neighbors at half score.
        let index = idx((0..4)
            .map(|i| {
                ch(
                    i,
                    None,
                    None,
                    if i == 1 { "alpha term" } else { "beta" },
                    vec![],
                )
            })
            .collect());
        let ev = retrieve_evidence(&index, "alpha term", &[], &opts(QueryMode::PointQa));
        assert!(ev.chunk_idxs.contains(&1));
        assert!(
            ev.chunk_idxs.contains(&0) && ev.chunk_idxs.contains(&2),
            "neighbors: {:?}",
            ev.chunk_idxs
        );

        // exhaustive keeps ALL seeds (no TOP_K slice).
        let many = idx((0..9)
            .map(|i| {
                ch(
                    i,
                    None,
                    None,
                    if i == 4 { "alpha term" } else { "alpha filler" },
                    vec![],
                )
            })
            .collect());
        let ev = retrieve_evidence(&many, "alpha term", &[], &opts(QueryMode::Exhaustive));
        assert_eq!(ev.chunk_idxs.len(), 9);
    }

    #[test]
    fn rrf_tie_break_is_insertion_order() {
        let fused = rrf_fuse(&[vec![0, 1], vec![1, 0]]);
        // both score 1/61 + 1/62 ⇒ equal ⇒ pack's stable order = Map
        // insertion order: 0 first (list1 rank0), then 1.
        assert_eq!(
            fused.entries().iter().map(|(k, _)| *k).collect::<Vec<_>>(),
            [0, 1]
        );
        let a = fused.get(0).unwrap();
        let b = fused.get(1).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn position_vs_id_indexing_nan_semantics() {
        // Chunk ids NOT equal to positions: cos/bm stay position arrays.
        let index = idx(vec![
            ch(7, None, None, "alpha term", vec![1.0, 0.0]),
            ch(0, None, None, "beta", vec![0.0, 1.0]),
        ]);
        // I21 made the cosine channel conditional, so an explicit
        // non-empty queryVec is required to keep the quirk observable.
        // cos = [1, 0] positionally; sort comparator indexes cos BY ID:
        // cos[0]=1, cos[7]=NaN ⇒ NaN comparators read Equal (stable) ⇒ [7, 0].
        let ev = retrieve_evidence(&index, "beta", &[1.0], &opts(QueryMode::Exhaustive));
        // bm is POSITION-indexed but filtered BY chunk ID: bm[7] is OOB
        // (undefined ⇒ not > 0) and bm[0] is position 0's score (0.0 ⇒
        // not > 0, the hit lives at position 1) ⇒ by_bm is EMPTY.
        // fused = by_cos only: id 7 → 1/61, id 0 → 1/62. pack then drops
        // id 7 (id ≥ chunks.len()) and indexes `chunks[i]` POSITIONALLY
        // with the id-keyed priority ⇒ the sole pick (id 0) renders array
        // slot 0 — the chunk whose ID is 7. Chord-IDs are ordinals in
        // every index the Node writer produces, so this composition is
        // exact in production; the quirk is pinned here as in JS.
        assert_eq!(ev.chunk_idxs, [0]);
        assert_eq!(ev.text, "alpha term");
        assert!(ev.frame_ats.is_empty());
    }

    #[test]
    fn empty_corpus_is_empty_evidence() {
        let ev = retrieve_evidence(&idx(vec![]), "q", &[1.0], &opts(QueryMode::PointQa));
        assert!(ev.text.is_empty());
        assert!(ev.chunk_idxs.is_empty());
        assert!(!ev.truncated);
    }

    #[test]
    fn env_number_js_number_edge() {
        // Unset in the test env ⇒ defaults (do not set these in CI!).
        assert_eq!(env_number("ATTACH_RETRIEVE_CHARS_UNSET", 24000.0), 24000.0);
    }

    // ── I20/I21/I05 honesty pins — mirror of
    // __tests__/server/attach-retrieve-honest.test.ts ────────────────────

    /// TS `idx(texts)` helper: position ids, no vectors unless given.
    fn unit(texts: &[&str], timed: bool) -> LoadedIndex {
        idx(texts
            .iter()
            .enumerate()
            .map(|(i, t)| {
                ch(
                    i as i64,
                    if timed { Some(i as f64 * 600.0) } else { None },
                    if timed {
                        Some((i as f64 + 1.0) * 600.0)
                    } else {
                        None
                    },
                    t,
                    vec![],
                )
            })
            .collect())
    }
    fn widgets(n: usize) -> LoadedIndex {
        let ts: Vec<String> = (0..n)
            .map(|i| format!("mention of widget number {i}"))
            .collect();
        idx(ts
            .iter()
            .enumerate()
            .map(|(i, t)| ch(i as i64, None, None, t, vec![]))
            .collect())
    }

    #[test]
    fn dropped_counts_candidates_the_budget_refused_i20() {
        // ~30-char texts: 26, 28+2, 28+2 fit (86); 28+2 overflows 100 ⇒ 3.
        let ev = retrieve_evidence(
            &widgets(30),
            "widget",
            &[],
            &RetrieveOpts {
                mode: QueryMode::Exhaustive,
                budget: Some(100.0),
                ..Default::default()
            },
        );
        assert_eq!(ev.chunk_idxs.len(), 3);
        assert_eq!(ev.dropped, 27);
        assert!(ev.truncated);
    }

    #[test]
    fn zero_dropped_when_the_whole_selection_fits_i20() {
        let ev = retrieve_evidence(&widgets(30), "widget", &[], &opts(QueryMode::Exhaustive));
        assert_eq!(ev.dropped, 0);
        assert!(!ev.truncated);
        assert_eq!(
            ev.chunk_idxs,
            (0..30).collect::<Vec<i64>>(),
            "exhaustive cap is the whole corpus, not 20"
        );
    }

    #[test]
    fn non_exhaustive_still_stops_at_top_k_seeds_i20() {
        let corpus = widgets(30);
        let sq = retrieve_evidence(
            &corpus,
            "widget",
            &[],
            &RetrieveOpts {
                mode: QueryMode::Sequential,
                range: Some((0, 29)),
                ..Default::default()
            },
        );
        assert_eq!(sq.chunk_idxs.len(), 30);
        let pt = retrieve_evidence(&corpus, "widget", &[], &opts(QueryMode::PointQa));
        assert!(
            pt.chunk_idxs.len() < 30,
            "TOP_K seeds + neighbors stay far below the corpus"
        );
    }

    #[test]
    fn demote_sinks_shown_passages_below_fresh_i20() {
        let corpus = unit(&["widget first", "widget second", "widget third"], false);
        let ev = retrieve_evidence(
            &corpus,
            "widget",
            &[],
            &RetrieveOpts {
                mode: QueryMode::PointQa,
                demote: vec![0],
                ..Default::default()
            },
        );
        // Identical-length identical-token chunks ⇒ BM25 ties ⇒ stable
        // order [0,1,2]; seeds + neighbors cover all; demoted id 0 is held
        // back but the fresh set fills first ⇒ [1, 2], dropped 1.
        assert_eq!(ev.chunk_idxs, [1, 2]);
        assert_eq!(ev.dropped, 1);
    }

    #[test]
    fn demote_all_serves_the_held_set_never_empty_i20() {
        let corpus = unit(&["widget first", "widget second", "widget third"], false);
        let ev = retrieve_evidence(
            &corpus,
            "widget",
            &[],
            &RetrieveOpts {
                mode: QueryMode::PointQa,
                demote: vec![0, 1, 2],
                ..Default::default()
            },
        );
        assert!(
            !ev.chunk_idxs.is_empty(),
            "an honest repeat beats an empty answer"
        );
        assert!(ev.text.contains("widget"));
    }

    #[test]
    fn held_never_substitutes_when_fresh_fills_the_budget_i20() {
        let corpus = unit(&["widget aaa", "widget bbb", "widget ccc"], false);
        let ev = retrieve_evidence(
            &corpus,
            "widget",
            &[],
            &RetrieveOpts {
                mode: QueryMode::PointQa,
                demote: vec![0],
                budget: Some(10.0),
                ..Default::default()
            },
        );
        // fresh [1,2]: only id1 fits (10 cost); id2 overflows; held id0
        // must NOT substitute — budget, not availability, is the constraint.
        assert_eq!(ev.chunk_idxs, [1]);
    }

    #[test]
    fn time_range_passes_demote_through_pack_i20() {
        let corpus = unit(&["widget a", "widget b", "widget c"], true);
        let ev = retrieve_evidence(
            &corpus,
            "",
            &[],
            &RetrieveOpts {
                mode: QueryMode::TimeRange,
                from_sec: Some(0.0),
                to_sec: Some(1e9),
                demote: vec![1],
                ..Default::default()
            },
        );
        assert_eq!(ev.chunk_idxs, [0, 2]);
    }

    #[test]
    fn no_cosine_channel_without_a_query_vec_i21() {
        let corpus = idx(vec![
            ch(
                0,
                None,
                None,
                "zeta filler text aaaaaaaaaaaaaa",
                vec![1.0, 0.0],
            ),
            ch(
                1,
                None,
                None,
                "irrelevant prose bbbbbbbbbbbbbbbb",
                vec![0.0, 1.0],
            ),
            ch(
                2,
                None,
                None,
                "zeta zeta text cccccccccccccccc",
                vec![0.0, 0.0],
            ),
        ]);
        let o = RetrieveOpts {
            mode: QueryMode::PointQa,
            budget: Some(33.0),
            ..Default::default()
        };
        // Both term hits carry "zeta": BM25 crowns chunk 2 (higher tf),
        // cosine would crown chunk 0. With the cosine channel the RRF lists
        // tie-score 0 and 2 and cosine is inserted FIRST ⇒ 0 wins; with NO
        // vector, BM25 alone crowns 2. (30-char texts: budget 33 serves
        // exactly one.)
        let with = retrieve_evidence(&corpus, "zeta", &[1.0, 0.0], &o);
        assert_eq!(with.chunk_idxs, [0]);
        let no = retrieve_evidence(&corpus, "zeta", &[], &o);
        assert_eq!(no.chunk_idxs, [2]);
        assert!(no.text.contains("zeta zeta"));
    }

    #[test]
    fn budget_override_replaces_the_env_default_i05() {
        let ts: Vec<String> = (0..3)
            .map(|i| format!("{} marker {}", "y".repeat(500), i))
            .collect();
        let corpus = idx(ts
            .iter()
            .enumerate()
            .map(|(i, t)| ch(i as i64, None, None, t, vec![]))
            .collect());
        let ev = retrieve_evidence(
            &corpus,
            "marker",
            &[],
            &RetrieveOpts {
                mode: QueryMode::Exhaustive,
                budget: Some(1024.0),
                ..Default::default()
            },
        );
        // 509-char texts, no headers: 509 fits; 509+511=1020 ≤ 1024 fits;
        // +511 > 1024 ⇒ 2 picked.
        assert_eq!(ev.chunk_idxs.len(), 2);
        assert_eq!(ev.dropped, 1);
        assert!(
            js_len(&ev.text) <= 1024,
            "JS .length budget: {} UTF-16 units",
            js_len(&ev.text)
        );
    }
}
