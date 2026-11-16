//! `lib/skills/modality.ts` - the index-time modality filter (F20 law, 2026-11-15).
//!
//! Every pattern below is a 1:1 port of the TS constant list with the same
//! names, so the two engines decide identically. The previous version of this
//! file blocked on a BARE BRAND MENTION, which reproduced two false blocks
//! ("why not use Midjourney for a CSV guide", "a text guide to Leonardo da
//! Vinci"). A name is not a capability requirement; the law is evidence-shaped:
//!
//!   A. DECLARED (authoritative, application-owned scenario metadata):
//!      `requiredCapabilities` in the scenario object.
//!   B. PROTOCOL evidence anywhere in the body (endpoint paths a media
//!      generation API owns, provider key variables, HTTP client calls to such
//!      paths, or an explicit "requires: image-generation" line).
//!   C. NAME + INSTRUCTION evidence per frame: an unambiguous provider form
//!      (ambiguous words such as firefly/imagen/leonardo/sora/pika/kling/veo/
//!      runway/flux need a service affix in the same frame) together with an
//!      operation or dependency frame.
//!   D. CAPABILITY phrasing with no vendor ("text-to-image", "generate images")
//!      unless that same frame draws with code (Canvas/SVG/Three.js/matplotlib).
//!   A frame carrying a negation/comparison/explanation is DISCUSSION and never
//!      blocks on name evidence; the frame splitter is the reach test, so a
//!      negation cannot cross a sentence boundary.
//!
//! Micro-divergence, recorded: Rust `\b` is Unicode-aware while JS `\b` is
//! ASCII `\w`; they differ only at a boundary adjacent to a non-ASCII letter.
//! The safe direction of ambiguity is ALLOW (a false block silently deletes a
//! working skill; a missed block yields a typed runtime failure).

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

/// `BLOCKED_REASON` from `lib/skills/types.ts` (exact string).
pub const BLOCKED_REASON: &str = "Unsupported media generation skill";

/// `MEDIA_GENERATION_CAPABILITIES`.
pub const MEDIA_GENERATION_CAPABILITIES: [&str; 2] = ["image-generation", "video-generation"];

/// `availableMediaCapabilities()`: this install runs no media generation.
pub fn available_media_capabilities() -> Vec<&'static str> {
    Vec::new()
}

static CAPABILITY_WS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\s_]+").unwrap());
static CAPABILITY_DASH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"-{2,}").unwrap());
static IMAGE_DECL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(image|picture|illustration|photo|art)-(generation|generator|api)$").unwrap()
});
static VIDEO_DECL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(video|clip|footage|animation)-(generation|generator|api)$").unwrap()
});

/// `canonicalCapability`: "Image Generation" / "image_generator" / "image-api"
/// all normalize to a known capability id, else None.
fn canonical_capability(value: &str) -> Option<&'static str> {
    let c = CAPABILITY_DASH
        .replace_all(&CAPABILITY_WS.replace_all(&value.to_lowercase(), "-"), "-")
        .to_string();
    if IMAGE_DECL.is_match(&c) {
        Some("image-generation")
    } else if VIDEO_DECL.is_match(&c) {
        Some("video-generation")
    } else {
        None
    }
}

/// (A) `declaredCapabilities(meta)`: requirements stated by application-owned
/// scenario metadata. Anything that is not an array contributes nothing.
pub fn declared_capabilities(meta: Option<&Value>) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    let raw = match meta.and_then(|m| m.get("requiredCapabilities")) {
        Some(Value::Array(items)) => items,
        _ => return out,
    };
    for entry in raw {
        let text = match entry {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            Value::Bool(b) => b.to_string(),
            Value::Null => "null".to_string(),
            other => other.to_string(),
        };
        if let Some(c) = canonical_capability(&text) {
            if !out.contains(&c) {
                out.push(c);
            }
        }
    }
    out
}

macro_rules! rlist {
    ($($pat:expr),* $(,)?) => {{
        LazyLock::new(|| vec![$(Regex::new($pat).unwrap()),*])
    }};
}

