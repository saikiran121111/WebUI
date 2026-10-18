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
          srcDoc={resumeHtml(spec)}
          sandbox=""
        />
      </div>
    </DocumentCard>
  );
}
