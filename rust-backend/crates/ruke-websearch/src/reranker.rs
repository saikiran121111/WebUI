//! Parity port of `lib/web-search/reranker.ts` — pure-CPU BM25 lexical
//! reranker (chunking + tokenization + junk filter + BM25 + rerank).
//!
//! JS-vs-Rust divergences recorded per the PARITY rule (nothing "fixed"):
//! - JS `.length`/`.slice` are UTF-16 code units → [`utf16_len`] /
//!   [`utf16_slice`]; Rust slicing snaps to char boundaries, so a slice
//!   that would cut a surrogate pair in JS yields a well-formed String
//!   here (in practice all chunk text is BMP).
//! - **Preserved TS bug**: in `chunkMarkdown` the overlap-carry branch
//!   calls `flush(pos)` (which clears `buf`) and *then* reads
//!   `buf.slice(-overlap)` — the tail is therefore ALWAYS empty, so the
//!   "300-char overlap" never carries anything and the next chunk starts
//!   with a stray leading `\n` that a later `trim()` erases. Ported
//!   verbatim (see the `tail` line).
//! - **Preserved TS quirk**: `placeholderText.replace(blockText, ph)`
//!   replaces the FIRST occurrence of the block text, not the matched
//!   span — duplicate blocks can mismatch. Same for `resolvePlaceholder`.
//! - **Preserved TS quirk**: `flush` checks `text.length >= 40` BEFORE
//!   placeholder resolution — a bare `[[ATOMIC_n]]` stub under 40 chars
//!   drops the whole (giant) block.
//! - **Preserved TS quirk**: `atomicBlocks[i].start/end` are computed
//!   (`(m.index ?? 0) + blockText.length` — a trimmed-length end, wrong by
//!   design) but NEVER read; dropped here (dead fields would be Rust
//!   warnings).
//! - **Dropped dead code** (never referenced in TS): `ATOMIC_BLOCK_RE`
//!   (the three regexes are inline literals in `processAtomic` calls).
//! - `RerankHit` is exported by TS but never constructed; kept for
//!   surface parity.
//! - The lookahead split (`/\n{2,}|\n(?=#{1,4}\s)/`) and the
//!   `[Structured Page Facts]` atomic regex need lookaheads the regex
//!   crate lacks → hand-written scanners with identical semantics
//!   (incl. JS `/m` `$` inside the lookahead = end-of-line-or-text).
//! - `String.prototype.trim` vs Rust `str::trim`: U+FEFF trimmed in JS,
//!   not in Rust — inputs are extracted markdown; negligible.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use regex::Regex;

use crate::types::{EvidencePacket, EvidencePassage};

/* ── JS-UTF-16 helpers ─────────────────────────────────────────────────── */

/// JS `String.length` (UTF-16 code units).
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS `s.slice(start, end)` (UTF-16 units, clamped; char-boundary snap).
fn utf16_slice(s: &str, start: usize, end: usize) -> String {
    let mut out = String::new();
    let mut u = 0usize;
    for c in s.chars() {
        let cu = c.len_utf16();
        if u >= end {
            break;
        }
        if u >= start {
            out.push(c);
        }
        u += cu;
    }
    out
}

/// JS `s.slice(0, n)`.
fn utf16_prefix(s: &str, n: usize) -> String {
    utf16_slice(s, 0, n)
}

/// JS `s.slice(-n)`.
fn utf16_suffix(s: &str, n: usize) -> String {
    let len = utf16_len(s);
    utf16_slice(s, len.saturating_sub(n), len)
}

/* ── chunking ──────────────────────────────────────────────────────────── */

/// ⇔ local TS `interface Chunk`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub text: String,
    pub start_index: usize,
}

fn re_atomic_fence() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"```[\s\S]*?```").unwrap())
}

fn re_atomic_table() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^\|.*\|(?:\n\|.*\|)*").unwrap())
}

fn re_atomic_placeholder() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\[\[ATOMIC_(?-u:\d+)\]\]$").unwrap())
}

const SPF_HEADER: &str = "[Structured Page Facts]";

