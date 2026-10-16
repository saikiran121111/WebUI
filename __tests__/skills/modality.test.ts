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
});
