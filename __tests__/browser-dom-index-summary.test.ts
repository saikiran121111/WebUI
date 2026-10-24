import { describe, it, expect } from "vitest";
import { snapshotSummaryText } from "@/lib/browser/domIndexer";
import type { PageSnapshot, RefInfo } from "@/lib/browser/domIndexer";

const snap = (refs: RefInfo[], truncated = false): PageSnapshot => ({
  snapshotId: 7,
  url: "http://x.test/page",
  title: "T",
  refs,
  frameUrls: ["http://x.test/page"],
  truncated,
  snapshotAt: Date.now(),
});

describe("snapshotSummaryText — the bounded act→see→act ref map", () => {
  it("renders refs with role + accessible name, checked state, password masking", () => {
    const text = snapshotSummaryText(
      snap([
        { ref: "e1", role: "button", name: "Save", tag: "button", checked: true, frameIdx: 0 },
        { ref: "e2", role: "textbox", name: "Password", tag: "input", valueMask: "•••", frameIdx: 0 },
        { ref: "e3", role: "checkbox", name: "Subscribe", tag: "input", checked: false, frameIdx: 0 },
        { ref: "f1:e1", role: "textbox", name: "City in frame", tag: "input", frameIdx: 1 },
      ]),
    );
    expect(text).toContain('[e1] button "Save" [checked]');
    // The VALUE of a password field never reaches the model — only the mask note.
    expect(text).toContain('[e2] textbox "Password" [password field — value hidden]');
    expect(text).toContain('[e3] checkbox "Subscribe" [unchecked]');
    expect(text).toContain('[f1:e1] textbox "City in frame"');
  });

  it("empty page says so honestly", () => {
    expect(snapshotSummaryText(snap([]))).toBe("(no interactive elements found)");
  });

  it("truncated DOMs are disclosed", () => {
    const text = snapshotSummaryText(snap(
      Array.from({ length: 150 }, (_, i) => ({
        ref: `e${i + 1}`, role: "button", name: "b", tag: "button", frameIdx: 0,
      })),
      true,
    ));
    expect(text).toContain("(150 refs; DOM truncated at 150)");
  });

  it("the whole block is capped near 3500 chars with a visible truncation note", () => {
    const text = snapshotSummaryText(snap(
      Array.from({ length: 120 }, (_, i) => ({
        ref: `e${i + 1}`, role: "button", name: "N".repeat(60), tag: "button", frameIdx: 0,
      })),
    ));
    expect(text).toContain("… (truncated)");
    expect(text.length).toBeLessThan(3700);
  });
});
