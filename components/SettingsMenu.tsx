"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Settings, Server, Key, RotateCcw, Trash2, Loader2, GitMerge, Globe2,
} from "lucide-react";
import type { EffortLevel } from "../lib/types";
import { cn } from "../lib/utils";
import { fetchSettings, saveSettings, clearSettingsRemote, LlmSettings } from "../lib/settings/client";
import {
  BROWSER_ENGINES,
  DEFAULT_BROWSER_ENGINE,
  ENGINE_LABELS,
  type BrowserEngine,
} from "../lib/browser/engineConfig";
import {
  COMPACT_CUSTOM_MAX,
  COMPACT_CUSTOM_MIN,
  COMPACT_PRESETS,
  compactThresholdsFromSettings,
  isValidCustom,
  primeCompactThresholds,
  type CompactThresholds,
} from "../lib/chat/compactConfig";

const EFFORT_LEVELS: EffortLevel[] = ["off", "low", "medium", "high", "max"];
const EFFORT_LABEL: Record<EffortLevel, string> = {
  off: "Off", low: "Low", medium: "Medium", high: "High", max: "Max",
};

const URL_RE = /^https?:\/\/\S+$/;

/** The three context presets, shown with their "k" suffix. */
const PRESET_LABELS: Array<{ value: number; label: string }> = [
  { value: 32_000, label: "32k" },
  { value: 64_000, label: "64k" },
  { value: 128_000, label: "128k" },
  { value: 256_000, label: "256k" },
];

interface SettingsMenuProps {
  effort: EffortLevel;
  onEffortChange: (e: EffortLevel) => void;
  /** Manual "Compact now" trigger (the hook's compact()). */
  onCompactNow?: () => void;
}

/**
 * The top-right "Reasoning" settings menu.
 * Combines reasoning-effort selection, LLM endpoint configuration
 * (settings.json), and the auto-compact context threshold into a single
 * dropdown with three tabs.
 */