/// (C-i) Brand forms that can ONLY name a media-generation service.
static PROVIDER_FORM: LazyLock<Vec<Regex>> = rlist![
    r"(?i)d[\s-]*all[\s-]*e\b",
    r"(?i)\bmidjourney\b",
    r"(?i)\bstable[\s-]*diffusion\b",
    r"(?i)\bdiffusion[\s-]*xl\b",
    r"(?i)\bcomfy[\s-]?ui\b",
    r"(?i)\badobe[\s-]*firefly\b",
    r"(?i)\brunway[\s-]*(?:ml|app|gen[23]?|[23])\b",
    r"(?i)\bgoogle[\s-]*imagen\b",
    r"(?i)\bleonardo\.ai\b",
    r"(?i)\bleonardo[\s-]*labs\b",
    r"(?i)\bseedream\b",
    r"(?i)\brecraft\b",
    r"(?i)\bideogram\b",
    r"(?i)\bparti[\s-]*designs?\b",
    r"(?i)\bflux[\s.-][12][\s-]*(?:dev|schnell|pro|kontext|flex|strong|fill|depth|redux)\b",
    r"(?i)\bsora[\s-]*(?:[23]|two|turbo|sampler)\b",
    r"(?i)\bveo[\s-]*[23]\b",
    r"(?i)\bpika[\s-]*(?:labs|schema|1|2)\b",
    r"(?i)\bkling[\s-]*(?:ai|[\d@][.\d]*)\b",
];

/// Ambiguous words: only a service/protocol affix in the same frame identifies a service.
static AMBIGUOUS_WORD: LazyLock<Vec<Regex>> = rlist![
    r"(?i)\bfirefly\b",
    r"(?i)\bimagen\b",
    r"(?i)\bleonardo\b",
    r"(?i)\bsora\b",
    r"(?i)\bpika\b",
    r"(?i)\bkling\b",
    r"(?i)\bveo\b",
    r"(?i)\brunway\b",
    r"(?i)\bflux\b",
    r"(?i)\bseedream\b",
    r"(?i)\bdiffusion\b",
];
static SERVICE_QUALIFIER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(?:api|apis|endpoint|endpoints|service|services|model|models|sdk|cli|tool|tools|provider|providers|engine|host|url|uri|key|keys|token|secret|hosted|cloud|server|workflow|workflows|pipeline|pipelines|prompt|prompts|imagine|upscale|img2img|txt2img|outpaint|inpaint|denoise|sampler|checkpoint|lora|discord|webhook|dashboard|website|account|subscription|credits)\b",
    )
    .unwrap()
});

/// (D) Capability phrasing naming the capability itself, without a vendor.
static CAPABILITY_STRONG: LazyLock<Vec<Regex>> = rlist![
    r"(?i)\btext[\s-]*to[\s-]*(?:image|images|video|videos|animation)\b",
    r"(?i)\bimage[\s-]*to[\s-]*(?:video|videos|animation)\b",
    r"(?i)\b(?:image|video|picture|illustration|photo)[\s-]*generation[\s-]*(?:api|apis|model|models|service|services|tool|tools|endpoint|endpoints|provider|providers|engine|backend|worker|key)\b",
];
static CAPABILITY_WEAK: LazyLock<Vec<Regex>> = rlist![
    r"(?i)\b(?:image|video)[\s-]*generation\b",
    r"(?i)\b(?:generate|generates|generating|create|creates|creating|produce|produces|producing|render|renders|draw|draws)\s+(?:ai[\s-])?(?:an?\s+|the\s+)?(?:images?|videos?|clips?|footage|thumbnails?|illustrations?|banners?|logos?|hero)\b",
];

/// (B) Whole-document protocol evidence: what a real integration writes.
static PROTOCOL_EVIDENCE: LazyLock<Vec<Regex>> = rlist![
    r#"(?i)https?://[^\s)"\x27<>]*(?:images?/generations|videos?/generations|text-to-image|text-to-video|img2img|txt2img|dream/submit|imagine/submit|generate\?)"#,
    r"(?i)\b(?:post|put)\s+[^\n]{0,80}(?:images?/generations|videos?/generations|imagine/submit|dream/submit)",
    r"(?i)\b(?:curl|wget|fetch\s*\(|axios\.post|requests\.(?:post|get)|httpx\.post|urllib)[^\n]{0,160}(?:images?/generations|videos?/generations|imagine/submit|dream/submit|/imagine)",
    r"(?i)\b(?:midjourney|stable[_-]?diffusion|stability[_-]?ai|comfyui|leonardo[_-]?ai|runway[_-]?ml|ideogram|replicate|flux|sora)[_-]?(?:api|access)?[_-]?(?:api[_-]?)?(?:key|token|secret|url|base)\b",
    r"(?i)\b(?:image|video)[_-]?(?:generation)?[_-]?(?:api|endpoint)[_-]?(?:key|token|url|base)\b",
    r"(?im)^[-\s*>#]*requires[\s-]*(?:capabilities|capability|media|external)?\s*:[^\n]{0,80}(?:image|video)[-\s]*generation",
    r"(?i)\b(?:requires|needs|depend(?:s|ing)? on)[^\n]{0,60}\b(?:an?\s+)?(?:image|video)[-\s]*generation\b[^\n]{0,30}\b(?:api|service|model|provider|endpoint)\b",
];