/// ⇔ the THIRD `processAtomic` regex (no regex-crate equivalent —
/// `[\s\S]+?` lazy + `\n\n(?=#|\[Structured|$)` lookahead with JS `/m`):
/// header at a line start, then the earliest position q ≥ header-end+1
/// where `\n\n` is followed by `#`, `[Structured`, a line end (JS `/m`
/// `$`), or end of text. Returns the match span (byte offsets).
fn structured_facts_matches(s: &str) -> Vec<(usize, usize)> {
    let bytes = s.as_bytes();
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(rel) = s[from..].find(SPF_HEADER) {
        let start = from + rel;
        from = start + SPF_HEADER.len();
        // /m `^` — string start or immediately after a newline.
        if start != 0 && bytes[start - 1] != b'\n' {
            continue;
        }
        let mut q = start + SPF_HEADER.len() + 1; // `[\s\S]+?` needs ≥1 char
        // NOTE: `q.min(len)` keeps the search from going backwards; when
        // q == len the find on "" yields None (loop ends).
        while let Some(rel) = s[q.min(s.len())..].find("\n\n") {
            let nl = q + rel;
            if nl + 2 <= start + SPF_HEADER.len() {
                // `\n\n` overlaps the header end — push past it.
                q = nl + 1;
                continue;
            }
            let after = nl + 2;
            let ok = after == s.len()
                || s[after..].starts_with('#')
                || s[after..].starts_with("[Structured")
                || s[after..].starts_with('\n'); // JS /m `$` = end-of-line
            if ok {
                out.push((start, nl));
                break;
            }
            q = nl + 1;
        }
    }
    out
}

/// ⇔ `placeholderText.split(/\n{2,}|\n(?=#{1,4}\s)/)` — greedy-alternation
/// left-to-right scan (the regex crate has no look-around).
fn split_paragraphs(s: &str) -> Vec<String> {
    let is_js_ws = |c: char| c.is_whitespace() || c == '\u{FEFF}';
    let b = s.as_bytes();
    let mut segs = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < b.len() {
        if b[i] == b'\n' {
            if i + 1 < b.len() && b[i + 1] == b'\n' {
                // `\n{2,}` — consume the whole newline run as one separator.
                segs.push(s[start..i].to_string());
                while i < b.len() && b[i] == b'\n' {
                    i += 1;
                }
                start = i;
                continue;
            }
            // single `\n` + lookahead `#{1,4}\s`
            let mut j = i + 1;
            let mut hashes = 0;
            while j < b.len() && b[j] == b'#' && hashes < 4 {
                j += 1;
                hashes += 1;
            }
            if hashes >= 1 && j < b.len() && is_js_ws(s[j..].chars().next().unwrap()) {
                segs.push(s[start..i].to_string());
                i += 1;
                start = i;
                continue;
            }
        }
        i += 1;
    }
    segs.push(s[start..].to_string());
    segs
}

