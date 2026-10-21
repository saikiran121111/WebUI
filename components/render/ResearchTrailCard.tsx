import {
  ChevronDown,
  ChevronUp,
  Search,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import type { Message } from "../../lib/types";

/**
 * The research trail card shown above an assistant reply when the main-model
 * web-search pipeline ran. Since 2026-10-22 it is a clean source list —
 * NOT a verification adjudication:
 *
 *   header   — "Web research" + the gate summary (which queries ran)
 *   sources  — one row per [S#] source: its title, domain, and the link
 *   queries  — the queries the main model actually searched
 *
 * The old version stamped per-source verdicts ("Existence Unverified",
 * "News or editorial article — it may quote a price, it cannot confirm
 * stock") and per-claim badges. That UI language made ordinary searches
 * look broken, so it was removed: a source is a source, the [S#] pills in
 * the answer cite it, and the model says honestly when it could not
 * confirm something. The testids `research-trail-card` / `-toggle` /
 * `-gate-badge` / `-source` / `-claims` stay as the Playwright contract.
 */

/** Which authority decided for this turn → the badge the user sees. */
const GATE_BADGE: Record<string, string> = {
  "main-model": "Model-gated",
  lfm: "LFM-gated", // historical — no new turns use this label
  rules: "Rule-gated",
};

interface SourceRow {
  sourceId: string;
  url: string;
  title: string;
  domain: string;
  publishedAt?: string;
}

export default function ResearchTrailCard({ message }: { message: Message }) {
  const [expanded, setExpanded] = useState(false);
  const webCitations = message.webCitations;
  if (!webCitations) return null;

  // Render order: the trail reads S1, S2, … so it lines up with the [S#]
  // markers in the answer.
  const entries = Object.values(webCitations)
    .filter((e): e is SourceRow & { sourceId: string } => !!e && typeof e.url === "string")
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId, undefined, { numeric: true }));
  if (entries.length === 0) return null;

  const domains = new Set(entries.map((e) => e.domain));
  const gate = message.researchLfm;

  return (
    <div
      className="mb-3 rounded-lg border border-[#38E8FF]/15 bg-[#38E8FF]/[0.03] overflow-hidden"
      data-testid="research-trail-card"
    >
      {/* Header row: what was searched + who let the search through */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left
          hover:bg-white/[0.02] transition-colors"
        aria-expanded={expanded}
        data-testid="research-trail-toggle"
      >
        <Search className="w-3.5 h-3.5 text-[#38E8FF] flex-shrink-0" />
        <span className="text-xs font-medium text-white/70 flex-1 min-w-0 truncate">
          Web research
          <span className="text-white/40 font-normal">
            {" · "}
            {entries.length} source{entries.length !== 1 ? "s" : ""}
            {domains.size > 1 ? ` · ${domains.size} domains` : ""}
          </span>
        </span>
        {gate && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded
            bg-[#38E8FF]/10 text-[#38E8FF] font-medium"
            data-testid="research-trail-gate-badge"
          >
            {GATE_BADGE[gate.decidedBy ?? "main-model"] ?? "Gated"}
          </span>
        )}
        {expanded ? (
          <ChevronUp className="w-3.5 h-3.5 text-white/30" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-white/30" />
        )}
      </button>

      {expanded && (
        <>
          {/* The queries the main model actually ran */}
          {gate && gate.queries.length > 0 && (
            <div className="px-3 py-2 border-t border-white/[0.04] text-[11px] text-white/40 space-y-0.5">
              {gate.queries.map((q, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <span className="text-white/25 font-mono flex-shrink-0 mt-px">Q{i + 1}</span>
                  <span className="text-white/55">{q.query}</span>
                  <span className="text-white/25 text-[10px] flex-shrink-0">({q.intent})</span>
                </div>
              ))}
              {gate.depth && (
                <div className="text-white/30">
                  depth: <span className="text-white/50">{gate.depth}</span>
                  {" · "}freshness:{" "}
                  <span className="text-white/50">{gate.freshness}</span>
                </div>
              )}
            </div>
          )}

          {/* Sources: one clean row each, S1..Sn in order */}
          <div className="px-3 pt-2 border-t border-white/[0.04]">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-white/55">
              <Search className="w-3.5 h-3.5 text-white/40" />
              <span>Sources</span>
              <span className="ml-auto text-white/30 font-normal">
                {entries.length} source{entries.length !== 1 ? "s" : ""}
              </span>
            </div>
          </div>
          <div className="px-3 py-2 space-y-1.5">
            {entries.map((entry) => (
              <div
                key={entry.sourceId}
                className="flex items-start gap-2 p-1.5 rounded-md hover:bg-white/[0.03] transition-colors group/src"
                data-testid="research-trail-source"
              >
                <div className="flex-1 min-w-0">
                  <a
                    href={entry.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] text-white/75 group-hover/src:text-white/95"
                  >
                    <span className="font-mono text-[10px] text-[#38E8FF]/60 mr-1">
                      [{entry.sourceId}]
                    </span>
                    {entry.title || entry.domain}
                  </a>
                  <div className="text-[10px] text-white/35 mt-0.5">
                    {entry.domain}
                    {entry.publishedAt ? ` · ${entry.publishedAt.slice(0, 10)}` : ""}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
