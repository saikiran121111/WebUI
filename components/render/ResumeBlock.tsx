"use client";
/**
 * Resume fence (PHASE 3): resume-builder JSON → ATS-compliant 1–2 page PDF.
 * The preview renders the EXACT printable HTML the server feeds to Chromium
 * (resumeHtml is pure/client-safe), so what you see is literally what the
 * PDF contains. Download POSTs the normalized spec to /api/documents/resume.
 */
import { useMemo } from "react";
import { normalizeResume, safeName } from "../../lib/documents/schemas";
import { resumeHtml } from "../../lib/documents/resumeHtml";
import DocumentCard, { FenceBroken, FencePending } from "./DocumentCard";

/**
 * PREVIEW-ONLY overrides injected into the iframe srcDoc: the app chrome is
 * dark, so the paper matches it (dark canvas, light ink) instead of glaring
 * white. The DOWNLOAD path never sees this — resumeHtml output goes to the
 * print engine untouched, so the PDF stays professional white-on-paper.
 * The padding mirrors the print @page 14mm margins so the preview shows the
 * real edge spacing instead of text hugging the paper borders.
 */
const PREVIEW_CSS =
  "<style>" +
  "html,body{background:#141414!important;color:#E4E4E7!important}" +
  "body{margin:0!important;padding:44px 48px!important}" +
  ".resume-title{color:#E4E4E7!important}" +
  ".resume-contact,.resume-meta,.resume-keywords{color:#A1A1AA!important}" +
  ".resume-section h2{color:#FAFAFA!important;border-bottom-color:#3F3F46!important}" +
  "</style>";

export default function ResumeBlock({ source, streaming }: { source: string; streaming: boolean }) {
  const spec = useMemo(() => {
    try {
      return normalizeResume(JSON.parse(source));
    } catch {
      return null;
    }
  }, [source]);

  if (streaming) return <FencePending label="resume" chars={source.length} />;
  if (!spec) return <FenceBroken label="resume" />;

  const filename = safeName(spec.basics.name) + "_Resume.pdf";
  const srcDoc = resumeHtml(spec).replace(/<\/head>/i, PREVIEW_CSS + "</head>");

  return (
    <DocumentCard
      badge="RESUME"
      filename={filename}
      endpoint="/api/documents/resume"
      spec={spec}
      testId="resume-block"
    >
      <div className="resume-paper-wrap">
        <iframe
          title="Resume preview"
          className="resume-paper"
          srcDoc={srcDoc}
          sandbox=""
        />
      </div>
    </DocumentCard>
  );
}