/// ⇔ TS `chunkMarkdown(md, target = 2000, overlap = 300)`.
pub fn chunk_markdown(md: &str, target: usize, overlap: usize) -> Vec<Chunk> {
    let cleaned = md.replace("\r\n", "\n");
    let mut chunks: Vec<Chunk> = Vec::new();

    // Pass 1: extract atomic blocks (code fences, tables, structured page
    // facts) and replace them with placeholders in the main text.
    const ATOMIC_CAP: usize = 8000;
    let mut atomic_text: Vec<String> = Vec::new();
    let mut placeholder_text = cleaned.clone();
    let mut placeholder = 0usize;

    {
        // processAtomic ⇔ the TS closure of the same name; spans are byte
        // spans over `cleaned`, guaranteed to be char boundaries.
        let mut process = |spans: Vec<(usize, usize)>| {
            for (start, end) in spans {
                let block_text = cleaned[start..end].trim().to_string();
                if utf16_len(&block_text) < 40 {
                    continue;
                }
                let capped = if utf16_len(&block_text) > ATOMIC_CAP {
                    utf16_prefix(&block_text, ATOMIC_CAP)
                } else {
                    block_text.clone()
                };
                atomic_text.push(capped);
                let ph = format!("[[ATOMIC_{placeholder}]]");
                placeholder += 1;
                // ⇔ String.replace(blockText, ph) — FIRST occurrence.
                if let Some(pos) = placeholder_text.find(&block_text) {
                    placeholder_text.replace_range(pos..pos + block_text.len(), &ph);
                }
            }
        };
        // Fenced code blocks.
        process(
            re_atomic_fence()
                .find_iter(&cleaned)
                .map(|m| (m.start(), m.end()))
                .collect(),
        );
        // Markdown tables (contiguous | rows).
        process(
            re_atomic_table()
                .find_iter(&cleaned)
                .map(|m| (m.start(), m.end()))
                .collect(),
        );
        // [Structured Page Facts] blocks.
        process(structured_facts_matches(&cleaned));
    }

    let resolve_placeholder = |s: &str| -> String {
        let mut result = s.to_string();
        for (i, at) in atomic_text.iter().enumerate() {
            let ph = format!("[[ATOMIC_{i}]]");
            if let Some(pos) = result.find(&ph) {
                result.replace_range(pos..pos + ph.len(), at);
            }
        }
        result
    };

    // Pass 2: chunk the remaining prose (placeholders resolved on emit).
    let paragraphs = split_paragraphs(&placeholder_text);
    let mut buf = String::new();
    let mut buf_start = 0usize;

    let flush = |end: usize,
                 buf: &mut String,
                 buf_start: &mut usize,
                 chunks: &mut Vec<Chunk>| {
        let text = buf.trim().to_string();
        if utf16_len(&text) >= 40 {
            chunks.push(Chunk {
                text: resolve_placeholder(&text),
                start_index: *buf_start,
            });
        }
        buf.clear();
        *buf_start = end;
    };

    let mut pos = 0usize;
    for para in &paragraphs {
        let p = para.trim();
        if p.is_empty() {
            continue;
        }
        // Paragraph that IS an atomic placeholder → own chunk, never split.
        if re_atomic_placeholder().is_match(p) {
            let n: usize = p["[[ATOMIC_".len()..p.len() - "]]".len()].parse().unwrap_or(usize::MAX);
            flush(pos, &mut buf, &mut buf_start, &mut chunks);
            // TS `atomicBlocks[Number(m[1])].text` throws on a bogus index;
            // expect mirrors that throw (panic) instead of silently skipping.
            let atomic = atomic_text
                .get(n)
                .expect("chunkMarkdown: placeholder number out of range (TS TypeError)");
            let at = atomic.trim();
            if utf16_len(at) >= 40 {
                chunks.push(Chunk {
                    text: at.to_string(),
                    start_index: pos,
                });
            }
            pos += utf16_len(p) + 2;
            continue;
        }
        if utf16_len(p) > target * 2 {
            // Very long paragraph: hard-slice with overlap.
            let mut i = 0usize;
            while i < utf16_len(p) {
                chunks.push(Chunk {
                    text: resolve_placeholder(&utf16_slice(p, i, i + target)),
                    start_index: pos + i,
                });
                i += target - overlap;
            }
            pos += utf16_len(p) + 2;
            continue;
        }
        if utf16_len(&buf) + utf16_len(p) + 2 > target {
            flush(pos, &mut buf, &mut buf_start, &mut chunks);
            // carry overlap tail into the next chunk — TS reads
            // `buf.slice(-overlap)` AFTER `flush` cleared `buf`, so tail
            // is ALWAYS "" here too. BUG PRESERVED.
            let tail = utf16_suffix(&buf, overlap);
            buf = format!("{tail}\n{p}");
            buf_start = pos + (if tail.is_empty() { 0 } else { 2 });
        } else {
            buf = if buf.is_empty() {
                p.to_string()
            } else {
                format!("{buf}\n{p}")
            };
        }
        pos += utf16_len(p) + 2;
    }
    flush(pos, &mut buf, &mut buf_start, &mut chunks);
    chunks
}

/* ── tokenization ─────────────────────────────────────────────────────── */

fn stopword_set() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| {
        [
            "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "could", "did", "do",
            "does", "for", "from", "had", "have", "he", "her", "his", "i", "if", "in", "is", "it",
            "its", "me", "my", "no", "nor", "not", "of", "on", "or", "she", "should", "so",
            "that", "the", "their", "them", "they", "this", "to", "was", "we", "were", "what",
            "when", "which", "who", "will", "with", "you", "your", "how", "why", "where", "whom",
            "whose", "im", "dont", "don't", "most", "much", "many", "more",
        ]
        .into_iter()
        .collect()
    })
}

