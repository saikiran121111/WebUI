import { describe, it, expect } from "vitest";
import {
  strategiesForFailure,
  nextStrategy,
  classifyFailure,
} from "@/lib/browser/fallbackController";

describe("fallback ladder — six-layer, ordered, honest", () => {
  it("per-failure strategy tables are cheapest-first", () => {
    expect(strategiesForFailure("stale_ref")).toEqual([
      "semantic_dom", "expanded_dom", "frame_dom", "keyboard", "human_handoff",
    ]);
    expect(strategiesForFailure("canvas_only")).toEqual([
      "visual_grounding", "authorized_alternative", "human_handoff",
    ]);
    expect(strategiesForFailure("shadow_dom_closed")[0]).toBe("keyboard");
    expect(strategiesForFailure("security_challenge")).toEqual([
      "authorized_alternative", "human_handoff",
    ]);
  });

  it("picks the next untried strategy in ladder order", () => {
    expect(nextStrategy("stale_ref", ["semantic_dom"]).strategy).toBe("expanded_dom");
    expect(nextStrategy("stale_ref", []).strategy).toBe("semantic_dom");
    expect(nextStrategy("target_not_found", ["expanded_dom", "frame_dom"]).strategy).toBe("keyboard");
    expect(nextStrategy("canvas_only", []).strategy).toBe("visual_grounding");
  });

  it("skips layers the failure class disallows (no visual for stale refs)", () => {
    expect(nextStrategy("stale_ref", ["semantic_dom", "expanded_dom", "frame_dom"]).strategy).toBe("keyboard");
    const d = nextStrategy("stale_ref", ["semantic_dom", "expanded_dom", "frame_dom", "keyboard"]);
    expect(d.strategy).toBe("human_handoff");
    expect(d.handoff).toBe(true);
  });

  it("exhausted ladder → clean human handoff, never a fabricated success", () => {
    const d = nextStrategy("target_not_found", [
      "expanded_dom", "frame_dom", "keyboard", "visual_grounding", "authorized_alternative",
    ]);
    expect(d.strategy).toBe("human_handoff");
    expect(d.handoff).toBe(true);
    expect(d.waitingFor).toBe("waiting_for_user_action");
  });

  it("security challenges short-circuit to handoff regardless of history", () => {
    const d = nextStrategy("security_challenge", [], "captcha");
    expect(d.handoff).toBe(true);
    expect(d.strategy).toBe("human_handoff");
    expect(d.waitingFor).toBe("waiting_for_user_action");
    expect(nextStrategy("security_challenge", [], "mfa").waitingFor).toBe("waiting_for_login");
  });

  it("consequential blocks always wait for confirmation", () => {
    const d = nextStrategy("consequential_blocked", ["semantic_dom", "expanded_dom"]);
    expect(d.strategy).toBe("authorized_alternative");
    expect(d.handoff).toBe(true);
    expect(d.waitingFor).toBe("waiting_for_confirmation");
  });

  it("classifyFailure maps raw errors conservatively", () => {
    expect(classifyFailure("no element matched the target")).toBe("target_not_found");
    expect(classifyFailure("locator resolved to 0 elements")).toBe("target_not_found");
    expect(classifyFailure("stale element handle: node detached")).toBe("stale_ref");
    expect(classifyFailure("strict mode violation: resolved to 3 elements")).toBe("ambiguous_target");
    expect(classifyFailure("cross-frame context mismatch")).toBe("iframe_barrier");
    expect(classifyFailure("element lives in a closed shadow root")).toBe("shadow_dom_closed");
    expect(classifyFailure("page has no DOM targets; canvas-driven UI")).toBe("canvas_only");
    expect(classifyFailure("HTTP 429 Too Many Requests")).toBe("rate_limit");
    expect(classifyFailure("please sign in first")).toBe("login_required");
    expect(classifyFailure("element is not visible")).toBe("action_failed");
    expect(classifyFailure("kaboodle?!")).toBe("unknown");
    expect(classifyFailure("whatever", { challenge: "captcha" })).toBe("security_challenge");
  });
});
