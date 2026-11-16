//! Mirror of `lib/server/attachindex/vectors.ts` - F09b.
//!
//! Decide, from what an index ACTUALLY stores, whether its dense vectors may
//! be scored at all. A cosine product between two different-length vectors is
//! not a weaker score, it is a meaningless one, and a mixed-length index
//! silently produces one partial product per chunk. So the index declares its
//! own quality mode:
//!   "hybrid"        - one consistent dimension, usable for ranking
//!   "lexical_only"  - no usable dense channel, with the reason for honest
//!                     coverage reporting (F14)
//!
//! Provenance (model/revision/fingerprint/dim) is trusted only when the index
//! stamped it; an unstamped legacy index is judged from its stored shapes.

use crate::types::{IndexChunk, IndexMeta};

pub const MODE_HYBRID: &str = "hybrid";
pub const MODE_LEXICAL_ONLY: &str = "lexical_only";

#[derive(Debug, Clone)]
pub struct VectorAssessment {
    pub mode: String,
    pub reason: Option<String>,
    pub count: usize,
    pub dim: Option<usize>,
    pub declared_dim: Option<usize>,
    pub model: Option<String>,
    pub fingerprint: Option<String>,
}

/// `assessVectors(meta, chunks)` - never trusts a `vectors` blob from disk.
pub fn assess_vectors(meta: &IndexMeta, chunks: &[IndexChunk]) -> VectorAssessment {
    // dim -> number of chunks storing that length (insertion-ordered count map
    // == JS Map; order only matters for the "most common" pick, which ties
    // break by first-seen in both languages because JS Map preserves insertion
    // order and a stable sort by count keeps the first maximum).
    let mut dims: Vec<(usize, usize)> = Vec::new();
    let mut with_vec = 0usize;
    for c in chunks {
        if !c.vec.is_empty() {
            with_vec += 1;
            match dims.iter_mut().find(|(d, _)| *d == c.vec.len()) {
                Some(e) => e.1 += 1,
                None => dims.push((c.vec.len(), 1)),
            }
        }
    }
    let declared = meta.embed.as_ref().and_then(|e| e.dim).map(|d| d as usize);
    let mut by_count = dims.clone();
    by_count.sort_by(|a, b| b.1.cmp(&a.1)); // stable == JS sort
    let observed = by_count.first().map(|(d, _)| *d);
    let ragged = dims.len() > 1;
    let mismatched = match declared {
        Some(d) => {
            let at_declared = dims.iter().find(|(x, _)| *x == d).map(|(_, n)| *n).unwrap_or(0);
            at_declared != with_vec
        }
        None => false,
    };

    let (mode, reason) = if with_vec == 0 {
        (MODE_LEXICAL_ONLY, Some("no vectors stored".to_string()))
    } else if ragged {
        let mut keys: Vec<usize> = dims.iter().map(|(d, _)| *d).collect();
        keys.sort_unstable();
        (
            MODE_LEXICAL_ONLY,
            Some(format!(
                "ragged vector dimensions ({})",
                keys
                    .iter()
                    .map(|k| k.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
        )
    } else if mismatched {
        (
            MODE_LEXICAL_ONLY,
            Some(format!(
                "stored dimension != declared dimension {}",
                declared.unwrap_or(0)
            )),
        )
    } else {
        (MODE_HYBRID, None)
    };

    VectorAssessment {
        mode: mode.to_string(),
        reason,
        count: with_vec,
        dim: declared.or(observed),
        declared_dim: declared,
        model: meta.embed.as_ref().and_then(|e| e.model.clone()),
        fingerprint: meta.embed.as_ref().and_then(|e| e.fingerprint.clone()),
    }
}

/// `comparableWith` - may a query embedding be compared with this index at all?
pub fn comparable_with(assessment: &VectorAssessment, query_vec: &[f64]) -> bool {
    assessment.mode == MODE_HYBRID
        && !query_vec.is_empty()
        && query_vec.iter().all(|v| v.is_finite())
        && assessment.dim.map_or(true, |d| d == query_vec.len())
}

/// The mode-forced comparison the retrieval path uses (`{ ...assess, mode:
/// "hybrid" }` in TS): the caller has already decided whether the STORED side
/// is usable, so only the query side and the dimension are checked here.
pub fn query_dimension_ok(assessment: &VectorAssessment, query_vec: &[f64]) -> bool {
    !query_vec.is_empty()
        && query_vec.iter().all(|v| v.is_finite())
        && assessment.dim.map_or(true, |d| d == query_vec.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::EmbedStamp;

    fn chunk(i: i64, vec: Vec<f64>) -> IndexChunk {
        IndexChunk {
            i,
            start_sec: None,
            end_sec: None,
            text: "t".to_string(),
            vec,
        }
    }
    fn stamped(dim: i64) -> IndexMeta {
        IndexMeta {
            embed: Some(EmbedStamp {
                model: Some("m".to_string()),
                revision: Some("r".to_string()),
                dim: Some(dim),
                normalized: Some(true),
                fingerprint: Some("fp".to_string()),
            }),
            ..Default::default()
        }
    }

    #[test]
    fn no_vectors_is_lexical_only_with_a_reason() {
        let a = assess_vectors(&IndexMeta::default(), &[chunk(0, vec![]), chunk(1, vec![])]);
        assert_eq!(a.mode, MODE_LEXICAL_ONLY);
        assert_eq!(a.reason.as_deref(), Some("no vectors stored"));
        assert!(!comparable_with(&a, &[1.0, 0.0]));
    }

    #[test]
    fn ragged_dimensions_are_never_scored() {
        let a = assess_vectors(
            &IndexMeta::default(),
            &[chunk(0, vec![1.0, 0.0]), chunk(1, vec![0.0, 1.0, 0.0])],
        );
        assert_eq!(a.mode, MODE_LEXICAL_ONLY);
        assert_eq!(a.reason.as_deref(), Some("ragged vector dimensions (2, 3)"));
    }

    #[test]
    fn stamped_dimension_mismatch_is_refused() {
        let a = assess_vectors(&stamped(3), &[chunk(0, vec![1.0, 0.0])]);
        assert_eq!(a.mode, MODE_LEXICAL_ONLY);
        assert_eq!(
            a.reason.as_deref(),
            Some("stored dimension != declared dimension 3")
        );
    }

    #[test]
    fn consistent_dimension_is_hybrid_and_comparable() {
        let a = assess_vectors(&stamped(2), &[chunk(0, vec![1.0, 0.0]), chunk(1, vec![0.0, 1.0])]);
        assert_eq!(a.mode, MODE_HYBRID);
        assert!(a.reason.is_none());
        assert_eq!(a.dim, Some(2));
        assert!(comparable_with(&a, &[0.6, 0.8]));
        // a different-dimension query is refused, not partially scored
        assert!(!comparable_with(&a, &[1.0, 0.0, 0.0]));
        // a non-finite query vector cannot produce a usable score either
        assert!(!comparable_with(&a, &[f64::NAN, 0.0]));
    }
}
