import { describe, it, expect } from "vitest";
import type { Message } from "../lib/types";
import {
  latestRealUsage,
  estimateTokensFromChars,
  measureLiveSpeed,
  formatSpeedTps,
  formatTokenCount,
  meterText,
  meterTooltip,
  type TokenMeterSnapshot,
} from "../lib/chat/tokenMeter";

function assistantMsg(usage?: Message["usage"]): Message {
  return {
    id: "m1", conversationId: "c1", role: "assistant", content: "hi",
    reasoning: "", attachments: [], toolCalls: [], citations: [],
    usage, createdAt: 0, state: "complete", mode: "chat",
  } as Message;
}

function userMsg(): Message {
  return {
    id: "m0", conversationId: "c1", role: "user", content: "hello",
    reasoning: "", attachments: [], toolCalls: [], citations: [],
    createdAt: 0, state: "complete", mode: "chat",
  } as Message;
}

describe("latestRealUsage", () => {
  it("sums exact server prompt + completion tokens and takes server tps", () => {
    const msgs = [userMsg(), assistantMsg({ promptTokens: 4000, completionTokens: 542, tokensPerSecond: 42.5 })];
    expect(latestRealUsage(msgs)).toEqual({ used: 4542, tps: 42.5 });
  });

  it("walks back to the most recent assistant WITH usage", () => {
    const msgs = [
      assistantMsg({ promptTokens: 100, completionTokens: 10, tokensPerSecond: 30 }),
      assistantMsg(undefined),
    ];
    expect(latestRealUsage(msgs)).toEqual({ used: 110, tps: 30 });
  });

  it("treats a missing completionTokens as 0 and rejects non-positive tps", () => {
    const msgs = [assistantMsg({ promptTokens: 900 })];
    expect(latestRealUsage(msgs)).toEqual({ used: 900, tps: null });
    const msgs2 = [assistantMsg({ promptTokens: 900, completionTokens: 5, tokensPerSecond: 0 })];
    expect(latestRealUsage(msgs2)).toEqual({ used: 905, tps: null });
  });

  it("returns null when no message carries usage", () => {
    expect(latestRealUsage([userMsg(), assistantMsg()])).toBeNull();
    expect(latestRealUsage([])).toBeNull();
  });

  it("ignores user messages that somehow carry usage", () => {
    const u = { ...userMsg(), usage: { promptTokens: 1 } };
    expect(latestRealUsage([u])).toBeNull();
  });
});

describe("estimateTokensFromChars", () => {
  it("uses the shared ~4 chars/token heuristic (rounds up)", () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(4)).toBe(1);
    expect(estimateTokensFromChars(5)).toBe(2);
    expect(estimateTokensFromChars(400)).toBe(100);
  });
});

describe("measureLiveSpeed", () => {
  it("computes real tokens over real elapsed seconds", () => {
    expect(measureLiveSpeed(400, 2000)).toBeCloseTo(50, 6); // 100 tok / 2 s
    expect(measureLiveSpeed(80, 400)).toBeCloseTo(50, 6);
  });

  it("is null until there is something measurable", () => {
    expect(measureLiveSpeed(0, 5000)).toBeNull();
    expect(measureLiveSpeed(400, 50)).toBeNull(); // too short a window to be meaningful
  });
});

describe("formatSpeedTps / formatTokenCount", () => {
  it("formats two decimals; 56.449 rounds to 56.45", () => {
    expect(formatSpeedTps(56.449)).toBe("56.45");
    expect(formatSpeedTps(39.9)).toBe("39.90");
    expect(formatSpeedTps(143.724)).toBe("143.72");
  });

  it("null / non-positive / non-finite speed → em dash", () => {
    expect(formatSpeedTps(null)).toBe("—");
    expect(formatSpeedTps(0)).toBe("—");
    expect(formatSpeedTps(-3)).toBe("—");
    expect(formatSpeedTps(Number.NaN)).toBe("—");
  });

  it("token counts are raw integers; null → em dash", () => {
    expect(formatTokenCount(3456)).toBe("3456");
    expect(formatTokenCount(131072)).toBe("131072");
    expect(formatTokenCount(1234.6)).toBe("1235");
    expect(formatTokenCount(-1)).toBe("0");
    expect(formatTokenCount(null)).toBe("—");
  });
});

describe("meterText / meterTooltip", () => {
  const snap = (over: Partial<TokenMeterSnapshot>): TokenMeterSnapshot => ({
    maxContext: 131072, contextUsed: 3456, speedTps: 56.449,
    source: "exact", backendOk: true, ...over,
  });

  it("renders the requested layout", () => {
    expect(meterText(snap({}))).toBe("Speed: 56.45 tk/s · Context: 3456/131072");
  });

  it("renders honest dashes when the backend is offline", () => {
    expect(meterText(snap({ backendOk: false, contextUsed: null, speedTps: null, maxContext: null })))
      .toBe("Speed: — tk/s · Context: —/—");
  });

  it("tooltips describe provenance per source", () => {
    expect(meterTooltip(snap({}))).toContain("inference server");
    expect(meterTooltip(snap({ source: "measured" }))).toContain("Live stats");
    expect(meterTooltip(snap({ source: "estimate" }))).toContain("~4 chars/token");
    expect(meterTooltip(snap({ backendOk: false }))).toContain("unreachable");
  });
});
