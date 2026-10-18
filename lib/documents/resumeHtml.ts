/**
 * Resume pipeline (PHASE 3): resume-builder JSON → ATS-friendly single-column
 * semantic HTML → A4 PDF via the PDF engine. Real text only — no columns,
 * tables, graphics or icons — so ATS parsers read every section. The
 * .resume-section-item class is covered by the mandatory print CSS
 * break-inside:avoid, so no job entry is ever sliced across pages.
 */
import type { ResumeSpec } from "./schemas";

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function resumeHtml(spec: ResumeSpec): string {
  const b = spec.basics;
  const contact = [b.email, b.phone, b.location, ...b.links.map((l) => l.url)].filter(Boolean).map(esc).join("  ·  ");
  const sections = spec.sections
    .filter((s) => s.items.length || s.title)
    .map((s) => {
      const items = s.items
        .map((it) => {
          const head = [it.heading, it.subheading].filter(Boolean).map(esc).join(" — ");
          const meta = it.dateLocation ? `<span class="resume-meta">${esc(it.dateLocation)}</span>` : "";
          const kw = it.keywords.length ? `<p class="resume-keywords"><strong>Keywords:</strong> ${it.keywords.map(esc).join(", ")}</p>` : "";
          const bullets = it.bullets.length ? `<ul>${it.bullets.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
          return `<div class="resume-section-item">${head ? `<p class="resume-item-head">${head}${meta}</p>` : ""}${kw}${bullets}</div>`;
        })
        .join("");
      return `<section class="resume-section"><h2>${esc(s.title)}</h2>${items}</section>`;
    })
    .join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${esc(b.name)} — Resume</title>
<style>
  body { font-family: Calibri, "Segoe UI", Arial, sans-serif; color: #111827; }
  .resume-name { font-size: 20pt; font-weight: 700; margin: 0; letter-spacing: 0.2pt; }
  .resume-title { font-size: 12pt; color: #111827; margin: 2pt 0 0; }
  .resume-contact { font-size: 9.5pt; color: #374151; margin: 4pt 0 0; }
  .resume-section h2 { font-size: 11.5pt; text-transform: uppercase; letter-spacing: 0.6pt; border-bottom: 1px solid #9ca3af; padding-bottom: 2pt; margin: 12pt 0 6pt; }
  .resume-section-item { margin: 0 0 8pt; }
  /* Flex row (not float): heading left, date/location right on the SAME line,
     so each certification/job's meta can never wrap under the next entry. */
  .resume-item-head { margin: 0; font-weight: 700; display: flex; justify-content: space-between; gap: 10pt; align-items: baseline; }
  .resume-meta { flex: 0 1 auto; text-align: right; font-weight: 400; color: #374151; font-size: 9.5pt; }
  .resume-keywords { margin: 2pt 0; font-size: 9.5pt; color: #374151; }
  ul { margin: 2pt 0 0; padding-left: 16pt; }
  li { margin: 0 0 2pt; }
</style>
</head>
<body>
<header class="resume-section-item">
  <p class="resume-name">${esc(b.name)}</p>
  ${b.title ? `<p class="resume-title">${esc(b.title)}</p>` : ""}
  ${contact ? `<p class="resume-contact">${contact}</p>` : ""}
</header>
${b.summary ? `<section class="resume-section"><h2>Summary</h2><div class="resume-section-item"><p>${esc(b.summary)}</p></div></section>` : ""}
${sections}
</body>
</html>`;
}