/// ⇔ TS `tokenize` (stopword list kept verbatim — including the
/// unreachable `"don't"` entry, whose apostrophe can never survive the
/// `[^a-z0-9]+` strip, and the duplicate words the TS `Set` deduped).
pub fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() {
                c
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split(' ')
        .filter(|t| t.chars().count() > 1 && !stopword_set().contains(*t))
        .map(|t| t.to_string())
        .collect()
}

/* ── Junk passage filter ─────────────────────────────────────────────── */

fn junk_patterns() -> &'static [Regex; 6] {
    static PATS: OnceLock<[Regex; 6]> = OnceLock::new();
    PATS.get_or_init(|| {
        [
            Regex::new(r"(?i)cookie[sd]? (policy|notice|banner)|we use (cookies|local storage)|enable cookies to continue").unwrap(),
            Regex::new(r"(?i)by continuing you (agree|acknowledge)|privacy policy|terms of (service|use)|gdpr|do not (sell|share) my (personal )?information").unwrap(),
            Regex::new(r"(?i)^(sign in|log in|log-in|continue with|or sign in|create an account)").unwrap(),
            Regex::new(r"(?i)follow us (on|:)|subscribe|newsletter|all rights reserved|\(c\) (?-u:\d{4})").unwrap(),
            Regex::new(r"(?i)ad (slot|space|zone)|sponsored (content|link)|related (articles|videos)|you may also (like|enjoy)|trending (now|topics)").unwrap(),
            // `jump (to|to)` duplication kept verbatim (TS quirk).
            Regex::new(r"(?i)back to (top|main|home)|jump (to|to) (content|main)|accessibility (statement|menu)").unwrap(),
        ]
    })
}

/// ⇔ TS `junkPenalty`: 0 = clean content, 1 = pure boilerplate
/// (2+ pattern hits ⇒ full penalty).
pub fn junk_penalty(text: &str) -> f64 {
    let t = text.to_lowercase();
    let mut hits = 0u32;
    for re in junk_patterns().iter() {
        if re.is_match(&t) {
            hits += 1;
        }
    }
    (hits as f64 / 2.0).min(1.0)
}

/* ── BM25 ─────────────────────────────────────────────────────────────── */

/// ⇔ TS `Bm25Index` (Map → HashMap; nothing reads its iteration order).
#[derive(Debug, Clone)]
pub struct Bm25Index {
    pub df: HashMap<String, i64>,
    pub doc_tf: HashMap<usize, HashMap<String, i64>>,
    pub doc_len: Vec<usize>,
    pub avg_len: f64,
    pub docs: Vec<String>,
}

pub const BM25_K1: f64 = 1.5;
pub const BM25_B: f64 = 0.75;

pub fn build_bm25(docs: Vec<String>) -> Bm25Index {
    let n = docs.len();
    let tokenized: Vec<Vec<String>> = docs.iter().map(|d| tokenize(d)).collect();
    let mut df: HashMap<String, i64> = HashMap::new();
    let mut doc_tf: HashMap<usize, HashMap<String, i64>> = HashMap::new();

    for (i, tok) in tokenized.iter().enumerate() {
        let mut tf: HashMap<String, i64> = HashMap::new();
        for t in tok {
            *tf.entry(t.clone()).or_insert(0) += 1;
        }
        for term in tf.keys() {
            *df.entry(term.clone()).or_insert(0) += 1;
        }
        doc_tf.insert(i, tf);
    }

    let total_tokens: usize = tokenized.iter().map(|t| t.len()).sum();
    Bm25Index {
        df,
        doc_tf,
        docs,
        doc_len: tokenized.iter().map(|t| t.len()).collect(),
        avg_len: if n != 0 {
            total_tokens as f64 / n as f64
        } else {
            0.0
        },
    }
}

