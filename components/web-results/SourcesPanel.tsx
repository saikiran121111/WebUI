"use client";
/**
 * SourcesPanel.tsx — §67 SourceCard + SourcesPanel. U5 grouping law:
 * sources cluster BY DOMAIN with a per-host count, and sources the answer
 * actually CITED ([S#] markers present in the content) sort above sources
 * that were merely consulted. Every string is re-read defensively client
 * side (§60/§12 law: retrieved text is untrusted display data).
 */
import { memo, useMemo, useState } from "react";
import { citationMarkers } from "../render/citations";
import { Sheet } from "./ResultOverlays";
import { hostOf, safeUrl, str } from "./resultHelpers";
import type { CitationEntryLite } from "./richResultContext";

export const SourceCard = memo(function SourceCard({ entry }: { entry: CitationEntryLite }) {
  const url = safeUrl(entry.url);
  const meta = [
    str(entry.publishedAt, 40) ? `Published ${str(entry.publishedAt, 40)}` : "",
    entry.sourceId ?? "",
  ].filter(Boolean);
  return (
    <a className="wr-src-card" href={url} target={url ? "_blank" : undefined} rel="noopener noreferrer"
      data-testid="source-card" aria-label={str(entry.title, 160) ?? entry.domain}>
      <span className="wr-src-title">{str(entry.title, 160) ?? entry.domain ?? hostOf(entry.url ?? "")}</span>
      <span className="wr-src-meta">{meta.join(" · ")}</span>
    </a>
  );
});

export const SourcesPanel = memo(function SourcesPanel({
  citationMap,
  content,
}: {
  citationMap: Record<string, CitationEntryLite>;
  content?: string;
}) {
  const groups = useMemo(() => {
    const ids = Object.keys(citationMap ?? {});
    const cited = content ? citationMarkers(content) : null;
    const sorted = ids.slice().sort((a, b) => {
      if (cited) {
        const ca = cited.has(a) ? 0 : 1, cb = cited.has(b) ? 0 : 1;
        if (ca !== cb) return ca - cb;
      }
      return a.localeCompare(b, "en", { numeric: true });
    });
    const byDomain = new Map<string, CitationEntryLite[]>();
    for (const id of sorted) {
      const e = citationMap[id];
      if (!e) continue;
      const domain = str(e.domain, 100) || hostOf(e.url ?? "") || id;
      const list = byDomain.get(domain) ?? [];
      list.push({ ...e, sourceId: e.sourceId ?? id });
      byDomain.set(domain, list);
    }
    return Array.from(byDomain.entries());
  }, [citationMap, content]);

  if (!groups.length) return <div className="wr-empty">No sources recorded.</div>;
  return (
    <div className="wr-sources" data-testid="sources-panel">
      {groups.map(([domain, entries]) => (
        <section key={domain} className="wr-src-group">
          <header className="wr-src-head">
            <span>{domain}</span>
            <span className="wr-src-count" aria-label={`${entries.length} source${entries.length === 1 ? "" : "s"} from ${domain}`}>
              {entries.length}
            </span>
          </header>
          {entries.map((e, i) => <SourceCard key={i} entry={e} />)}
        </section>
      ))}
    </div>
  );
});

/** Message-level affordance: "Sources (N)" opens the panel in a sheet. */
export const SourcesFooter = memo(function SourcesFooter({
  citationMap,
  content,
}: {
  citationMap: Record<string, CitationEntryLite>;
  content?: string;
}) {
  const n = Object.keys(citationMap ?? {}).length;
  const [open, setOpen] = useState(false);
  if (!n) return null;
  return (
    <>
      <button type="button" className="wr-action" data-testid="sources-footer"
        aria-haspopup="dialog" aria-expanded={open} aria-label={`Open sources (${n})`}
        onClick={() => setOpen(true)}>
        Sources ({n})
      </button>
      {open && (
        <Sheet title={`Sources (${n})`} onClose={() => setOpen(false)}>
          <SourcesPanel citationMap={citationMap} content={content} />
        </Sheet>
      )}
    </>
  );
});
