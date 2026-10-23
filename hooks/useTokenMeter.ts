"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Message } from "../lib/types";
import { estimateConversationTokens } from "../lib/chat/tokens";
import {
  latestRealUsage,
  estimateTokensFromChars,
  type TokenMeterSnapshot,
} from "../lib/chat/tokenMeter";

/**
 * Live token meter state for the composer footer.
 *
 * All data comes from the custom /api/model-stats endpoint and the chat
 * stream's own server-measured usage frames — never from hardcoded numbers.
 * While a reply streams we poll /api/model-stats?live=1 once per second (the
 * exact in-flight prompt size from the slot) and measure the real output rate
 * from real char counts over real poll windows; the instant the turn ends the
 * exact server usage takes over. Mirrors useChat's 1 s progress-tick pattern
 * so React state churn stays at ~1 Hz (never per-delta).
 */

interface LiveState {
  /** Exact in-flight prompt tokens from /slots (null = server didn't say). */
  promptTokens: number | null;
  /** Measured tokens of output received so far this turn. */
  outTokens: number;
  /** Measured output rate over recent poll windows (EMA-smoothed). */
  tps: number | null;
}

interface LiveWindowSample {
  chars: number;
  at: number;
}

const POLL_MS = 1000;
/** EMA weight of the newest 1 s window when smoothing the live rate. */
const RATE_EMA_ALPHA = 0.35;

export function useTokenMeter({ status, messages }: { status: string; messages: Message[] }): TokenMeterSnapshot {
  const [maxContext, setMaxContext] = useState<number | null>(null);
  const [backendOk, setBackendOk] = useState(false);
  const [live, setLive] = useState<LiveState | null>(null);

  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const smoothedTpsRef = useRef<number | null>(null);

  // Max context once per page load (cheap, zero inference cost).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/model-stats", { cache: "no-store" });
        const json = await res.json();
        if (cancelled) return;
        setBackendOk(json?.ok === true);
        if (json?.ok && typeof json.n_ctx === "number") setMaxContext(json.n_ctx);
      } catch {
        if (!cancelled) setBackendOk(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 1 Hz poll only while a reply is streaming; cleared on settle/unmount.
  useEffect(() => {
    if (status !== "streaming") { setLive(null); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let window: LiveWindowSample | null = null;

    const tick = async () => {
      const msgs = messagesRef.current;
      const last = msgs[msgs.length - 1];
      const streamingMsg = last && last.role === "assistant" ? last : null;
      const chars = streamingMsg
        ? (streamingMsg.content || "").length + (streamingMsg.reasoning || "").length
        : 0;

      // Real rate = real tokens ÷ real wall-clock between poll windows.
      const now = Date.now();
      if (window && chars > window.chars && now > window.at) {
        const inst = ((chars - window.chars) / 4) / ((now - window.at) / 1000);
        const prev = smoothedTpsRef.current;
        smoothedTpsRef.current =
          prev == null ? inst : prev * (1 - RATE_EMA_ALPHA) + inst * RATE_EMA_ALPHA;
      }
      window = { chars, at: now };

      let promptTokens: number | null = null;
      let slotCtx: number | null = null;
      try {
        const res = await fetch("/api/model-stats?live=1", { cache: "no-store" });
        const json = await res.json();
        if (json?.ok) {
          promptTokens = typeof json.prompt_tokens === "number" ? json.prompt_tokens : null;
          slotCtx = typeof json.n_ctx === "number" ? json.n_ctx : null;
        }
      } catch {
        /* honest fallback: the idle estimate is used for the prompt part */
      }
      if (cancelled) return;
      if (slotCtx != null) setMaxContext((prev) => prev ?? slotCtx);
      setLive({
        promptTokens,
        outTokens: estimateTokensFromChars(chars),
        tps: smoothedTpsRef.current,
      });
      timer = setTimeout(tick, POLL_MS);
    };

    smoothedTpsRef.current = null; // fresh measurement each turn
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [status]);

  return useMemo<TokenMeterSnapshot>(() => {
    if (status === "streaming" && live) {
      // history minus the in-flight assistant message, for the fallback path
      const rest = messages.length > 0 && messages[messages.length - 1].role === "assistant"
        ? messages.slice(0, -1)
        : messages;
      const used = live.promptTokens != null
        ? live.promptTokens + live.outTokens
        : estimateConversationTokens(rest) + live.outTokens;
      return {
        maxContext,
        contextUsed: used,
        speedTps: live.tps,
        source: live.promptTokens != null ? "measured" : "estimate",
        backendOk,
      };
    }

    // Idle (or streaming pre-first-tick): exact persisted usage if present.
    const real = latestRealUsage(messages);
    if (real) {
      return {
        maxContext,
        contextUsed: real.used,
        speedTps: real.tps ?? smoothedTpsRef.current,
        source: real.tps != null ? "exact" : "measured",
        backendOk,
      };
    }
    if (messages.length === 0) {
      return { maxContext, contextUsed: 0, speedTps: null, source: "exact", backendOk };
    }
    return {
      maxContext,
      contextUsed: estimateConversationTokens(messages),
      speedTps: smoothedTpsRef.current,
      source: "estimate",
      backendOk,
    };
  }, [status, live, messages, maxContext, backendOk]);
}
