"use client";
/**
 * DOCX fence (PHASE 3): JSON document spec → Word file with embedded chart
 * screenshots. The preview mirrors the final layout client-side — headings,
 * bullets, tables and the SAME inline SVG charts (chartSvg is pure) that the
 * server screenshots at 2x for embedding, so the preview is WYSIWYG.
 */
import { useMemo } from "react";
import { normalizeDocx, safeName } from "../../lib/documents/schemas";
import { chartSvg } from "../../lib/documents/chartHtml";
import DocumentCard, { FenceBroken, FencePending } from "./DocumentCard";

export default function DocxBlock({ source, streaming }: { source: string; streaming: boolean }) {
  const spec = useMemo(() => {
    try {
      return normalizeDocx(JSON.parse(source));
    } catch {
      return null;
    }
  }, [source]);

  if (streaming) return <FencePending label="DOCX" />;
  if (!spec) return <FenceBroken label="docx" />;

  const filename = safeName(spec.filename) + ".docx";

  return (
    <DocumentCard badge="DOCX" filename={filename} endpoint="/api/documents/docx" spec={spec} testId="docx-block">
      <div className="docx-paper" data-testid="docx-preview">
        {spec.title && <h1 className="docx-title">{spec.title}</h1>}
        {spec.sections.map((s, i) => {
          if (s.type === "heading") {
            const Tag = ("h" + Math.min(4, s.level)) as "h1" | "h2" | "h3" | "h4";
            return <Tag key={i} className={"docx-h docx-h" + s.level}>{s.text}</Tag>;
          }
          if (s.type === "paragraph") return <p key={i} className="docx-p">{s.text}</p>;
          if (s.type === "bullets") {
            return (
              <ul key={i} className="docx-ul">
                {s.items.map((b, j) => <li key={j}>{b}</li>)}
              </ul>
            );
          }
          if (s.type === "table") {
            return (
              <table key={i} className="docx-table">
                {s.headers.length > 0 && (
                  <thead><tr>{s.headers.map((h, j) => <th key={j}>{h}</th>)}</tr></thead>
                )}
                <tbody>
                  {s.rows.map((r, j) => (
                    <tr key={j}>{r.map((c, k) => <td key={k}>{c}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            );
          }
          // chart
          return (
            <figure key={i} className="docx-chart">
              {s.title && <figcaption className="docx-chart-title">{s.title}</figcaption>}
              <div
                className="docx-chart-svg"
                // chartSvg emits a self-contained static <svg> string (pure TS,
                // no user scripts) — safe to inline.
                dangerouslySetInnerHTML={{ __html: chartSvg(s.chart, { width: 620, height: 320, theme: "light" }) }}
              />
            </figure>
          );
        })}
      </div>
    </DocumentCard>
  );
}
