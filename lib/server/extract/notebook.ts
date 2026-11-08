/**
 * Jupyter notebook → readable text. Never executes code — we read the stored
 * outputs exactly as the file recorded them.
 *
 * I08: v4 output MIME bundles (execute_result/display_data `.data` maps,
 * stream text, error tracebacks) used to be invisible, outputs were silently
 * sliced at 2000 chars, and a null cell crashed the whole parse. Every output
 * kind the format defines is now rendered (base64 blobs are LABELLED, never
 * dumped as text), truncation is announced instead of silent, and v3 /
 * malformed files produce an honest diagnostic prefix.
 */

const MAX_OUTPUT_CHARS = 20_000; // per output block; announced when applied

function joinSource(src: unknown): string {
  if (Array.isArray(src)) return src.map((s) => String(s)).join("");
  return String(src ?? "");
}

function joinMultiline(v: unknown): string | null {
  if (v == null) return null;
  // application/json outputs store a real JSON value (object/array), not a
  // string — String(v) would print "[object Object]" and destroy the payload.
  const one = (x: unknown) => (x !== null && typeof x === "object" ? JSON.stringify(x) : String(x));
  const s = Array.isArray(v) ? v.map(one).join("") : one(v);
  return s.length ? s : null;
}

function renderDataBundle(data: Record<string, unknown>, label: string, meta?: unknown): string[] {
  const out: string[] = [];
  const exec = (meta as any)?.execution;
  if (exec?.execution_count != null) out.push(`${label} [cell ${exec.execution_count}]:`);
  else out.push(`${label}:`);
  for (const [mime, raw] of Object.entries(data)) {
    const text = joinMultiline(raw);
    if (text == null) continue;
    if (mime === "text/plain" || mime === "text/markdown") {
      out.push(text);
    } else if (mime === "application/json") {
      // Already a JSON literal in the notebook text; pass it through as-is.
      out.push(`[JSON output]\n${text}`);
    } else if (mime === "text/html") {
      // Strip markup to readable text but SAY it was HTML so the reader knows.
      const stripped = text
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&[a-z]+;/gi, " ")
        .replace(/[ \t]+\n/g, "\n")
        .trim();
      out.push(`[HTML output — markup removed]\n${stripped}`);
    } else if (mime === "image/svg+xml") {
      out.push(`[SVG image output — vector markup, ${text.length} chars — not rendered here]`);
    } else if (mime.startsWith("image/") || mime.startsWith("application/pdf") || mime.startsWith("audio/") || mime.startsWith("video/")) {
      out.push(`[${mime} output: ${text.length} chars of base64 — binary, not readable as text]`);
    } else if (mime.startsWith("text/") || mime === "application/javascript") {
      out.push(`[${mime} output]\n${text}`);
    } else {
      out.push(`[${mime} output skipped — no text rendering for this MIME]`);
    }
  }
  return out;
}

function renderOutput(o: any): string[] {
  const kind = String(o?.output_type ?? "");
  const blocks: string[] = [];
  if (kind === "stream") {
    const t = joinMultiline(o.text);
    if (t) blocks.push(`--- output (${o.name === "stderr" ? "stderr" : "stdout"}) ---\n${capBlock(t)}`);
  } else if (kind === "error") {
    const ename = String(o.ename ?? "Error");
    const evalue = String(o.evalue ?? "");
    const tb = Array.isArray(o.traceback) ? o.traceback.join("\n") : "";
    blocks.push(`--- output (error: ${ename}: ${evalue}) ---\n${capBlock(tb)}`);
  } else if (kind === "execute_result" || kind === "display_data") {
    const data = o.data && typeof o.data === "object" ? o.data : {};
    const rendered = renderDataBundle(data, kind === "execute_result" ? "result" : "display");
    // The cap rides on each payload part (never the whole assembled block),
    // so the truncation announcement can't be cut off by a second cap.
    if (rendered.length) blocks.push(`--- output ---\n${rendered.map((s, i) => (i === 0 ? s : capBlock(s))).join("\n")}`);
  }
  if (!blocks.length && kind) blocks.push(`--- output (${kind || "unknown"}) skipped — no text content recognized ---`);
  return blocks;
}

function capBlock(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return `${s.slice(0, MAX_OUTPUT_CHARS)}\n[…output truncated at ${MAX_OUTPUT_CHARS} chars of ${s.length} — the notebook stored more…]`;
}

export function notebookText(json: string): string {
  let nb: any;
  try {
    nb = JSON.parse(json);
  } catch {
    return "[Notebook not readable: the file is not valid JSON. It may be truncated or corrupted.]";
  }
  if (!nb || typeof nb !== "object") {
    return "[Notebook not readable: expected a JSON object, found something else.]";
  }
  const major = Number(nb.nbformat);
  if (Number.isFinite(major) && major < 4) {
    // v3 nested "output" objects have a different shape; parse conservatively.
    return renderNotebook(nb, `[notebook format v${major} — pre-v4 layout, converted best-effort]`);
  }
  return renderNotebook(nb, "");
}

function renderNotebook(nb: any, header: string): string {
  const rawCells: any[] = Array.isArray(nb.cells) ? nb.cells : [];
  const blocks: string[] = header ? [header] : [];
  let skipped = 0;
  rawCells.forEach((c, i) => {
    if (!c || typeof c !== "object") { skipped++; return; }
    const src = joinSource(c.source);
    const kind = c.cell_type === "markdown" ? "markdown"
      : c.cell_type === "raw" ? "raw"
      : "code";
    let block = `### [${kind}]${c.cell_type === "code" && c.execution_count != null ? ` #In[${c.execution_count}]` : ""}\n${src}`;
    const outs: any[] = Array.isArray(c.outputs) ? c.outputs : [];
    for (const o of outs) {
      // Payloads are capped inside renderOutput; capping here too could cut
      // the announcement line that capBlock itself appends.
      for (const b of renderOutput(o)) block += `\n${b}`;
    }
    if (!src.trim() && !outs.length) block += "\n(empty cell)";
    blocks.push(block);
    void i;
  });
  if (skipped) blocks.push(`[${skipped} malformed cell(s) skipped]`);
  if (!rawCells.length) blocks.push("[No cells found in this notebook]");
  return blocks.join("\n\n");
}
