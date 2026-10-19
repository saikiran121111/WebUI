import { describe, expect, it } from "vitest";
import {
  applyTitleToDoc,
  firstUserText,
  looksAutoTitle,
  shouldGenerate,
  REFRESH_MESSAGE_DELTA,
} from "@/lib/server/titles/policy";

const msg = (role: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  role,
  content,
  ...extra,
});

describe("title policy", () => {
  describe("firstUserText", () => {
    it("reads string content", () => {
      expect(firstUserText([msg("assistant", "hi"), msg("user", "why is the sky red?")])).toBe("why is the sky red?");
    });
    it("reads the FIRST text part of a parts array (never inlined attachment text)", () => {
      const m = msg("user", [
        { type: "text", text: "summarize this video" },
        { type: "text", text: "<huge inlined transcript>" },
      ]);
      expect(firstUserText([m])).toBe("summarize this video");
    });
    it("returns empty when there is no user turn", () => {
      expect(firstUserText([msg("assistant", "hi")])).toBe("");
    });
  });

  describe("looksAutoTitle (legacy first-message copy detector)", () => {
    const first = "Can you watch this video and explain the timestamp drift issue in detail please";

    it("flags the exact 40-char slice copy", () => {
      expect(looksAutoTitle(first.slice(0, 40), first)).toBe(true);
    });
    it("flags the whitespace-collapsed slice copy", () => {
      const messy = "Can  you\nwatch this video and explain the timestamp drift";
      expect(looksAutoTitle(messy.replace(/\s+/g, " ").slice(0, 40), messy)).toBe(true);
    });
    it("flags placeholders", () => {
      expect(looksAutoTitle("", first)).toBe(true);
      expect(looksAutoTitle("New conversation", first)).toBe(true);
      expect(looksAutoTitle("Untitled", first)).toBe(true);
    });
    it("does NOT flag a semantic or user-authored title", () => {
      expect(looksAutoTitle("Video Timestamp Drift Fix", first)).toBe(false);
      expect(looksAutoTitle("My custom title", first)).toBe(false);
    });
    it("does NOT flag a title that merely shares words with the first message", () => {
      expect(looksAutoTitle("Can you watch this video", first)).toBe(false); // shorter than the 40-slice
    });
  });

  describe("shouldGenerate", () => {
    it("runs initially once a full exchange exists", () => {
      expect(shouldGenerate({}, 2, false)).toBe(true);
      expect(shouldGenerate({}, 1, false)).toBe(false);
    });
    it("refreshes only after the message delta is reached", () => {
      const meta = { titleGenCount: 4 };
      expect(shouldGenerate(meta, 4 + REFRESH_MESSAGE_DELTA - 1, false)).toBe(false);
      expect(shouldGenerate(meta, 4 + REFRESH_MESSAGE_DELTA, false)).toBe(true);
    });
    it("never regenerates a manual title", () => {
      expect(shouldGenerate({ titleSource: "manual" }, 100, false)).toBe(false);
      expect(shouldGenerate({ titleSource: "manual" }, 100, true)).toBe(false);
    });
    it("force bypasses the cadence gate (manual still protected)", () => {
      expect(shouldGenerate({ titleGenCount: 10 }, 11, true)).toBe(true);
    });
  });

  describe("applyTitleToDoc (guarded write)", () => {
    it("writes title + auto bookkeeping without bumping updatedAt", () => {
      const doc: any = { meta: { title: "old", updatedAt: 111 }, messages: [] };
      expect(applyTitleToDoc(doc, "GPU Driver Debug Thread", 6)).toBe(true);
      expect(doc.meta.title).toBe("GPU Driver Debug Thread");
      expect(doc.meta.titleSource).toBe("auto");
      expect(doc.meta.titleGenCount).toBe(6);
      expect(typeof doc.meta.titleGenAt).toBe("number");
      expect(doc.meta.updatedAt).toBe(111); // sidebar order untouched
    });
    it("refuses a manual title", () => {
      const doc = { meta: { title: "Keep Me", titleSource: "manual" } };
      expect(applyTitleToDoc(doc, "Nope", 99)).toBe(false);
      expect(doc.meta.title).toBe("Keep Me");
    });
    it("refuses an OLDER job overwriting a NEWER generation", () => {
      // Job snapshotted 4 messages; meanwhile a job for 10 messages landed.
      const doc = { meta: { title: "Fresh Title", titleSource: "auto", titleGenCount: 10 } };
      expect(applyTitleToDoc(doc, "Stale Job Result", 4)).toBe(false);
      expect(doc.meta.title).toBe("Fresh Title");
    });
    it("allows equal generation count (re-run of the same snapshot)", () => {
      const doc = { meta: { title: "T", titleSource: "auto", titleGenCount: 6 } };
      expect(applyTitleToDoc(doc, "Better Title", 6)).toBe(true);
      expect(doc.meta.title).toBe("Better Title");
    });
    it("rejects empty titles and docs without meta", () => {
      expect(applyTitleToDoc({ meta: {} }, "", 3)).toBe(false);
      expect(applyTitleToDoc({ messages: [] }, "Valid", 3)).toBe(false);
    });
  });
});
