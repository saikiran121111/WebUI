"use client";
/**
 * In-app login browser panel (Part 3).
 *
 * Mirrors the headful persistent Chromium window (CDP screencast via
 * /api/browser/stream) into a resizable right split beside the chat, and
 * sends pointer/keyboard input back through /api/browser. "Logged In —
 * Continue AI Search" performs the cookie hand-off (done_login) and closes
 * the panel; the page then re-asks the question with the authenticated URL
 * through a normal chat turn, and the extractor's browser pool rides the
 * signed-in session.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { X, ArrowLeft, RotateCw, LogIn, Send } from "lucide-react";
import { cn } from "../lib/utils";

interface RightBrowserPanelProps {
  /** Set when auto-opened on web:auth_required — the panel navigates there. */
  initialUrl?: string;
  onClose: () => void;
  /** After done_login: page sends the continuation chat turn. */
  onLoggedIn: (url: string, title: string) => void;
}

const ghost =
  "w-7 h-7 rounded-md flex items-center justify-center text-white/55 " +
  "hover:text-white/90 hover:bg-white/[0.05] transition-colors duration-[120ms]";

export default function RightBrowserPanel({ initialUrl, onClose, onLoggedIn }: RightBrowserPanelProps) {
  const [width, setWidth] = useState(560);
  const [address, setAddress] = useState(initialUrl ?? "");
  const [liveUrl, setLiveUrl] = useState("");
  const [liveTitle, setLiveTitle] = useState("");
  const [connected, setConnected] = useState(false);
  const [note, setNote] = useState("Opening the sign-in browser…");
  const [typed, setTyped] = useState("");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  const post = useCallback(async (body: Record<string, unknown>): Promise<any> => {
    try {
      const res = await fetch("/api/browser", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (j && typeof j.error === "string") setNote(j.error);
      return j ?? { ok: false };
    } catch {
      setNote("Browser control endpoint unreachable — is the dev server running?");
      return { ok: false };
    }
  }, []);

  const drawFrame = useCallback((b64: string) => {
    const c = canvasRef.current;
    if (!c) return;
    const img = new window.Image();
    img.onload = () => {
      const cur = canvasRef.current;
      if (!cur) return;
      if (cur.width !== img.naturalWidth || cur.height !== img.naturalHeight) {
        cur.width = img.naturalWidth;
        cur.height = img.naturalHeight;
      }
      cur.getContext("2d")?.drawImage(img, 0, 0);
    };
    img.src = `data:image/jpeg;base64,${b64}`;
  }, []);

  // Screencast mirror. Opening the EventSource launches the headful session
  // server-side; frames stop flowing automatically when this closes.
  useEffect(() => {
    const es = new EventSource("/api/browser/stream");
    es.onopen = () => setConnected(true);
    es.onmessage = (m) => {
      let f: any;
      try { f = JSON.parse(m.data); } catch { return; }
      if (f.ping) return;
      setConnected(true);
      if (typeof f.error === "string") { setNote(f.error); return; }
      if (typeof f.url === "string") setLiveUrl(f.url);
      if (typeof f.title === "string") setLiveTitle(f.title);
      if (typeof f.frame === "string") drawFrame(f.frame);
    };
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [drawFrame]);

  // Targeted open (web:auth_required auto-open) — navigate once mounted.
  useEffect(() => {
    void post({ action: "start", ...(initialUrl ? { url: initialUrl } : {}) });
  }, [initialUrl, post]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvasRef.current;
    if (!c || !c.width) return;
    const rect = c.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    void post({
      action: "click",
      x: Math.round((e.clientX - rect.left) * (c.width / rect.width)),
      y: Math.round((e.clientY - rect.top) * (c.height / rect.height)),
    });
  }, [post]);

  const sendKeys = useCallback((text: string, submit: boolean) => {
    if (!text) return;
    setTyped("");
    void post({ action: "type", text, submit });
  }, [post]);

  const doneLogin = useCallback(async () => {
    const r = await post({ action: "done_login" });
    if (r?.ok) onLoggedIn(String(r.url ?? liveUrl), String(r.title ?? liveTitle));
  }, [post, onLoggedIn, liveUrl, liveTitle]);

  return (
    <aside
      data-testid="browser-panel"
      role="complementary"
      aria-label="Login browser"
      className="relative flex-shrink-0 flex flex-col border-l border-[var(--border)] bg-[var(--bg-elevated)]"
      style={{ width }}
    >
      {/* Resize grip — left edge, clamped between 360px and the workspace. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize browser panel"
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture(e.pointerId);
          dragRef.current = { startX: e.clientX, startW: width };
        }}
        onPointerMove={(e) => {
          if (!dragRef.current) return;
          const max = Math.min(900, (typeof window !== "undefined" ? window.innerWidth : 1440) - 460);
          const next = dragRef.current.startW - (e.clientX - dragRef.current.startX);
          setWidth(Math.max(360, Math.min(max, next)));
        }}
        onPointerUp={() => { dragRef.current = null; }}
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-10 hover:bg-white/10 transition-colors duration-[120ms]"
      />

      {/* Header: live page identity + close */}
      <div className="flex items-center gap-2 px-3 h-9 border-b border-[var(--border)]">
        <span className="text-[12px] font-medium text-white/80 truncate flex-1">
          {liveTitle || "Sign-in browser"}
        </span>
        <span
          className={cn(
            "w-1.5 h-1.5 rounded-full flex-shrink-0",
            connected ? "bg-emerald-400/80" : "bg-white/25",
          )}
          title={connected ? "Mirrored" : "Reconnecting…"}
        />
        <button onClick={onClose} className={ghost} aria-label="Close browser panel" title="Close">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Address + nav row */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (address.trim()) void post({ action: "navigate", url: address.trim() });
        }}
        className="flex items-center gap-1 px-2 py-1.5 border-b border-[var(--border)]"
      >
        <button type="button" onClick={() => void post({ action: "back" })} className={ghost} aria-label="Browser back" title="Back">
          <ArrowLeft className="w-3.5 h-3.5" />
        </button>
        <button type="button" onClick={() => void post({ action: "reload" })} className={ghost} aria-label="Reload page" title="Reload">
          <RotateCw className="w-3.5 h-3.5" />
        </button>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Sign in to a site here…"
          aria-label="Browser address"
          spellCheck={false}
          className="flex-1 min-w-0 h-7 px-2.5 rounded-md text-[12px] text-white/85
            bg-white/[0.04] border border-[var(--border)] outline-none
            focus:border-white/25 transition-colors duration-[120ms]"
        />
      </form>

      {/* Live viewport mirror */}
      <div className="flex-1 min-h-0 relative" style={{ aspectRatio: "1280 / 800" }}>
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onWheel={(e) => void post({ action: "scroll", dy: e.deltaY })}
          className="absolute inset-0 w-full h-full bg-black/30 cursor-crosshair select-none"
          aria-label="Mirrored browser viewport"
        />
        {(!liveUrl || note) && (
          <div className="absolute inset-x-3 bottom-3 px-3 py-2 rounded-lg surface-glass
            text-[11px] text-white/70 pointer-events-none">
            {note}
          </div>
        )}
      </div>

      {/* Keyboard bridge (login fields keep focus by clicking the mirror) */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-t border-[var(--border)]">
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); sendKeys(typed, true); } }}
          placeholder="Type into the page (Enter = submit)"
          aria-label="Text to type into the page"
          className="flex-1 min-w-0 h-7 px-2.5 rounded-md text-[12px] text-white/85
            bg-white/[0.04] border border-[var(--border)] outline-none
            focus:border-white/25 transition-colors duration-[120ms]"
        />
        <button onClick={() => sendKeys(typed, false)} className={ghost} aria-label="Send keys to page" title="Send keys">
          <Send className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Login hand-off */}
      <div className="px-2 pb-2">
        <button
          onClick={() => void doneLogin()}
          className="w-full h-8 flex items-center justify-center gap-2 rounded-lg text-[12px] font-medium
            bg-white/[0.07] hover:bg-white/[0.12] text-white/90 border border-white/10
            transition-colors duration-[150ms]"
        >
          <LogIn className="w-3.5 h-3.5" />
          Logged In — Continue AI Search
        </button>
        <p className="mt-1.5 text-[10px] text-white/40 text-center leading-snug">
          Signs the AI reader into the tab you just authenticated. The browser profile stays in .data.
        </p>
      </div>
    </aside>
  );
}
