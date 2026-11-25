"use client";
import { useCallback, useEffect, useState } from "react";
import { Mic, ScanText, Megaphone } from "lucide-react";
import { cn } from "../lib/utils";
import {
  FIXED_SPEECH_MODEL,
  fetchSettings,
  getEngineMigrationNotice,
  saveSettings,
} from "../lib/settings/client";

/**
 * Settings → Engines (final decision 2026-11-22, freeze English release
 * scope). The removed Hugging Face model-manager (search, picker, token,
 * mirror, download) is GONE — this panel shows the two frozen engines and
 * the ONE choice the user keeps:
 *
 *  - Speech: Parakeet, fixed. No selector, no download button — assets are
 *    provisioned automatically, project-local.
 *  - OCR: exactly two named choices, "PaddleOCR (recommended)" (with the
 *    per-page automatic Tesseract fallback) and "Tesseract only" (never
 *    loads Paddle). An obsolete ASR preference migrated to Parakeet is
 *    announced once (speech_model_migrated → getEngineMigrationNotice).
 */

interface EnginesViewProps {
  /** The stored OCR choice; ""/"paddle"/unset = the PaddleOCR default. */
  ocrEngine: "paddle" | "tesseract" | "";
  /** The obsolete ASR preference the server rewrote on the last read, when one was. */
  migratedFrom: string | null;
  onOcrEngine: (engine: "paddle" | "tesseract") => void;
  /** F153: visible failure when the server refused the choice (null = saved). */
  saveError?: string | null;
}

/** The pure panel, exported for renderToStaticMarkup tests. */
export function EnginesSettingsView({ ocrEngine, migratedFrom, onOcrEngine, saveError }: EnginesViewProps) {
  const paddleChosen = ocrEngine !== "tesseract";
  return (
    <div className="p-3 space-y-3" data-testid="engines-panel">
      {migratedFrom && (
        <div
          data-testid="engines-migrated-note"
          className="flex items-start gap-1.5 rounded-lg bg-white/[0.06] border border-white/15 px-2 py-1.5"
        >
          <Megaphone className="w-3 h-3 mt-0.5 text-white/60 shrink-0" />
          <p className="text-[10px] leading-snug text-white/70">
            Audio transcription switched from <span className="font-mono text-white/90">{migratedFrom}</span>{" "}
            to Parakeet — the release&apos;s one speech engine.
          </p>
        </div>
      )}

      <div>
        <label className="flex items-center gap-1.5 text-[10px] text-white/35 uppercase tracking-wider mb-1">
          <Mic className="w-3 h-3" />
          Speech (audio + video)
        </label>
        <div
          data-testid="engines-speech-fixed"
          className="w-full px-2.5 py-1.5 rounded-lg bg-white/[0.05] border border-[rgba(255,255,255,0.1)] text-[11px] font-mono text-white/80"
        >
          {FIXED_SPEECH_MODEL}
        </div>
        <p className="mt-1 text-[10px] text-white/35 leading-snug">
          The only transcription engine. Its model files are set up automatically on first use —
          no manager, no registry, nothing to install by hand.
        </p>
      </div>

      <div>
        <label className="flex items-center gap-1.5 text-[10px] text-white/35 uppercase tracking-wider mb-1">
          <ScanText className="w-3 h-3" />
          OCR engine
        </label>
        <div role="radiogroup" aria-label="OCR engine" className="space-y-1">
          <button
            type="button"
            role="radio"
            aria-checked={paddleChosen}
            data-testid="engines-ocr-paddle"
            onClick={() => onOcrEngine("paddle")}
            className={cn(
              "w-full text-left px-2.5 py-1.5 rounded-lg border transition-colors duration-[120ms]",
              paddleChosen
                ? "bg-white/[0.09] border-white/30 text-white/95"
                : "bg-white/[0.03] border-[rgba(255,255,255,0.1)] text-white/55 hover:text-white/85",
            )}
          >
            <span className="flex items-center gap-1.5 text-[11px]">
              {paddleChosen && <span className="w-1.5 h-1.5 rounded-full bg-white/80" />}
              PaddleOCR (recommended)
            </span>
            <span className="block mt-0.5 text-[10px] text-white/35 leading-snug">
              Every page tries PaddleOCR first; a page it cannot read falls back to Tesseract automatically.
            </span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={!paddleChosen}
            data-testid="engines-ocr-tesseract"
            onClick={() => onOcrEngine("tesseract")}
            className={cn(
              "w-full text-left px-2.5 py-1.5 rounded-lg border transition-colors duration-[120ms]",
              !paddleChosen
                ? "bg-white/[0.09] border-white/30 text-white/95"
                : "bg-white/[0.03] border-[rgba(255,255,255,0.1)] text-white/55 hover:text-white/85",
            )}
          >
            <span className="flex items-center gap-1.5 text-[11px]">
              {!paddleChosen && <span className="w-1.5 h-1.5 rounded-full bg-white/80" />}
              Tesseract only
            </span>
            <span className="block mt-0.5 text-[10px] text-white/35 leading-snug">
              Never loads PaddleOCR.
            </span>
          </button>
        </div>
        {saveError && (
          <p data-testid="engines-save-error" className="mt-1 text-[10px] text-red-300 leading-snug">
            {saveError}
          </p>
        )}
      </div>
    </div>
  );
}

/** The mounted tab: loads the stored engines view when opened and saves OCR choices. */
export default function EnginesSettings({ active }: { active: boolean }) {
  const [ocrEngine, setOcrEngine] = useState<"paddle" | "tesseract" | "">("");
  const [migratedFrom, setMigratedFrom] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    fetchSettings(true).then((s) => {
      if (!alive) return;
      setOcrEngine(s.ocr_engine ?? "");
      setMigratedFrom(getEngineMigrationNotice());
    });
    return () => { alive = false; };
  }, [active]);

  const onOcrEngine = useCallback((engine: "paddle" | "tesseract") => {
    setOcrEngine(engine);
    setSaveError(null);
    // F153 (2026-11-24): the radio must never display an engine the server
    // refused. On HEAD the save was fire-and-forget and saveSettings never
    // threw, so a failed PUT left the new engine SELECTED while
    // settings.json kept the old one. Revert to the server-confirmed value
    // and say so visibly.
    saveSettings({ ocr_engine: engine })
      .then((s) => setOcrEngine(s.ocr_engine ?? ""))
      .catch(() => {
        fetchSettings(true).then((s) => setOcrEngine(s.ocr_engine ?? ""));
        setSaveError("Save failed — the OCR engine was NOT changed.");
      });
  }, []);

  return <EnginesSettingsView ocrEngine={ocrEngine} migratedFrom={migratedFrom} onOcrEngine={onOcrEngine} saveError={saveError} />;
}
