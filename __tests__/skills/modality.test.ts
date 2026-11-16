import { describe, it, expect } from "vitest";
import { detectBlockedReason } from "../../lib/skills/modality";
import { BLOCKED_REASON } from "../../lib/skills/types";

describe("detectBlockedReason", () => {
  it("blocks skills that call external image generation services", () => {
    expect(detectBlockedReason("Use DALL-E to draw the logo.")).toBe(BLOCKED_REASON);
    expect(detectBlockedReason("Pipeline: Midjourney prompt then upscale.")).toBe(BLOCKED_REASON);
    expect(detectBlockedReason("Run the ComfyUI workflow for the poster.")).toBe(BLOCKED_REASON);
    expect(detectBlockedReason("Send the clip to Sora for video generation.")).toBe(BLOCKED_REASON);
  });

  it("blocks text-to-image phrasing even without a vendor name", () => {
    expect(detectBlockedReason("This skill does text-to-image conversion.")).toBe(BLOCKED_REASON);
    expect(detectBlockedReason("Generate images of the product hero.")).toBe(BLOCKED_REASON);
  });

  it("allows code-driven visual skills (Three.js / WebGL / Canvas / SVG)", () => {
    expect(detectBlockedReason(
      "Build a Three.js scene and generate images of the result with canvas screenshots.",
    )).toBeNull();
    expect(detectBlockedReason("Draw the chart with SVG and WebGL shaders.")).toBeNull();
  });

  it("still blocks vendor services inside a code-viz skill", () => {
    expect(detectBlockedReason(
      "Render the Three.js scene, then finish the frame with Stable Diffusion img2img.",
    )).toBe(BLOCKED_REASON);
  });

  it("leaves unrelated skills unblocked", () => {
    expect(detectBlockedReason("---\nname: humanizer\ndescription: Remove AI writing patterns.\n---\nRewrite the text.")).toBeNull();
    expect(detectBlockedReason("Summarize the document in three bullets.")).toBeNull();
  });

  it("F20: a brand MENTION is not a capability requirement (negative controls)", () => {
    expect(
      detectBlockedReason("# CSV charting guide\nExplain why you should NOT use Midjourney for tabular data."),
    ).toBeNull();
    expect(detectBlockedReason("A text guide to Leonardo da Vinci and his notebooks.")).toBeNull();
    expect(detectBlockedReason("Do not use DALL-E; draw the logo with SVG paths instead.")).toBeNull();
    expect(detectBlockedReason("Unlike Runway, this skill renders the clip with ffmpeg filters.")).toBeNull();
    expect(detectBlockedReason("We compared Stable Diffusion with our chart engine.")).toBeNull();
  });

  it("F20: negation cannot cross a sentence boundary (positive controls)", () => {
    expect(detectBlockedReason("Do not use Excel. Generate the hero image with Midjourney.")).toBe(BLOCKED_REASON);
    expect(detectBlockedReason("No Excel. Call the image generation endpoint, then upscale.")).toBe(BLOCKED_REASON);
  });

  it("F20: protocol evidence blocks regardless of surrounding prose", () => {
    expect(detectBlockedReason("curl https://api.midjourney.com/v1/imagine -d prompt=hi")).toBe(BLOCKED_REASON);
    expect(detectBlockedReason("Set MIDJOURNEY_API_KEY then run the batch.")).toBe(BLOCKED_REASON);
    expect(detectBlockedReason("POST https://api.openai.com/v1/images/generations")).toBe(BLOCKED_REASON);
    expect(detectBlockedReason("---\nname: demo\nrequires: image-generation\n---\nBody.")).toBe(BLOCKED_REASON);
  });

  it("F20: declared requiredCapabilities are authoritative (application-owned metadata)", () => {
    expect(detectBlockedReason("Summarize the sheet.", { requiredCapabilities: ["image-generation"] }))
      .toBe(BLOCKED_REASON);
    expect(detectBlockedReason("Summarize the sheet.", { requiredCapabilities: ["Image Generation"] }))
      .toBe(BLOCKED_REASON);
    // An unrelated declaration does not erase the body\x27s own evidence: DALL-E is still
    // a named generation service, so the block stands (declarations add, never excuse).
    expect(detectBlockedReason("Summarize the sheet.", { requiredCapabilities: [] })).toBeNull();
  });

  it("F20: available capabilities never produce a block", () => {
    expect(
      detectBlockedReason("Generate images with Midjourney.", undefined, ["image-generation"]),
    ).toBeNull();
  });

  it("F20: ambiguous brand words need a service affix, not a bare mention", () => {
    expect(detectBlockedReason("A flythrough of the runway at dawn.")).toBeNull();
    expect(detectBlockedReason("Flux capacity in the reactor loop.")).toBeNull();
    expect(detectBlockedReason("Call the Sora API to render the clip.")).toBe(BLOCKED_REASON);
  });


  it("F20: a dependency statement on a provider blocks even without a media noun", () => {
    expect(detectBlockedReason("This skill requires Midjourney.")).toBe(BLOCKED_REASON);
    expect(detectBlockedReason("Needs ComfyUI.")).toBe(BLOCKED_REASON);
    expect(detectBlockedReason("A bare mention: Stable Diffusion here.")).toBeNull();
  });

});
