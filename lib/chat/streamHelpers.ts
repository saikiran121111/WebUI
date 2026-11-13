/**
 * SSE header decoding + tool-def builders extracted from hooks/useChat.ts
 * so the hook stays under 220 lines and the parsing logic is testable in
 * isolation (no React, no fetch).
 */
import { isRendererMode, type RendererMode } from "../decision/types";
import type { Message } from "../types";

export interface DecodedSseHeaders {
  decisionMode?: RendererMode;
  skill?: string;
  webCitations?: Message["webCitations"];
  searchGate?: Message["searchGate"];
  /** @deprecated pre-rename header reader — kept for older responses. */
  researchLfm?: Message["searchGate"];
}

/**
 * Decode the metadata headers that ride back on the /api/chat SSE stream.
 *
 * `headers` is the raw `Headers` object passed to the onHeaders callback
 * by `ChatClient.chat()`.  The two citation fields are URL-encoded JSON;
 * a malformed header simply omits that field rather than throwing.
 */
export function decodeSseHeaders(
  headers: Headers,
): DecodedSseHeaders {
  const out: DecodedSseHeaders = {};

  const mode = headers.get("x-decision-mode");
  if (mode && isRendererMode(mode)) out.decisionMode = mode;

  const skill = headers.get("X-Used-Skill");
  if (skill) out.skill = skill;

  const raw = headers.get("X-Web-Citations");
  if (raw) {
    try { out.webCitations = JSON.parse(decodeURIComponent(raw)); } catch { /* */ }
  }

  const rawGate = headers.get("X-Search-Gate") ?? headers.get("X-Research-Lfm");
  if (rawGate) {
    try { out.searchGate = JSON.parse(decodeURIComponent(rawGate)); } catch { /* */ }
  }

  return out;
}

/** Tool definitions injected when the user selects research mode. */
/**
 * §3 activity-closure law (2026-11-13 brief): every `web:activity` entry a
 * "started" frame opened must CLOSE when the turn ends. Engines pair a
 * terminal frame per action, but a user cancel / stream error / dropped
 * connection leaves the in-flight action's terminal frame unsent — this
 * stamps the honest closure on any entry still open, so a live "Searching…"
 * line can never outlive its turn.
 *
 * Statuses are the renderer's existing vocabulary (`ProcessingStatus`
 * activityLine): "cancelled" = the user stopped the turn; "interrupted" =
 * the stream ended while the action was unresolved. Idempotent: returns the
 * SAME list reference when nothing is open (no spurious re-render objects).
 */
export function closeOpenActivityEntries<T extends { status: string }>(
  list: T[] | undefined,
  status: "cancelled" | "interrupted",
): T[] | undefined {
  if (!list || !list.some((a) => a.status === "started")) return list;
  return list.map((a) => (a.status === "started" ? { ...a, status } : a));
}

export function buildResearchToolDefs(): any[] {
  return [
    {
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web via SearXNG and return ranked results.",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "Search query" } },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "web_open",
        description: "Open a URL and return rendered text content.",
        parameters: {
          type: "object",
          properties: { url: { type: "string" } },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browser_screenshot",
        description: "Take a screenshot of the current browser page.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
  ];
}