/// ⇔ TS `bm25Score`: `[docIdx, score]` pairs, score desc (stable ⇒
/// ties keep ascending doc order, same as V8), score > 0 only, top-K.
pub fn bm25_score(idx: &Bm25Index, query: &str, top_k: usize) -> Vec<(usize, f64)> {
    let mut q_terms: HashMap<String, i64> = HashMap::new();
    for t in tokenize(query) {
        *q_terms.entry(t).or_insert(0) += 1;
    }
    let n = idx.docs.len();
    if n == 0 || q_terms.is_empty() {
        return Vec::new();
    }

    let mut scores = vec![0.0f64; n];
    for (term, qf) in &q_terms {
        let dfv = *idx.df.get(term).unwrap_or(&0);
        if dfv == 0 {
            continue;
        }
        let idf = (1.0 + (n as f64 - dfv as f64 + 0.5) / (dfv as f64 + 0.5)).ln();
        for (i, sc) in scores.iter_mut().enumerate().take(n) {
            let tf = *idx.doc_tf.get(&i).and_then(|m| m.get(term)).unwrap_or(&0);
            if tf == 0 {
                continue;
            }
            let denom = tf as f64
                + BM25_K1 * (1.0 - BM25_B + BM25_B * (idx.doc_len[i] as f64 / idx.avg_len));
            *sc += (*qf as f64) * idf * (tf as f64 * (BM25_K1 + 1.0)) / denom;
        }
    }

    let mut out: Vec<(usize, f64)> = scores
        .iter()
        .enumerate()
        .filter(|(_, s)| **s > 0.0)
        .map(|(i, s)| (i, *s))
        .collect();
    out.sort_by(|a, b| b.1.total_cmp(&a.1));
    out.truncate(top_k);
    out
}

/* ── public rerank API ─────────────────────────────────────────────────── */

/// ⇔ TS exported `RerankHit` — never constructed in TS, kept for surface
/// parity.
#[derive(Debug, Clone)]
pub struct RerankHit {
    pub packet: EvidencePacket,
    pub passage: EvidencePassage,
    pub score: f64,
}

