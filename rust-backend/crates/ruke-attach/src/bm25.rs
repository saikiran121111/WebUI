//! `lib/server/attachindex/bm25.ts` — Okapi BM25, ported expression-for-
//! expression (the brief forbids substituting a "better" variant). JS
//! doubles and Rust f64 are both IEEE-754 binary64; every arithmetic
//! expression below keeps the TS operation ORDER, so scores are
//! bit-identical and ranking can never drift.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use regex::Regex;

/// `tokenize`: lowercase word tokens — letters/digits with optional
/// ASCII-lowercase apostrophe suffixes, Unicode-aware (`/[\p{L}\p{N}]+(?:'[a-z]+)*/gu`).
pub fn tokenize(t: &str) -> Vec<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"[\p{L}\p{N}]+(?:'[a-z]+)*").expect("static regex"));
    // JS lowercases the WHOLE string first, so the apostrophe suffix can
    // only match ASCII lowercase after folding — mirror that order.
    re.find_iter(&t.to_lowercase())
        .map(|m| m.as_str().to_string())
        .collect()
}

/// `bm25Scores(query, docs)` — docs arrive pre-tokenized; scores are
/// positional (index i = docs[i]), exactly like the TS return array.
pub fn bm25_scores(query: &str, docs: &[Vec<String>]) -> Vec<f64> {
    const K1: f64 = 1.5;
    const B: f64 = 0.75;

    let n_docs = docs.len();
    if n_docs == 0 {
        return Vec::new();
    }

    let dl: Vec<usize> = docs.iter().map(|d| d.len()).collect();
    let sum: usize = dl.iter().sum();
    // `avgdl = dl.reduce(...) / N || 1` — only 0 (empty corpus docs) is falsy.
    let mut avgdl = sum as f64 / n_docs as f64;
    if avgdl == 0.0 {
        avgdl = 1.0;
    }

    let mut df: HashMap<&str, u64> = HashMap::new();
    for d in docs {
        for t in HashSet::<&str>::from_iter(d.iter().map(String::as_str)) {
            *df.entry(t).or_insert(0) += 1;
        }
    }

    // `[...new Set(tokenize(query))]` — first-occurrence order.
    let mut seen: HashSet<String> = HashSet::new();
    let terms: Vec<String> = tokenize(query)
        .into_iter()
        .filter(|t| seen.insert(t.clone()))
        .collect();

    let n = n_docs as f64;
    docs.iter()
        .enumerate()
        .map(|(i, d)| {
            let mut tf: HashMap<&str, u64> = HashMap::new();
            for t in d {
                *tf.entry(t.as_str()).or_insert(0) += 1;
            }
            let mut score = 0.0f64;
            for term in &terms {
                let f = tf.get(term.as_str()).copied().unwrap_or(0);
                let dn = df.get(term.as_str()).copied().unwrap_or(0);
                // `if (!f || !n) continue;` — counts, never NaN.
                if f == 0 || dn == 0 {
                    continue;
                }
                let (f, dn) = (f as f64, dn as f64);
                let idf = (1.0 + (n - dn + 0.5) / (dn + 0.5)).ln();
                score += (idf * f * (K1 + 1.0)) / (f + K1 * (1.0 - B + (B * dl[i] as f64) / avgdl));
            }
            score
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenize_word_table() {
        assert_eq!(tokenize("Photosynthesis converts light."), ["photosynthesis", "converts", "light"]);
        // Apostrophe suffixes ATTACH (the `(?:'[a-z]+)*` group is part of
        // the same match): "don't" is ONE token, not "don" + "t".
        assert_eq!(tokenize("don't O'Brien"), ["don't", "o'brien"]);
        assert_eq!(tokenize("rock'n'roll"), ["rock'n'roll"]);
        // Lowercasing runs on the WHOLE string first, so "DON'T" folds to
        // "don't" and the suffix attaches there too (JS `u`-flag parity).
        assert_eq!(tokenize("DON'T"), ["don't"]);
        // Unicode letters/digits are word chars (u flag parity).
        assert_eq!(tokenize("café 42 π2"), ["café", "42", "π2"]);
        assert_eq!(tokenize("...!?"), Vec::<String>::new());
        assert_eq!(tokenize(""), Vec::<String>::new());
    }

    #[test]
    fn bm25_empty_corpus_and_zero_avgdl_guard() {
        assert!(bm25_scores("a", &[]).is_empty());
        // avgdl 0 ⇒ `|| 1`; query term not present ⇒ 0.
        let s = bm25_scores("a", &[vec![]]);
        assert_eq!(s, vec![0.0]);
    }

    #[test]
    fn bm25_hand_computed_single_term() {
        // docs ["a b","b c"], query "a": N=2 avgdl=2; doc0 f=1 n=1:
        // idf = ln(1+(2-1+0.5)/(1+0.5)) = ln 2; denom = 1+1.5*(0.25+0.75) = 2.5;
        // score = ln2 * 1 * 2.5 / 2.5 = ln 2. doc1 has no "a" ⇒ 0.
        let s = bm25_scores("a", &[vec!["a".into(), "b".into()], vec!["b".into(), "c".into()]]);
        assert_eq!(s.len(), 2);
        assert!((s[0] - std::f64::consts::LN_2).abs() < 1e-12, "{:?}", s);
        assert_eq!(s[1], 0.0);
    }

    #[test]
    fn bm25_query_term_dedup_counts_once() {
        // Repeated query term adds nothing extra (Set), and multi-doc df
        // lowers idf: docs ["a a", "a"].
        let s = bm25_scores("a a a", &[vec!["a".into(), "a".into()], vec!["a".into()]]);
        // N=2 df(a)=2 ⇒ idf = ln(1+(2-2+0.5)/(2.5)) = ln(1.2).
        // doc0: f=2 dl=2 avgdl=1.5: denom = 2+1.5*(0.25+0.75*2/1.5) =
        // 2+1.875 = 3.875 ⇒ ln1.2 * 2*2.5/3.875 = ln1.2 * 5/3.875.
        let expect = (1.2f64).ln() * 5.0 / 3.875;
        assert!((s[0] - expect).abs() < 1e-12, "{:?}", s);
        // doc1: f=1 dl=1: denom = 1+1.5*(0.25+0.75/1.5) = 2.125 ⇒
        // ln1.2 * 2.5/2.125 (the Set only dedups the QUERY terms).
        let expect1 = (1.2f64).ln() * 2.5 / 2.125;
        assert!((s[1] - expect1).abs() < 1e-12, "{:?}", s);
    }
}
