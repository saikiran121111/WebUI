/** Jupyter notebook → readable text (markdown + code cells, outputs trimmed). */
export function notebookText(json: string): string {
  const nb = JSON.parse(json);
  const cells: any[] = Array.isArray(nb.cells) ? nb.cells : [];
  return cells.map(c => {
    const src = Array.isArray(c.source) ? c.source.join("") : String(c.source ?? "");
    const kind = c.cell_type === "markdown" ? "markdown" : "code";
    let block = `### [${kind}]\n${src}`;
    const outs: any[] = Array.isArray(c.outputs) ? c.outputs : [];
    for (const o of outs) {
      const txt = Array.isArray(o.text) ? o.text.join("") : String(o.text ?? "");
      if (txt.trim()) block += `\n--- output ---\n${txt.slice(0, 2000)}`;
    }
    return block;
  }).join("\n\n");
}