/// ⇔ TS `rerank(packets, userPrompt, gateQueries, topN = 30, opts)`.
/// `single_domain_unlimited` ⇔ `opts?.singleDomainUnlimited ?? false`.
pub fn rerank(
    packets: &[EvidencePacket],
    user_prompt: &str,
    gate_queries: &[String],
    top_n: usize,
    single_domain_unlimited: bool,
) -> Vec<EvidencePassage> {
    let mut recs: Vec<(String, usize)> = Vec::new(); // (chunk, packetIdx)
    for (pi, packet) in packets.iter().enumerate() {
        for p in &packet.passages {
            for c in chunk_markdown(&p.passage_text, 2000, 300) {
                // Pure-junk short chunks never enter the pool.
                if junk_penalty(&c.text) >= 0.8 && utf16_len(&c.text) < 800 {
                    continue;
                }
                recs.push((c.text, pi));
            }
        }
    }
    if recs.is_empty() {
        return packets.iter().flat_map(|p| p.passages.clone()).take(top_n).collect();
    }

    let idx = build_bm25(recs.iter().map(|(c, _)| c.clone()).collect());

    // Combined query: user prompt + all gate queries (empties filtered).
    let q_text = std::iter::once(user_prompt)
        .chain(gate_queries.iter().map(String::as_str))
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");

    let raw_hits = bm25_score(&idx, &q_text, top_n * 3);

    // Junk penalty multiplier, then re-sort (stable ties keep raw order).
    let mut hits: Vec<(usize, f64)> = raw_hits
        .into_iter()
        .map(|(rec_idx, raw)| match recs.get(rec_idx) {
            Some((chunk, _)) => {
                let penalty = junk_penalty(chunk);
                (rec_idx, raw * (1.0 - 0.8 * penalty))
            }
            None => (rec_idx, raw),
        })
        .filter(|(_, s)| *s > 0.0)
        .collect();
    hits.sort_by(|a, b| b.1.total_cmp(&a.1));

    if hits.is_empty() {
        return packets.iter().flat_map(|p| p.passages.clone()).take(top_n).collect();
    }

    // Per-domain cap: 6; unlimited when single_domain_unlimited.
    let mut domain_count: HashMap<String, usize> = HashMap::new();
    let mut out: Vec<EvidencePassage> = Vec::new();
    let mut top_hit_idxs: Vec<usize> = Vec::new();

    for (rec_idx, score) in hits {
        if out.len() >= top_n {
            break;
        }
        let (chunk, pi) = match recs.get(rec_idx) {
            Some(r) => r,
            None => continue,
        };
        let packet = &packets[*pi];
        if !single_domain_unlimited {
            let dc = domain_count.entry(packet.domain.clone()).or_insert(0);
            if *dc >= 6 {
                continue;
            }
            *dc += 1;
        }
        top_hit_idxs.push(rec_idx);
        out.push(EvidencePassage {
            source_id: packet.source_id.clone(),
            url: packet.url.clone(),
            title: packet.title.clone(),
            domain: packet.domain.clone(),
            published_at: packet.published_at.clone(),
            passage_text: chunk.clone(),
            bm25_score: (score * 1000.0).round() / 1000.0,
        });
    }

    // Neighbor expansion: adjacent chunk in the SAME document for setup/
    // conclusion context.
    if !single_domain_unlimited && out.len() < 35 {
        let seen_keys: HashSet<String> = out
            .iter()
            .map(|o| {
                format!(
                    "{}|{}",
                    o.source_id,
                    utf16_prefix(&o.passage_text, 80)
                )
            })
            .collect();
        let mut seen = seen_keys;
        let mut added = 0usize;
        for &rec_idx in &top_hit_idxs {
            if added >= 5 {
                break;
            }
            let pi = match recs.get(rec_idx) {
                Some(r) => r.1,
                None => continue,
            };
            for n_idx in [rec_idx.wrapping_sub(1), rec_idx + 1] {
                // ⇔ TS `if (nIdx < 0 || nIdx >= recs.length) continue;`
                if n_idx >= recs.len() {
                    continue;
                }
                let (n_chunk, n_pi) = &recs[n_idx];
                if packets[*n_pi].source_id != packets[pi].source_id {
                    continue;
                }
                let key = format!(
                    "{}|{}",
                    packets[*n_pi].source_id,
                    utf16_prefix(n_chunk, 80)
                );
                if seen.contains(&key) {
                    continue;
                }
                if utf16_len(n_chunk) < 150 {
                    continue;
                }
                let np = &packets[*n_pi];
                out.push(EvidencePassage {
                    source_id: np.source_id.clone(),
                    url: np.url.clone(),
                    title: np.title.clone(),
                    domain: np.domain.clone(),
                    published_at: np.published_at.clone(),
                    passage_text: format!("[Context] {n_chunk}"),
                    bm25_score: 0.0,
                });
                seen.insert(key);
                added += 1;
                if out.len() >= 35 {
                    break;
                }
            }
        }
    }

    out.truncate(top_n.max(35));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ExtractionKind;

    fn packet(id: &str, domain: &str, texts: &[&str]) -> EvidencePacket {
        EvidencePacket {
            source_id: id.into(),
            url: format!("https://{domain}/page"),
            title: format!("{id} title"),
            domain: domain.into(),
            published_at: None,
            extraction: ExtractionKind::SnippetOnly,
            passages: texts
                .iter()
                .map(|t| EvidencePassage {
                    source_id: id.into(),
                    url: format!("https://{domain}/page"),
                    title: format!("{id} title"),
                    domain: domain.into(),
                    published_at: None,
                    passage_text: t.to_string(),
                    bm25_score: 1.0,
                })
                .collect(),
            classification: None,
        }
    }

    #[test]
    fn tokenize_stops_and_apostrophe_quirk() {
        assert_eq!(
            tokenize("What is the fastest Rust web framework?"),
            ["fastest", "rust", "web", "framework"]
        );
        // "don't" splits to "don" + "t" — "dont" is the stopword, "don" is
        // NOT (TS list quirk), kept verbatim.
        assert_eq!(tokenize("don't panic"), ["don", "panic"]);
        assert!(tokenize("a an i the").is_empty());
    }

    #[test]
    fn junk_penalty_matrix() {
        assert_eq!(junk_penalty("real research content about pipelines"), 0.0);
        assert_eq!(junk_penalty("read our privacy policy here"), 0.5);
        assert_eq!(
            junk_penalty("We use cookies. All rights reserved. (c) 2024"),
            1.0
        );
    }

    #[test]
    fn chunk_markdown_protects_code_fence_atomic() {
        let code = "fn main() {\n    let answer = compute_the_meaning();\n    println!(\"{answer}\");\n}";
        let md = format!("tiny\n\n```\n{code}\n```\n\ntoo short to keep");
        let chunks = chunk_markdown(md.as_str(), 2000, 300);
        assert_eq!(chunks.len(), 1, "fence must be its own chunk");
        assert!(chunks[0].text.starts_with("```") && chunks[0].text.ends_with("```"));
    }

    #[test]
    fn chunk_markdown_structured_facts_boundary() {
        let md = "[Structured Page Facts]\nprice: $42 with the extended warranty plan included\ntitle: Example widget with a long enough name here\n\n# Next Section Heading\nmore prose follows here that is long enough to be kept.";
        let chunks = chunk_markdown(md, 2000, 300);
        assert!(chunks[0].text.starts_with("[Structured Page Facts]"));
        assert!(chunks[0].text.contains("warranty"));
        assert!(!chunks[0].text.contains("Next Section"));
        assert!(chunks.iter().skip(1).any(|c| c.text.contains("Next Section")));
    }

    #[test]
    fn chunk_markdown_hard_slices_long_paragraph() {
        let p = "a".repeat(4500);
        let chunks = chunk_markdown(&p, 2000, 300);
        // i = 0, 1700, 3400 (5100 ≥ 4500 stops): 2000 + 2000 + 1100.
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks.iter().map(|c| c.text.len()).collect::<Vec<_>>(), [2000, 2000, 1100]);
        assert_eq!(chunks[1].start_index, 1700);
    }

    #[test]
    fn chunk_markdown_overlap_carry_bug_is_preserved() {
        // TS reads `buf.slice(-overlap)` AFTER `flush` cleared `buf` ⇒ the
        // overlap never carries; the emitted second chunk equals p2 exactly.
        let p1 = "b".repeat(1200);
        let p2 = "c".repeat(1200);
        let chunks = chunk_markdown(&format!("{p1}\n\n{p2}"), 2000, 300);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[1].text, p2, "no overlap tail may appear (ported bug)");
    }

    #[test]
    fn bm25_orders_and_truncates() {
        let idx = build_bm25(vec![
            "rust web framework benchmarks".into(),
            "python web framework tutorial".into(),
            "rust only".into(),
        ]);
        let hits = bm25_score(&idx, "rust framework", 10);
        assert_eq!(hits[0].0, 0, "doc with both terms must rank first");
        assert!(hits.iter().all(|(_, s)| *s > 0.0));
        assert_eq!(bm25_score(&idx, "nonexistent zzz", 10).len(), 0);
        assert_eq!(bm25_score(&idx, "rust", 1).len(), 1);
    }

    #[test]
    fn rerank_caps_domains_and_expands_neighbors() {
        let hit_text = |n: &str| format!("quantum computing {n} {}", "filler word ".repeat(30));
        let ctx_text = "|".repeat(200); // adjacent, ≥150 chars, no query match
        let owned: Vec<String> = (0..8)
            .flat_map(|i| vec![hit_text(&i.to_string()), ctx_text.clone()])
            .collect();
        let texts: Vec<&str> = owned.iter().map(String::as_str).collect();
        let pkts = [packet("s1", "a.com", &texts)];
        let gq = vec!["quantum computing".to_string()];

        let capped = rerank(&pkts, "quantum computing", &gq, 30, false);
        let real = capped
            .iter()
            .filter(|p| !p.passage_text.starts_with("[Context] "))
            .count();
        assert!(real <= 6, "per-domain cap must hold: {real}");
        assert!(
            capped.iter().any(|p| p.passage_text.starts_with("[Context] ")),
            "neighbor expansion must fire"
        );
        for p in capped.iter().filter(|p| !p.passage_text.starts_with("[Context] ")) {
            assert_eq!(p.bm25_score, (p.bm25_score * 1000.0).round() / 1000.0);
        }

        let free = rerank(&pkts, "quantum computing", &gq, 30, true);
        assert_eq!(
            free.iter()
                .filter(|p| !p.passage_text.starts_with("[Context] "))
                .count(),
            8,
            "single-domain-unlimited lifts the cap"
        );
        assert!(
            free.iter()
                .all(|p| !p.passage_text.starts_with("[Context] ")),
            "expansion is skipped when unlimited"
        );
    }

    #[test]
    fn rerank_empty_pool_falls_back_to_raw_passages() {
        let tiny = "tiny".repeat(3); // <40 ⇒ no chunks
        let pkts = [packet("s1", "a.com", &[tiny.as_str()])];
        let out = rerank(&pkts, "anything", &[], 30, false);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].passage_text, "tinytinytiny");
    }
}
