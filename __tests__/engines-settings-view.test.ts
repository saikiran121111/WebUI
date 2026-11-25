/**
 * B5 FINAL DECISION — the Settings → Engines panel.
 *
 * Seam: the exported pure view EnginesSettingsView (renderToStaticMarkup).
 * The laws pinned here:
 *  * Speech is FIXED: the panel shows the registry's pinned Parakeet row —
 *    pinned cross-language by reading PARAKEET_ID out of
 *    python-backend/ruke_ml/models/registry.py — and offers no search,
 *    picker, token, mirror or download control (the removed surface must
 *    not leak back through the UI).
 *  * OCR is EXACTLY two named choices: "PaddleOCR (recommended)" (default,
 *    automatic per-page Tesseract fallback) and "Tesseract only" (never
 *    loads Paddle); the selected one carries aria-checked.
 *  * The ASR migration is VISIBLE: migratedFrom renders a note naming the
 *    obsolete preference; a clean read renders none.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FIXED_SPEECH_MODEL } from "../lib/settings/client";
import { EnginesSettingsView } from "../components/EnginesSettings";

const registryPy = readFileSync(
  path.resolve(__dirname, "..", "python-backend", "ruke_ml", "models", "registry.py"),
  "utf8",
);
const pyParakeet = registryPy.match(/^PARAKEET_ID = "([^"]+)"/m);

function render(props: {
  ocrEngine: "paddle" | "tesseract" | "";
  migratedFrom: string | null;
  saveError?: string | null;
}) {
  return renderToStaticMarkup(
    h(EnginesSettingsView, {
      ocrEngine: props.ocrEngine,
      migratedFrom: props.migratedFrom,
      onOcrEngine: () => {},
      saveError: props.saveError,
    }),
  );
}

describe("the speech engine is the registry's pinned Parakeet, fixed", () => {
  it("the TS fixed id is the Python registry's PARAKEET_ID", () => {
    // One frozen engine, named identically on both sides.
    expect(pyParakeet, "PARAKEET_ID is no longer declared in registry.py").not.toBeNull();
    expect(FIXED_SPEECH_MODEL).toBe(pyParakeet![1]);
  });

  it("the panel shows the fixed row and no marketplace control", () => {
    const html = render({ ocrEngine: "", migratedFrom: null });
    expect(html).toContain("engines-speech-fixed");
    expect(html).toContain(FIXED_SPEECH_MODEL);
    // The removed surface: the panel carries NO editable control at all
    // (a search box, repo/revision entry, token, mirror or download picker
    // is input-based) and never names the retired keys.
    expect(html).not.toContain("<input");
    for (const forbidden of ["hf_token", "model_mirror", "hf_token_set"]) {
      expect(html, `the panel must not mention "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it("the panel's visible words carry none of the retired marketplace vocabulary", () => {
    // F90.1 word-scan law, pinned at the render layer (accept-5 regression:
    // the speech help sentence put "download" into the panel's innerText and
    // the browser scan failed the whole Tesseract-only flow downstream).
    // This mirrors exactly what tests/ocr-tesseract-only.spec.ts scans.
    const text = render({ ocrEngine: "", migratedFrom: "Systran/faster-whisper-base" })
      .replace(/<[^>]*>/g, " ")
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
    for (const retired of ["search models", "download", "delete model", "hugging", "mirror"]) {
      expect(text, `retired marketplace control leaked: ${retired}`).not.toContain(retired);
    }
  });
});

describe("OCR offers exactly the two named engines", () => {
  it("the unset default selects PaddleOCR with the automatic-fallback law", () => {
    const html = render({ ocrEngine: "", migratedFrom: null });
    expect(html).toContain("PaddleOCR (recommended)");
    expect(html).toContain("Tesseract only");
    expect(html).toMatch(/aria-checked="true" data-testid="engines-ocr-paddle"/);
    expect(html).toMatch(/aria-checked="false" data-testid="engines-ocr-tesseract"/);
    expect(html).toContain("falls back to Tesseract automatically");
    expect(html).toContain("Never loads PaddleOCR");
  });

  it("an explicit Tesseract-only choice selects the Tesseract radio", () => {
    const html = render({ ocrEngine: "tesseract", migratedFrom: null });
    expect(html).toMatch(/aria-checked="false" data-testid="engines-ocr-paddle"/);
    expect(html).toMatch(/aria-checked="true" data-testid="engines-ocr-tesseract"/);
  });

  it("the paddle write is the PaddleOCR default choice", () => {
    const html = render({ ocrEngine: "paddle", migratedFrom: null });
    expect(html).toMatch(/aria-checked="true" data-testid="engines-ocr-paddle"/);
  });
});

describe("the ASR migration is announced once, visibly", () => {
  it("a migrated preference is named in the note", () => {
    const html = render({ ocrEngine: "tesseract", migratedFrom: "Systran/faster-whisper-base" });
    expect(html).toContain("engines-migrated-note");
    expect(html).toContain("Systran/faster-whisper-base");
    expect(html).toContain("Parakeet");
  });

  it("a clean read renders no note", () => {
    const html = render({ ocrEngine: "paddle", migratedFrom: null });
    expect(html).not.toContain("engines-migrated-note");
  });
});

describe("a refused engine save is visible (F153 status law)", () => {
  it("the panel names the failed save next to the reverted choice", () => {
    const html = render({
      ocrEngine: "paddle",
      migratedFrom: null,
      saveError: "Save failed — the OCR engine was NOT changed.",
    });
    expect(html).toContain("engines-save-error");
    expect(html).toContain("NOT changed");
  });

  it("a saved choice renders no failure line", () => {
    const html = render({ ocrEngine: "tesseract", migratedFrom: null });
    expect(html).not.toContain("engines-save-error");
  });
});