export default function SettingsMenu({ effort, onEffortChange, onCompactNow }: SettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"reasoning" | "context" | "endpoint" | "browser">("reasoning");
  const [settings, setSettings] = useState<LlmSettings>({});
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<"ok" | "err" | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"ok" | "fail" | null>(null);
  // Auto-compact context state
  const [compact, setCompact] = useState<CompactThresholds>({ auto: 0, tokens: 0 });
  const [customInput, setCustomInput] = useState<string>("");
  // Browser engine (server-authoritative value mirrored in the UI).
  const [engine, setEngine] = useState<BrowserEngine>(DEFAULT_BROWSER_ENGINE);
  const ref = useRef<HTMLDivElement>(null);
  // True once the user touched any compact control this menu-open cycle. The
  // load-on-open fetch can resolve AFTER a fast first click (cold dev-server
  // compile makes /api/settings slow); without this guard that fetch clobbers
  // the just-clicked preset/toggle back to the on-disk value.
  const compactDirtyRef = useRef(false);

  // Load settings once the menu is opened.
  useEffect(() => {
    if (!open) return;
    compactDirtyRef.current = false;
    let ignore = false;
    fetchSettings().then((s) => {
      if (ignore) return;
      setSettings(s);
      setUrl(s.llm_api_url ?? "");
      setKey(s.llm_api_key ?? "");
      setEngine(s.browser_engine ?? DEFAULT_BROWSER_ENGINE);
      if (compactDirtyRef.current) return; // user already chose — don't overwrite
      const t = compactThresholdsFromSettings(s as Record<string, unknown>);
      setCompact(t);
      // Seed the input from the saved threshold; empty (not "0") when unset,
      // otherwise "0" trips the 8k–1M validator on every open and Save is
      // permanently disabled.
      setCustomInput(t.tokens > 0 ? String(t.tokens) : "");
    });
    return () => { ignore = true; };
  }, [open]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const flashClear = useCallback(() => {
    setTimeout(() => setFlash(null), 2000);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setFlash(null);
    try {
      const patch: LlmSettings = {};
      const trimmedUrl = url.trim();
      if (trimmedUrl) {
        if (!URL_RE.test(trimmedUrl)) {
          setFlash("err");
          setSaving(false);
          return;
        }
        patch.llm_api_url = trimmedUrl;
      } else if (settings.llm_api_url) {
        // Explicitly clear: fall back to env / hardcoded default.
        patch.llm_api_url = undefined as unknown as string;
      }
      const trimmedKey = key.trim();
      if (trimmedKey !== (settings.llm_api_key ?? "")) {
        patch.llm_api_key = trimmedKey;
      }
      await saveSettings(patch);
      setFlash("ok");
      flashClear();
    } catch {
      setFlash("err");
      flashClear();
    } finally {
      setSaving(false);
    }
  }, [url, key, settings, flashClear]);

  /**
   * Save the engine choice server-side, then broadcast it so app/page.tsx
   * mounts/unmounts the right Browser panel immediately (no reload). The
   * server value is authoritative — the event only mirrors it client-side.
   */
  const handleEngineChange = useCallback(async (next: BrowserEngine) => {
    if (next === engine) return;
    setEngine(next);
    setSaving(true);
    setFlash(null);
    try {
      await saveSettings({ browser_engine: next });
      window.dispatchEvent(
        new CustomEvent("browser-engine:changed", { detail: { engine: next } }),
      );
      setFlash("ok");
    } catch {
      setFlash("err");
    } finally {
      setSaving(false);
      flashClear();
    }
  }, [engine, flashClear]);

  const handleReset = useCallback(async () => {
    setSaving(true);
    setFlash(null);
    try {
      await clearSettingsRemote();
      setUrl("");
      setKey("");
      setSettings({});
      setFlash("ok");
      flashClear();
    } catch {
      setFlash("err");
      flashClear();
    } finally {
      setSaving(false);
    }
  }, [flashClear]);

  const handleTest = useCallback(async () => {
    if (!url.trim() || !URL_RE.test(url.trim())) return;
    setTesting(true);
    setTestResult(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url.trim(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(key.trim() ? { Authorization: "Bearer " + key.trim() } : {}),
        },
        body: JSON.stringify({
          model: "default",
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
          max_tokens: 4,
          stream: false,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        setTestResult("ok");
      } else {
        setTestResult("fail");
      }
    } catch {
      clearTimeout(timer);
      setTestResult("fail");
    } finally {
      setTesting(false);
    }
  }, [url, key]);

  /* ── Auto-compact context ──────────────────────────────────────────── */

  const customValid =
    compact.tokens !== COMPACT_PRESETS[0] &&
    compact.tokens !== COMPACT_PRESETS[1] &&
    compact.tokens !== COMPACT_PRESETS[2] &&
    compact.tokens !== COMPACT_PRESETS[3];

  const customError = (() => {
    const n = parseInt(customInput, 10);
    if (customInput !== "" && (isNaN(n) || n < COMPACT_CUSTOM_MIN || n > COMPACT_CUSTOM_MAX)) {
      return `Enter ${COMPACT_CUSTOM_MIN.toLocaleString()} – ${COMPACT_CUSTOM_MAX.toLocaleString()}`;
    }
    return null;
  })();

  const handleCompactPreset = useCallback((tokens: number) => {
    compactDirtyRef.current = true;
    setCompact((prev) => ({ ...prev, tokens, auto: 1 }));
    // Keep the custom input in sync with the preset; a stale out-of-range
    // value would keep the validator error up and block Save.
    setCustomInput(String(tokens));
  }, []);

  const handleCompactCustom = useCallback(() => {
    const n = parseInt(customInput, 10);
    if (!isValidCustom(n)) return; // out of range: error is visible, keep last valid value
    compactDirtyRef.current = true;
    setCompact({ auto: 1, tokens: n });
  }, [customInput]);

  const handleCompactToggle = useCallback(() => {
    compactDirtyRef.current = true;
    if (compact.auto === 1) {
      setCompact({ auto: 0, tokens: compact.tokens });
      return;
    }
    // Turning on with no usable threshold would write "On · 0k" (a no-op the
    // send gate ignores); arm the default preset instead.
    const tokens = isValidCustom(compact.tokens) ? compact.tokens : COMPACT_PRESETS[0];
    setCompact({ auto: 1, tokens });
    setCustomInput(String(tokens));
  }, [compact]);

  const handleSaveCompact = useCallback(async () => {
    if (customError) return;
    setSaving(true);
    setFlash(null);
    try {
      await saveSettings({ compact_thresholds: compact } as unknown as LlmSettings);
      // Keep the chat hook's gate fresh: fetchCompactThresholds() returns
      // the module cache once primed, so a mid-session save must push
      // through here or auto-compact would keep the stale threshold.
      primeCompactThresholds(compact);
      setFlash("ok");
      flashClear();
    } catch {
      setFlash("err");
      flashClear();
    } finally {
      setSaving(false);
    }
  }, [compact, customError, flashClear]);

  const statusLine = (() => {
    if (flash === "ok") return <span className="text-white/70 text-[10px]">Saved ✓</span>;
    if (flash === "err") return <span className="text-white/60 text-[10px]">Invalid URL</span>;
    if (testResult === "ok") return <span className="text-white/70 text-[10px]">Connected</span>;
    if (testResult === "fail") return <span className="text-white/50 text-[10px]">Unreachable</span>;
    return null;
  })();

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          "w-7 h-7 rounded-md flex items-center justify-center transition-colors duration-[120ms]",
          open ? "bg-white/[0.09] text-white/95" : "text-white/55 hover:text-white/90 hover:bg-white/[0.05]",
        )}
        aria-label="Settings"
        title="Settings"
      >
        <Settings className="w-4 h-4" />
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-2 w-72 z-50 rounded-xl bg-[#1d1d1d] border border-[rgba(255,255,255,0.15)] shadow-2xl shadow-black/60 backdrop-blur-md">
          {/* Tabs */}
          <div className="flex border-b border-[rgba(255,255,255,0.09)]">
            {(["reasoning", "context", "endpoint", "browser"] as const).map((t) => (
              <button key={t}
                onClick={() => setTab(t)}
                data-testid={`settings-tab-${t}`}
                className={cn(
                  "flex-1 py-2 text-[11px] uppercase tracking-wider transition-colors duration-[120ms] border-b-2",
                  tab === t
                    ? "text-white/90 border-white/70 bg-white/[0.03]"
                    : "text-white/30 border-transparent hover:text-white/60",
                )}>
                {t === "reasoning" ? "Reasoning" : t === "context" ? "Context" : t === "endpoint" ? "Endpoint" : "Browser"}
              </button>
            ))}
          </div>

          {tab === "browser" ? (
            /* ── Browser tab: which engine drives the agent ───────────── */
            <div className="p-3 space-y-2.5" data-testid="settings-browser-tab">
              <label
                htmlFor="settings-browser-engine-select"
                className="flex items-center gap-1.5 text-[10px] text-white/35 uppercase tracking-wider"
              >
                <Globe2 className="w-3 h-3" />
                Browser engine
              </label>
              <select
                id="settings-browser-engine-select"
                data-testid="settings-browser-engine"
                value={engine}
                disabled={saving}
                onChange={(e) => void handleEngineChange(e.target.value as BrowserEngine)}
                className="w-full px-2 py-1.5 rounded-lg bg-[#2a2a2a] border border-[rgba(255,255,255,0.1)]
                  text-[11px] text-white/85 outline-none focus:border-white/30
                  transition-colors duration-[120ms]"
              >
                {BROWSER_ENGINES.map((e) => (
                  <option key={e} value={e}>{ENGINE_LABELS[e]}</option>
                ))}
              </select>
              <p className="text-[10px] text-white/35 leading-snug">
                Your own browser opens visibly in its own window and the AI drives that
                real window. There is no built-in WebUI browser and no live mirror.
              </p>
              <span className="text-[10px] text-white/35 tabular-nums" data-testid="browser-engine-status">
                {flash === "ok" ? "Saved ✓" : flash === "err" ? "Save failed" : `Active · ${engine}`}
              </span>
            </div>
          ) : tab === "context" ? (
            /* ── Context tab: auto-compact threshold ─────────────────── */
            <div className="p-3 space-y-2.5" data-testid="settings-context-tab">
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-1.5 text-[10px] text-white/35 uppercase tracking-wider">
                  <GitMerge className="w-3 h-3" />
                  Auto-compact
                </label>
                <button
                  onClick={handleCompactToggle}
                  role="switch"
                  aria-checked={compact.auto === 1}
                  aria-label="Auto-compact context"
                  data-testid="compact-toggle"
                  data-state={compact.auto === 1 ? "on" : "off"}
                  className={cn(
                    "relative w-9 h-5 rounded-full transition-colors duration-[150ms]",
                    compact.auto === 1 ? "bg-white/70" : "bg-white/15",
                  )}>
                  <span className={cn(
                    "absolute top-0.5 w-4 h-4 rounded-full bg-[#1d1d1d] transition-transform duration-[150ms] left-0.5",
                    compact.auto === 1 ? "translate-x-4" : "translate-x-0",
                  )} />
                </button>
              </div>

              <p className="text-[10px] text-white/35 leading-snug">
                When the conversation reaches the threshold, older turns are folded
                into a single summary before the next reply.
              </p>

              {/* Presets */}
              <div className="grid grid-cols-5 gap-1">
                {PRESET_LABELS.map((p) => (
                  <button
                    key={p.value}
                    onClick={() => handleCompactPreset(p.value)}
                    data-testid={`compact-preset-${p.label}`}
                    aria-pressed={compact.auto === 1 && compact.tokens === p.value}
                    className={cn(
                      "px-1 py-1.5 rounded-lg text-[10px] font-medium tabular-nums transition-colors duration-[120ms]",
                      compact.auto === 1 && compact.tokens === p.value
                        ? "bg-white/[0.14] text-white/95 border border-[rgba(255,255,255,0.2)]"
                        : "bg-white/[0.04] text-white/50 border border-[rgba(255,255,255,0.08)] hover:bg-white/[0.08] hover:text-white/80",
                    )}>
                    {p.label}
                  </button>
                ))}
              </div>

              {/* Custom */}
              <div>
                <label className="flex items-center gap-1.5 text-[10px] text-white/35 uppercase tracking-wider mb-1">
                  Custom threshold
                </label>
                <input
                  type="number"
                  inputMode="numeric"
                  min={COMPACT_CUSTOM_MIN}
                  max={COMPACT_CUSTOM_MAX}
                  step={1000}
                  value={customInput}
                  onChange={(e) => setCustomInput(e.target.value)}
                  onBlur={handleCompactCustom}
                  onKeyDown={(e) => { if (e.key === "Enter") handleCompactCustom(); }}
                  placeholder={`${COMPACT_CUSTOM_MIN} – ${COMPACT_CUSTOM_MAX}`}
                  data-testid="compact-custom-input"
                  className={cn(
                    "w-full px-2.5 py-1.5 rounded-lg bg-white/[0.05] border text-[11px] font-mono text-white/80 placeholder-white/20 outline-none transition-colors duration-[120ms]",
                    customError
                      ? "border-[rgba(255,255,255,0.35)]"
                      : "border-[rgba(255,255,255,0.1)] focus:border-white/30",
                  )}
                />
                {customError ? (
                  <p className="text-[10px] text-white/50 mt-1" data-testid="compact-custom-error">{customError}</p>
                ) : (
                  <p className="text-[10px] text-white/25 mt-1">
                    {COMPACT_CUSTOM_MIN.toLocaleString()} – {COMPACT_CUSTOM_MAX.toLocaleString()} tokens
                  </p>
                )}
              </div>

              <div className="flex items-center gap-1.5">
                <button onClick={handleSaveCompact}
                  disabled={saving || !!customError}
                  data-testid="compact-save"
                  className={cn(
                    "flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors duration-[120ms]",
                    saving
                      ? "bg-white/[0.05] text-white/30 cursor-wait"
                      : customError
                        ? "bg-white/[0.05] text-white/30 cursor-not-allowed"
                        : "bg-white/[0.12] text-white/90 border border-[rgba(255,255,255,0.15)] hover:bg-white/[0.18]",
                  )}>
                  {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                  Save
                </button>
                <span className="text-[10px] text-white/35 tabular-nums" data-testid="compact-status">
                  {compact.auto === 1
                    ? `On · ${Math.round(compact.tokens / 1000)}k`
                    : "Off"}
                </span>
              </div>

              {/* Manual compaction of the open conversation (same as /compact). */}
              <button
                onClick={() => { onCompactNow?.(); setOpen(false); }}
                disabled={!onCompactNow}
                data-testid="compact-now"
                className={cn(
                  "w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] transition-colors duration-[120ms]",
                  onCompactNow
                    ? "text-white/60 hover:text-white/90 hover:bg-white/[0.06] border border-[rgba(255,255,255,0.08)]"
                    : "text-white/20 border border-[rgba(255,255,255,0.05)] cursor-not-allowed",
                )}>
                <GitMerge className="w-3 h-3" />
                Compact now
              </button>
            </div>
          ) : tab === "reasoning" ? (
            <div className="py-1">
              {EFFORT_LEVELS.map((e) => (
                <button key={e}
                  onClick={() => { onEffortChange(e); setOpen(false); }}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors duration-[120ms]",
                    effort === e
                      ? "text-white/95 bg-white/[0.07]"
                      : "text-white/55 hover:bg-white/[0.04] hover:text-white/90",
                  )}>
                  {effort === e && <span className="w-1 h-1 rounded-full bg-white/80" />}
                  {EFFORT_LABEL[e]}
                </button>
              ))}
            </div>
          ) : (
            <div className="p-3 space-y-2.5">
              {/* URL field */}
              <div>
                <label className="flex items-center gap-1.5 text-[10px] text-white/35 uppercase tracking-wider mb-1">
                  <Server className="w-3 h-3" />
                  API Endpoint
                </label>
                <input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
                  placeholder="http://127.0.0.1:8080/v1/chat/completions"
                  className={cn(
                    "w-full px-2.5 py-1.5 rounded-lg bg-white/[0.05] border text-[11px] font-mono text-white/80 placeholder-white/20 outline-none transition-colors duration-[120ms]",
                    url && !URL_RE.test(url.trim())
                      ? "border-[rgba(255,255,255,0.35)]"
                      : "border-[rgba(255,255,255,0.1)] focus:border-white/30",
                  )}
                  data-testid="settings-endpoint-input"
                />
                {url && !URL_RE.test(url.trim()) && (
                  <p className="text-[10px] text-white/50 mt-1">Enter a full URL (http:// or https://)</p>
                )}
              </div>

              {/* Key field */}
              <div>
                <label className="flex items-center gap-1.5 text-[10px] text-white/35 uppercase tracking-wider mb-1">
                  <Key className="w-3 h-3" />
                  API Key
                </label>
                <input
                  type="password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="no-key"
                  className="w-full px-2.5 py-1.5 rounded-lg bg-white/[0.05] border border-[rgba(255,255,255,0.1)]
                    text-[11px] font-mono text-white/80 placeholder-white/20 outline-none
                    focus:border-white/30 transition-colors duration-[120ms]"
                  data-testid="settings-key-input"
                />
              </div>

              {/* Status line */}
              {statusLine && tab === "endpoint" && <div className="flex items-center">{statusLine}</div>}

              <div className="flex items-center gap-1.5">
                <button onClick={handleSave}
                  disabled={saving}
                  data-testid="settings-save"
                  className={cn(
                    "flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors duration-[120ms]",
                    saving
                      ? "bg-white/[0.05] text-white/30 cursor-wait"
                      : "bg-white/[0.12] text-white/90 border border-[rgba(255,255,255,0.15)] hover:bg-white/[0.18]",
                  )}>
                  {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                  Save
                </button>
                <button onClick={handleTest}
                  disabled={testing || !url.trim() || !URL_RE.test(url.trim())}
                  data-testid="settings-test"
                  className={cn(
                    "flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] transition-colors duration-[120ms] border",
                    !url.trim() || !URL_RE.test(url.trim())
                      ? "border-[rgba(255,255,255,0.06)] text-white/20 cursor-not-allowed"
                      : "border-[rgba(255,255,255,0.1)] text-white/55 hover:text-white/90 hover:border-white/25",
                  )}>
                  {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : "Test"}
                </button>
                <button onClick={handleReset}
                  title="Delete settings.json — revert to .env / defaults"
                  className="p-1.5 rounded-lg text-white/30 hover:text-white/80 hover:bg-white/[0.06] transition-colors duration-[120ms]"
                  aria-label="Reset settings"
                  data-testid="settings-reset">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
