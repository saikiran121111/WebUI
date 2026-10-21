"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Brain, Server, Key, RotateCcw, Trash2, Loader2,
} from "lucide-react";
import type { EffortLevel } from "../lib/types";
import { cn } from "../lib/utils";
import { fetchSettings, saveSettings, clearSettingsRemote, LlmSettings } from "../lib/settings/client";

const EFFORT_LEVELS: EffortLevel[] = ["off", "low", "medium", "high", "max"];
const EFFORT_LABEL: Record<EffortLevel, string> = {
  off: "Off", low: "Low", medium: "Medium", high: "High", max: "Max",
};

const URL_RE = /^https?:\/\/\S+$/;

interface SettingsMenuProps {
  effort: EffortLevel;
  onEffortChange: (e: EffortLevel) => void;
}

/**
 * The top-right "Reasoning" settings menu.
 * Combines reasoning-effort selection and LLM endpoint configuration
 * (settings.json) into a single dropdown.
 */
export default function SettingsMenu({ effort, onEffortChange }: SettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"reasoning" | "endpoint">("reasoning");
  const [settings, setSettings] = useState<LlmSettings>({});
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<"ok" | "err" | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"ok" | "fail" | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Load settings once the menu is opened.
  useEffect(() => {
    if (!open) return;
    fetchSettings().then((s) => {
      setSettings(s);
      setUrl(s.llm_api_url ?? "");
      setKey(s.llm_api_key ?? "");
    });
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

  const statusLine = (() => {
    if (flash === "ok") return <span className="text-emerald-400/80 text-[10px]">Saved ✓</span>;
    if (flash === "err") return <span className="text-red-400 text-[10px]">Invalid URL</span>;
    if (testResult === "ok") return <span className="text-emerald-400/80 text-[10px]">Connected</span>;
    if (testResult === "fail") return <span className="text-red-400 text-[10px]">Unreachable</span>;
    return null;
  })();

  const displayLabel = url.trim()
    ? (() => {
        try { return new URL(url.trim()).host; } catch { return "custom"; }
      })()
    : "Local";

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] transition-colors",
          open ? "bg-white/[0.08] text-white/90" : "text-white/40 hover:text-white/70 hover:bg-white/[0.05]",
        )}
        aria-label="Settings"
      >
        <Brain className="w-3.5 h-3.5" />
        <span>{displayLabel}</span>
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-2 w-64 z-50 rounded-xl bg-[#0d0d12] border border-white/[0.1] shadow-2xl shadow-black/60">
          {/* Tabs */}
          <div className="flex border-b border-white/[0.06]">
            {(["reasoning", "endpoint"] as const).map((t) => (
              <button key={t}
                onClick={() => setTab(t)}
                className={cn(
                  "flex-1 py-2 text-[11px] uppercase tracking-wider transition-colors border-b-2",
                  tab === t
                    ? "text-white/80 border-indigo-400/60 bg-white/[0.03]"
                    : "text-white/30 border-transparent hover:text-white/60",
                )}>
                {t === "reasoning" ? "Reasoning" : "Endpoint"}
              </button>
            ))}
          </div>

          {tab === "reasoning" ? (
            <div className="py-1">
              {EFFORT_LEVELS.map((e) => (
                <button key={e}
                  onClick={() => { onEffortChange(e); setOpen(false); }}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors",
                    effort === e
                      ? "text-indigo-400 bg-indigo-500/[0.1]"
                      : "text-white/60 hover:bg-white/[0.04] hover:text-white/90",
                  )}>
                  {effort === e && <span className="w-1 h-1 rounded-full bg-indigo-400" />}
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
                    "w-full px-2.5 py-1.5 rounded-lg bg-white/[0.05] border text-[11px] font-mono text-white/80 placeholder-white/20 outline-none transition-colors",
                    url && !URL_RE.test(url.trim())
                      ? "border-red-500/40"
                      : "border-white/[0.08] focus:border-indigo-400/50",
                  )}
                  data-testid="settings-endpoint-input"
                />
                {url && !URL_RE.test(url.trim()) && (
                  <p className="text-[10px] text-red-400/70 mt-1">Enter a full URL (http:// or https://)</p>
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
                  className="w-full px-2.5 py-1.5 rounded-lg bg-white/[0.05] border border-white/[0.08]
                    text-[11px] font-mono text-white/80 placeholder-white/20 outline-none
                    focus:border-indigo-400/50 transition-colors"
                  data-testid="settings-key-input"
                />
              </div>

              {/* Status line */}
              {statusLine && <div className="flex items-center">{statusLine}</div>}

              <div className="flex items-center gap-1.5">
                <button onClick={handleSave}
                  disabled={saving}
                  data-testid="settings-save"
                  className={cn(
                    "flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors",
                    saving
                      ? "bg-white/[0.05] text-white/30 cursor-wait"
                      : "bg-indigo-500/[0.15] text-indigo-300 border border-indigo-500/30 hover:bg-indigo-500/[0.25]",
                  )}>
                  {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                  Save
                </button>
                <button onClick={handleTest}
                  disabled={testing || !url.trim() || !URL_RE.test(url.trim())}
                  data-testid="settings-test"
                  className={cn(
                    "flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] transition-colors border",
                    !url.trim() || !URL_RE.test(url.trim())
                      ? "border-white/[0.06] text-white/20 cursor-not-allowed"
                      : "border-white/[0.1] text-white/50 hover:text-white/80 hover:border-white/20",
                  )}>
                  {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : "Test"}
                </button>
                <button onClick={handleReset}
                  title="Delete settings.json — revert to .env / defaults"
                  className="p-1.5 rounded-lg text-white/25 hover:text-red-400/70 hover:bg-red-500/[0.06] transition-colors"
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