/// (C-ii) operation frames - things one does TO/with a generation service.
static OPERATION_FRAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(?:imagine|prompt|prompts|prompting|upscale|upscales|variations?|remix|outpaint|inpaint|img2img|txt2img|denoise|sampler|steps|seed|negative prompt|aspect ratio|--ar\b|workflow|workflows|pipeline|pipelines|sketch|generate|generates|generating|create|creates|creating|render|renders|draw|draws|paint|paints|send|sends|pipe|routes|feeds?|feed|upload|uploads|use|uses|using|run|runs|running|execute|executes|call|calls|invoke|invokes)\b",
    )
    .unwrap()
});
/// (C-ii-b) an explicit dependency statement is also a requirement.
static REQUIRE_FRAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(?:requires?|required|requirement|needs?|depending on|depends? on|depend on|prerequisite|prerequisites|install(?:ling)?|set up|setup of|must use|must have)\b",
    )
    .unwrap()
});
static MEDIA_OBJECT_FRAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(?:images?|videos?|clips?|footage|pictures?|thumbnails?|illustrations?|logos?|posters?|frames?|artwork|photos?|icons?|banners?|hero|mockups?|assets?|scenes?|characters?|backgrounds?|sprites?|animation|portraits?|wallpapers?)\b",
    )
    .unwrap()
});
/// (C-iii) talking ABOUT a service is not a requirement to run it.
static DISCUSSION_FRAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(?:do not|don[\x27]t|dont|does not|doesn[\x27]t|doesnt|did not|didn[\x27]t|didnt|will not|won[\x27]t|cannot|can[\x27]t|cant|could not|couldn[\x27]t|should not|shouldn[\x27]t|would not|wouldn[\x27]t|never|no need|not need|not want|not use|not using|not to use|no use of|avoid(?:s|ing)?|without|refrain|skip(?:s|ping)?|refuse[sd]?|forbid(?:den)?|prohibit(?:ed)?|banned?|against|why not|why never|when not|what not|instead of|rather than|unlike|compared? (?:to|with)|comparison|versus|\bvs\b|alternative(?:s)?|explain(?:s|ing)?|discuss(?:es|ing)?|review(?:s|ing)?|critique|analyse[sd]?|analyze[sd]?|comparing|pros and cons|history|architectur\w*|paper|benchmark(?:s|ing)?|guide to avoiding)\b",
    )
    .unwrap()
});
/// Code-driven visuals are NOT an external generation API.
static CODE_VIZ: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\bthree(?:\.?js)?\b|\bwebgl\b|\bwebgpu\b|\bglsl\b|\bshaders?\b|\bcanvas\b|\bsvgs?\b|\bd3(?:\.?js)?\b|\bprocedural\b|\bisometric\b|\bdiagrams?\b|\bcharts?\b|\bmatplotlib\b|\bplotly\b|\breportlab\b|\bhtml[\s-]canvas\b",
    )
    .unwrap()
});
/// `capabilityFrames` splitter (same character class as the TS regex).
static FRAME_SPLIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[.!?;:\n|()\[\]#]+").unwrap());

/// `capabilityFrames(markdown)`.
pub fn capability_frames(markdown: &str) -> Vec<String> {
    FRAME_SPLIT
        .split(&markdown.replace("\r\n", "\n").replace('\r', "\n"))
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty())
        .collect()
}

