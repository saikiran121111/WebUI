//! `lib/skills/modality.ts` — the index-time modality filter. Every pattern
//! is reproduced VERBATIM (`test()` = unanchored search, `/i`, identical
//! character classes). Decision order is the function contract:
//! any strong pattern → blocked; else code-viz allow-list → allowed;
//! else any weak pattern → blocked; else allowed.
//!
//! RECORDED MICRO-DIVERGENCE: Rust `\b` uses Unicode word semantics while
//! JS `\b` uses ASCII `\w`. They differ only for a pattern boundary adjacent
//! to a non-ASCII letter (e.g. "imagenα" matches the JS `\bimagen\b` but not
//! the Rust one). SKILL.md bodies in this repo are ASCII at every observed
//! pattern site; the deviation is boundary-only, never a missed ASCII hit.

use std::sync::LazyLock;

use regex::Regex;

/// `BLOCKED_REASON` from `lib/skills/types.ts` (exact string).
pub const BLOCKED_REASON: &str = "Unsupported media generation skill";

/// Unambiguous external-generation signals: block regardless of anything else.
static STRONG: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?i)d[\s-]*all[\s-]*e\b",
        r"(?i)\bmidjourney\b",
        r"(?i)\bstable diffusion\b",
        r"(?i)\bcomfy[\s-]?ui\b",
        r"(?i)\bsora(?:\s?[\d2])?\b",
        r"(?i)\brunway(?:\s?ml\d?)?\b",
        r"(?i)\badobe firefly\b",
        r"(?i)\bfirefly\b",
        r"(?i)\bgoogle imagen\b",
        r"(?i)\bimagen\b",
        r"(?i)\bleonardo(?:\.ai| labs)?\b",
        r"(?i)\bseedream\b",
        r"(?i)\bkling(?:\s?ai)?\b",
        r"(?i)\bveo\s?[\d23]\b",
        r"(?i)\bpika(?:\s?labs)?\b",
        r"(?i)\bflux(?:\.1)?[\s-](?:dev|schnell|pro|kontext)\b",
        r"(?i)\btext[\s-]*to[\s-]*(?:image|video|animation)\b",
        r"(?i)\bimage generation (?:api|model|service|tool|endpoint|provider)\b",
        r"(?i)\bvideo generation (?:api|model|service|tool|endpoint|provider)\b",
    ]
    .iter()
    .map(|p| Regex::new(p).unwrap())
    .collect()
});

/// Ambiguous signals: only block when the skill is NOT code-driven visuals.
static WEAK: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?i)\bimage generation\b",
        r"(?i)\bvideo generation\b",
        r"(?i)\b(?:generate|generating|generates) (?:ai[\s-])?(?:an? )?(?:images?|videos?|clips?|pictures?|footage|thumbnails?)\b",
    ]
    .iter()
    .map(|p| Regex::new(p).unwrap())
    .collect()
});

/// Code-driven visual skills stay allowed.
static CODE_VIZ_ALLOW: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\bthree(?:\.?js)?\b|\bwebgl\b|\bwebgpu\b|\bglsl\b|\bshaders?\b|\bcanvas\b|\bsvgs?\b|\bd3(?:\.?js)?\b|\bprocedural\b|\bisometric\b|\bdiagrams?\b|\bcharts?\b",
    )
    .unwrap()
});

/// `detectBlockedReason`: `Some(BLOCKED_REASON)` ⇔ TS constant, `None` ⇔ null.
pub fn detect_blocked_reason(skill_markdown: &str) -> Option<&'static str> {
    if STRONG.iter().any(|p| p.is_match(skill_markdown)) {
        return Some(BLOCKED_REASON);
    }
    if CODE_VIZ_ALLOW.is_match(skill_markdown) {
        return None;
    }
    if WEAK.iter().any(|p| p.is_match(skill_markdown)) {
        return Some(BLOCKED_REASON);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strong_patterns_block_regardless_of_code_viz() {
        // Strong beats the Three.js allow-list (order = contract).
        assert_eq!(
            detect_blocked_reason("a three.js skill that also mentions Midjourney"),
            Some(BLOCKED_REASON)
        );
        assert_eq!(detect_blocked_reason("Use d-all-e for art"), Some(BLOCKED_REASON));
        assert_eq!(detect_blocked_reason("Stable Diffusion here"), Some(BLOCKED_REASON));
        assert_eq!(detect_blocked_reason("ComfyUI workflow"), Some(BLOCKED_REASON));
        assert_eq!(detect_blocked_reason("sora2 clips"), Some(BLOCKED_REASON));
        assert_eq!(detect_blocked_reason("runway ml gen"), Some(BLOCKED_REASON));
        assert_eq!(detect_blocked_reason("Veo 3 prompt"), Some(BLOCKED_REASON));
        assert_eq!(detect_blocked_reason("flux.1-dev model"), Some(BLOCKED_REASON));
        assert_eq!(detect_blocked_reason("text-to-image pipeline"), Some(BLOCKED_REASON));
        assert_eq!(detect_blocked_reason("imagen 3"), Some(BLOCKED_REASON));
        // "firefly" alone blocks; word-boundary keeps "Firefly Lighting Co" out.
        assert_eq!(detect_blocked_reason("use Firefly"), Some(BLOCKED_REASON));
        assert_eq!(
            detect_blocked_reason("image generation endpoint docs"),
            Some(BLOCKED_REASON)
        );
    }

    #[test]
    fn weak_signals_block_only_without_code_viz_allow() {
        assert_eq!(detect_blocked_reason("Image generation notes"), Some(BLOCKED_REASON));
        assert_eq!(
            detect_blocked_reason("generate AI images with a script"),
            Some(BLOCKED_REASON)
        );
        assert_eq!(
            detect_blocked_reason("renders charts and generates images with canvas"),
            None,
            "code-viz allow-list must outrank weak signals"
        );
        assert_eq!(
            detect_blocked_reason("three.js isometric anatomy diagrams"),
            None
        );
    }

    #[test]
    fn clean_text_passes() {
        assert_eq!(detect_blocked_reason("# Clean Skill\nPlain body only."), None);
        // Word-boundary sanity: substrings must not fire.
        assert_eq!(detect_blocked_reason("fireflies in the garden"), None);
        assert_eq!(detect_blocked_reason("imaginary friends"), None);
    }
}
