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
  researchLfm?: Message["researchLfm"];
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

  const rawLfm = headers.get("X-Research-Lfm");
  if (rawLfm) {
    try { out.researchLfm = JSON.parse(decodeURIComponent(rawLfm)); } catch { /* */ }
  }

  return out;
}

/** Tool definitions injected when the user selects research mode. */
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