static INFER_IMAGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bimage[-\s]*generat|\bimage[_-]generation|\bimages?[/-]generations?\b|\btext[\s-]*to[\s-]*images?\b|\bimg2img\b|\btxt2img\b|\bd[\s-]*all[\s-]*e\b|\bmidjourney\b|midjourney[_-]|\bstable[\s-]*diffusion\b|stable[_-]diffusion|\bdiffusion[\s-]*xl\b|\bcomfy[\s-]?ui\b|\bleonardo\.ai\b|\bideogram\b|\bseedream\b|\brecraft\b|\badobe[\s-]*firefly\b|\bgoogle[\s-]*imagen\b|\bflux[\s.-][12]\b|generate\s+(?:an?\s+)?images?\b")
        .unwrap()
});
static INFER_VIDEO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bvideo[-\s]*generat|\bvideo[_-]generation|\bvideos?[/-]generations?\b|\btext[\s-]*to[\s-]*videos?\b|\bimage[\s-]*to[\s-]*video\b|\bsora[\s-]*(?:[23]|two|turbo)\b|\brunway[\s-]*(?:ml|[23])\b|\bveo[\s-]*[23]\b|\bpika[\s-]*(?:labs|1|2)\b|\bkling[\s-]*(?:ai|[\d@])")
        .unwrap()
});

/// `inferCapabilityFromBody(body)`.
pub fn infer_capability_from_body(body: &str) -> Vec<&'static str> {
    let mut out = Vec::new();
    if INFER_IMAGE.is_match(body) {
        out.push("image-generation");
    }
    if INFER_VIDEO.is_match(body) {
        out.push("video-generation");
    }
    out
}

fn any(pats: &[Regex], text: &str) -> bool {
    pats.iter().any(|p| p.is_match(text))
}

