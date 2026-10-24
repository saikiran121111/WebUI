"use client";
/**
 * ```browser_api fence renderer — the model's browser-control protocol.
 *
 * The model drives the interactive browser by emitting a fenced JSON
 * action; this block executes it against /api/browser on the server
 * (which owns the headful session), shows the result in a compact chip,
 * and records the outcome (lib/browser/panelState.ts) so the NEXT
 * turn's system context tells the model what actually happened.
 *
 * Execution is NOT tied to mount/unmount: the POST fires once per
 * assistant message (message-level guard via onSend-free module
 * registry) and runs to completion even if the component re-renders
 * during streaming. A cancelled/aborted component must not abort an
 * in-flight browser action — the server-side session outlives the
 * client, so aborting would leave the panel with no live tab.
 */
import { memo, useEffect, useState } from "react";
import { Check, X, Loader2, Globe } from "lucide-react";
import { extractBrowserApiFence, type BrowserApiAction } from "@/lib/browser/browserToolProtocol";
import { recordBrowserApiOutcome } from "@/lib/browser/panelState";

/**
 * Module-level dedup: which (source) strings fired a POST, and WHEN.
 * Survives component remounts (hot reload, list re-renders, streaming
 * re-mounts) so the same fence never double-fires *within the cooldown*
 * (React streaming/remount bursts), but the model may legitimately emit
 * the SAME command again in a later turn — e.g. clicking the same
 * "next page" button twice — and that must actually execute again, so
 * after the cooldown the fence fires afresh.
 */
const executedFences = new Map<string, number>();
const FIRE_COOLDOWN_MS = 1500;

interface BrowserApiBlockProps {
  /** The complete JSON body of the ```browser_api fence. */
  source: string;
  streaming?: boolean;
}

export default memo(function BrowserApiBlock({ source }: BrowserApiBlockProps) {
  // `engine` is the SERVER's answer for which browser ran the action —
  // never guessed client-side.
  const [state, setState] = useState<{ ok: boolean; error?: string; engine?: string } | null>(null);

  useEffect(() => {
    const fence = "```browser_api\n" + source + "\n```";
    const action: BrowserApiAction | null = extractBrowserApiFence(fence);
    if (!action) {
      setState({ ok: false, error: "unrecognized browser_api action — the model wrote an invalid fence" });
      return;
    }
    // Cooldown dedup (not permanent): rapid remounts of THIS fence are
    // suppressed, but the same fence body from a later turn re-executes.
    const lastFired = executedFences.get(source);
    if (lastFired !== undefined && Date.now() - lastFired < FIRE_COOLDOWN_MS) {
      // A previous mount already fired moments ago; restore the chip
      // state optimistically instead of double-firing the action.
      setState({ ok: true });
      return;
    }
    executedFences.set(source, Date.now());

    setState({ ok: true }); // in flight — the chip shows the action
    // No AbortController: the browser action must complete even if this
    // component unmounts (streaming re-renders). The server session is
    // the source of truth; abandoning the POST would orphan it.
    fetch("/api/browser", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action),
    })
      .then(async (res) => {
        const j = await res.json().catch(() => ({}));
        const ok = !!j?.ok;
        const error = typeof j?.error === "string" ? j.error : undefined;
        const engine = typeof j?.engine === "string" ? j.engine : undefined;
        setState({ ok, error, engine });
        recordBrowserApiOutcome({
          action: action.action,
          ...(action.url ? { url: action.url } : {}),
          ...(action.text ? { text: action.text.slice(0, 120) } : {}),
          ok,
          ...(error ? { error } : {}),
        });
      })
      .catch((e: unknown) => {
        const errText = e instanceof Error ? e.message : String(e);
        const friendly =
          /Failed to fetch|NetworkError|load failed|ECONNREFUSED|timeout/i.test(errText)
            ? "browser control endpoint unreachable — dev server not running or just reloaded; retry the action"
            : "browser action failed: " + errText;
        setState({ ok: false, error: friendly });
        recordBrowserApiOutcome({
          action: action.action,
          ...(action.url ? { url: action.url } : {}),
          ok: false,
          error: friendly,
        });
      });
  }, [source]);

  const label = state ? summarizeSource(source) : "reading fence…";

  return (
    <div
      data-testid="browser-api-block"
      data-state={state ? (state.ok && !state.error ? "done" : "error") : "pending"}
      data-engine={state?.engine ?? ""}
      className="flex items-center gap-2.5 px-3 py-2 rounded-lg mb-3
        bg-white/[0.03] border border-[rgba(255,255,255,0.09)]
        text-xs select-none"
    >
      {state === null ? (
        <Loader2 className="w-3.5 h-3.5 text-white/50 animate-spin" />
      ) : state.ok && !state.error ? (
        <Globe className="w-3.5 h-3.5 text-emerald-400/80" />
      ) : (
        <X className="w-3.5 h-3.5 text-red-400/80" />
      )}
      <span className="text-white/70 font-medium truncate max-w-[40rem]">{label}</span>
      {state?.error && (
        <span className="text-white/40 truncate max-w-[20rem]" title={state.error}>
          {state.error}
        </span>
      )}
      {state && !state.error && state.ok && (
        <Check className="w-3.5 h-3.5 text-white/40 ml-auto" />
      )}
    </div>
  );
});

/** "Opened https://… in the browser" style label from the fence body. */
function summarizeSource(source: string): string {
  const m = source.match(/"action"\s*:\s*"(\w+)"/);
  const a = m?.[1] ?? "browser action";
  const url = source.match(/"url"\s*:\s*"([^"]+)"/)?.[1];
  if (a === "navigate") {
    return url ? `Opened ${shortUrl(url)} in the browser` : "Navigating the browser";
  }
  return a[0].toUpperCase() + a.slice(1);
}

function shortUrl(u: string): string {
  try {
    const p = new URL(u, "https://x");
    const s = p.hostname.replace(/^www\./, "") + (p.pathname === "/" ? "" : p.pathname.slice(0, 24));
    return s.length > 48 ? s.slice(0, 48) + "…" : s;
  } catch {
    return u.length > 48 ? u.slice(0, 48) + "…" : u;
  }
}