/// `detectBlockedReason(markdown, meta, available)`: `Some(BLOCKED_REASON)`
/// is the TS constant, `None` is null. `meta` is the scenario object.
pub fn detect_blocked_reason(skill_markdown: &str, meta: Option<&Value>) -> Option<&'static str> {
    if skill_markdown.trim().is_empty() {
        return None;
    }
    let available = available_media_capabilities();

    // (A) Declared requirements are authoritative.
    let declared = declared_capabilities(meta);
    if !declared.is_empty() {
        return if declared.iter().any(|c| !available.contains(c)) {
            Some(BLOCKED_REASON)
        } else {
            None
        };
    }

    let wanted = infer_capability_from_body(skill_markdown);
    if !wanted.is_empty() && wanted.iter().all(|c| available.contains(c)) {
        return None;
    }
    let unknown_capability = wanted.is_empty() && !available.is_empty();

    // (B) Hard protocol evidence - prose-independent.
    if any(&PROTOCOL_EVIDENCE, skill_markdown) {
        return if unknown_capability { None } else { Some(BLOCKED_REASON) };
    }
    if unknown_capability {
        return None;
    }

    // (C) Name + instruction evidence, frame by frame.
    let frames = capability_frames(skill_markdown);
    for frame in &frames {
        if DISCUSSION_FRAME.is_match(frame) {
            continue;
        }
        let strong_name = any(&PROVIDER_FORM, frame);
        let ambiguous_name = any(&AMBIGUOUS_WORD, frame);
        if !strong_name && !(ambiguous_name && SERVICE_QUALIFIER.is_match(frame)) {
            continue;
        }
        if (OPERATION_FRAME.is_match(frame) || REQUIRE_FRAME.is_match(frame))
            && (MEDIA_OBJECT_FRAME.is_match(frame)
                || strong_name
                || SERVICE_QUALIFIER.is_match(frame))
        {
            return Some(BLOCKED_REASON);
        }
    }

    // (D) Vendorless capability phrasing, unless that frame draws with code.
    for frame in &frames {
        if DISCUSSION_FRAME.is_match(frame) {
            continue;
        }
        if any(&CAPABILITY_STRONG, frame) {
            return Some(BLOCKED_REASON);
        }
        if !CODE_VIZ.is_match(frame) && any(&CAPABILITY_WEAK, frame) {
            return Some(BLOCKED_REASON);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Shared matrix with `__tests__/skills/modality.test.ts` - every case in
    /// that file appears here, so TS/Rust can never disagree on these inputs.
    #[test]
    fn name_plus_instruction_blocks() {
        for md in [
            "Use DALL-E to draw the logo.",
            "Pipeline: Midjourney prompt then upscale.",
            "Run the ComfyUI workflow for the poster.",
            "Send the clip to Sora for video generation.",
            "This skill requires Midjourney.",
            "Needs ComfyUI.",
            "Do not use Excel. Generate the hero image with Midjourney.",
            "No Excel. Call the image generation endpoint, then upscale.",
            "Render the Three.js scene, then finish the frame with Stable Diffusion img2img.",
            "Call the Sora API to render the clip.",
            "Use DALL-E to generate the hero image.",
            "uses Midjourney for art",
            "now stable diffusion renders the poster",
        ] {
            assert_eq!(detect_blocked_reason(md, None), Some(BLOCKED_REASON), "{md}");
        }
    }

    #[test]
    fn vendorless_capability_phrasing_blocks() {
        for md in [
            "This skill does text-to-image conversion.",
            "Generate images of the product hero.",
            "image generation endpoint docs",
            "Image generation notes",
            "generate AI images with a script",
            "text-to-image pipeline",
        ] {
            assert_eq!(detect_blocked_reason(md, None), Some(BLOCKED_REASON), "{md}");
        }
    }

    #[test]
    fn brand_mention_alone_is_not_a_requirement() {
        for md in [
            "# CSV charting guide\nExplain why you should NOT use Midjourney for tabular data.",
            "A text guide to Leonardo da Vinci and his notebooks.",
            "Do not use DALL-E; draw the logo with SVG paths instead.",
            "Unlike Runway, this skill renders the clip with ffmpeg filters.",
            "We compared Stable Diffusion with our chart engine.",
            "A bare mention: Stable Diffusion here.",
            "sora2 clips",
            "imagen 3",
            "use Firefly",
            "a three.js skill that also mentions Midjourney",
            "A flythrough of the runway at dawn.",
            "Flux capacity in the reactor loop.",
            "fireflies in the garden",
            "imaginary friends",
            "---\nname: humanizer\ndescription: Remove AI writing patterns.\n---\nRewrite the text.",
            "Summarize the document in three bullets.",
            "# Clean Skill\nPlain body only.",
        ] {
            assert_eq!(detect_blocked_reason(md, None), None, "{md}");
        }
    }

    #[test]
    fn code_driven_visual_skills_stay_allowed() {
        for md in [
            "Build a Three.js scene and generate images of the result with canvas screenshots.",
            "Draw the chart with SVG and WebGL shaders.",
            "three.js isometric anatomy diagrams",
            "renders charts and generates images with canvas",
        ] {
            assert_eq!(detect_blocked_reason(md, None), None, "{md}");
        }
    }

    #[test]
    fn protocol_evidence_blocks_regardless_of_prose() {
        for md in [
            "curl https://api.midjourney.com/v1/imagine -d prompt=hi",
            "Set MIDJOURNEY_API_KEY then run the batch.",
            "POST https://api.openai.com/v1/images/generations",
            "---\nname: demo\nrequires: image-generation\n---\nBody.",
        ] {
            assert_eq!(detect_blocked_reason(md, None), Some(BLOCKED_REASON), "{md}");
        }
    }

    #[test]
    fn declared_capabilities_are_authoritative() {
        let md_plain = "Summarize the sheet.";
        assert_eq!(
            detect_blocked_reason(md_plain, Some(&json!({ "requiredCapabilities": ["image-generation"] }))),
            Some(BLOCKED_REASON)
        );
        assert_eq!(
            detect_blocked_reason(md_plain, Some(&json!({ "requiredCapabilities": ["Image Generation"] }))),
            Some(BLOCKED_REASON)
        );
        assert_eq!(
            detect_blocked_reason(md_plain, Some(&json!({ "requiredCapabilities": ["image_generator"] }))),
            Some(BLOCKED_REASON)
        );
        // An unrelated declaration does not erase the body's own evidence.
        assert_eq!(
            detect_blocked_reason("Use DALL-E if you like.", Some(&json!({ "requiredCapabilities": ["web-browsing"] }))),
            Some(BLOCKED_REASON)
        );
        assert_eq!(
            detect_blocked_reason(md_plain, Some(&json!({ "requiredCapabilities": [] }))),
            None
        );
        assert_eq!(
            declared_capabilities(Some(&json!({ "requiredCapabilities": ["video-api", "nonsense"] }))),
            vec!["video-generation"]
        );
        assert_eq!(declared_capabilities(None), Vec::<&str>::new());
    }
}