import type { CadEntity, CadSpec } from "./cadSchema";
import { specBBox } from "./cad2d";

/**
 * ISO/ANSI-style title-block PDF built by hand (no libraries): A3 landscape
 * sheet, vector CAD entities on their layer colors, layer legend swatches,
 * north arrow, and Project / Sheet / Scale / Date / Author / Sheet-No fields.
 * Emits a valid PDF 1.4 with correct xref byte offsets (ASCII-only stream).
 */

const A3 = { width: 1190.55, height: 841.89 };

export function cadToPdf(
  spec: CadSpec,
  opts: { width?: number; height?: number } = {},
): Blob {
  const width = opts.width ?? A3.width;
  const height = opts.height ?? A3.height;
  const bbox = specBBox(spec);

  const margin = 30;
  const titleBand = 104;
  const x0 = margin + 8;
  const y0 = margin + 8 + titleBand;
  const drawW = width - 2 * (margin + 8);
  const drawH = height - 2 * (margin + 8) - titleBand;

  const bw = Math.max(1e-6, bbox.maxX - bbox.minX);
  const bh = Math.max(1e-6, bbox.maxY - bbox.minY);
  const s = Math.min(drawW / bw, drawH / bh);
  const ox = x0 + (drawW - bw * s) / 2 - bbox.minX * s;
  const oy = y0 + (drawH - bh * s) / 2 - bbox.minY * s;
  const px = (x: number) => ox + x * s;
  const py = (y: number) => oy + y * s;

  const ops: string[] = [];
  const f = (n: number) => String(Math.round(n * 100) / 100);

  // Sheet background + border + drawing frame.
  ops.push(`1 1 1 rg 0 0 ${f(width)} ${f(height)} re f`);
  ops.push(`0.45 0.45 0.45 RG 1.4 w [] 0 d ${f(margin)} ${f(margin)} ${f(width - 2 * margin)} ${f(height - 2 * margin)} re S`);
  ops.push(`0.75 0.75 0.75 RG 0.6 w ${f(x0)} ${f(y0)} ${f(drawW)} ${f(drawH)} re S`);

  const layerById = new Map(spec.layers.map((l) => [l.id, l]));
  const styleFor = (layerId: string) => {
    const layer = layerById.get(layerId);
    if (!layer) return { rgb: "0 0 0", dash: "[] 0 d" };
    const n = parseInt(layer.color.slice(1), 16);
    const blend = (c: number) => (c / 255) * layer.opacity + (1 - layer.opacity);
    const rgb = `${f(blend((n >> 16) & 255))} ${f(blend((n >> 8) & 255))} ${f(blend(n & 255))}`;
    const dash = layer.lineType === "dashed" ? "[6 3] 0 d" : layer.lineType === "dotted" ? "[1.5 2.5] 0 d" : "[] 0 d";
    return { rgb, dash };
  };

  const sanitize = (text: string) =>
    text.replace(/([\\()])/g, "\\$1").replace(/[^\x20-\x7E]/g, "");

  const drawText = (content: string, x: number, y: number, size: number, font: "F1" | "F2", anchor: "start" | "middle" | "end" = "start", rotationDeg = 0) => {
    const clean = sanitize(content);
    if (!clean) return;
    const approxWidth = clean.length * size * 0.55;
    const shift = anchor === "middle" ? approxWidth / 2 : anchor === "end" ? approxWidth : 0;
    const rad = (rotationDeg * Math.PI) / 180;
    const cos = f(Math.cos(rad));
    const sin = f(Math.sin(rad));
    ops.push(`BT /${font} ${f(size)} Tf ${cos} ${sin} ${f(-sin)} ${cos} ${f(x - shift)} ${f(y)} Tm (${clean}) Tj ET`);
  };

  for (const entity of spec.entities) {
    const { rgb, dash } = styleFor(entity.layer);
    ops.push(`${rgb} rg ${rgb} RG 0.9 w ${dash}`);
    emitEntity(entity, px, py, s, ops, f, drawText);
  }
  ops.push("[] 0 d");

  // North arrow (top-right of the drawing frame).
  const nx = x0 + drawW - 26;
  const ny = y0 + drawH - 30;
  ops.push(`0.2 0.2 0.2 rg ${f(nx)} ${f(ny)} m ${f(nx - 7)} ${f(ny - 16)} l ${f(nx)} ${f(ny - 11)} l ${f(nx + 7)} ${f(ny - 16)} h f`);
  drawText("N", nx, ny - 28, 9, "F2", "middle");

  // Title block band along the bottom.
  const tb = spec.titleBlock ?? {};
  const bx = margin + 8;
  const by = margin + 8;
  const bw2 = width - 2 * (margin + 8);
  ops.push(`1 1 1 rg 0.45 0.45 0.45 RG 1 w ${f(bx)} ${f(by)} ${f(bw2)} ${f(titleBand - 16)} re f S`);
  drawText(tb.projectName ?? spec.title, bx + 12, by + titleBand - 34, 13, "F2");
  drawText(tb.sheetTitle ?? "CAD drawing", bx + 12, by + titleBand - 52, 10, "F1");
  const meta = [
    tb.scaleLabel ? `Scale ${tb.scaleLabel}` : `Scale 1:${spec.scale?.ratio ?? 100}`,
    tb.date ? `Date ${tb.date}` : "",
    tb.author ? `Drawn by ${tb.author}` : "",
    tb.sheetNumber ? `Sheet ${tb.sheetNumber}` : "",
    `Units ${spec.units}`,
  ].filter(Boolean).join("   |   ");
  drawText(meta, bx + 12, by + 16, 8.5, "F1");

  // Layer legend (right side of the title band).
  let lx = bx + bw2 - 300;
  let ly = by + titleBand - 34;
  drawText("LAYER LEGEND", lx, ly, 8.5, "F2");
  ly -= 14;
  for (const layer of spec.layers.slice(0, 6)) {
    const { rgb, dash } = styleFor(layer.id);
    ops.push(`${rgb} RG 1.2 w ${dash} ${f(lx)} ${f(ly + 2)} m ${f(lx + 20)} ${f(ly + 2)} l S`);
    drawText(layer.name ?? layer.id, lx + 26, ly, 8, "F1");
    ly -= 12;
  }
  ops.push("[] 0 d");
  if (tb.legendNote) drawText(tb.legendNote, bx + 12, by + titleBand - 68, 8, "F1");

  const content = ops.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(width)} ${f(height)}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;

  return new Blob([pdf], { type: "application/pdf" });
}

type NumFmt = (n: number) => string;
type TextFn = (content: string, x: number, y: number, size: number, font: "F1" | "F2", anchor?: "start" | "middle" | "end", rotationDeg?: number) => void;

function emitEntity(
  entity: CadEntity,
  px: (x: number) => number,
  py: (y: number) => number,
  s: number,
  ops: string[],
  f: NumFmt,
  drawText: TextFn,
): void {
  switch (entity.kind) {
    case "line":
      ops.push(`${f(px(entity.from[0]))} ${f(py(entity.from[1]))} m ${f(px(entity.to[0]))} ${f(py(entity.to[1]))} l S`);
      return;
    case "rect": {
      const path = `${f(px(entity.x))} ${f(py(entity.y))} ${f(entity.w * s)} ${f(entity.h * s)} re`;
      ops.push(entity.filled ? `${path} B` : `${path} S`);
      return;
    }
    case "polyline":
    case "polygon": {
      const points = entity.kind === "polygon" || entity.closed ? entity.points : entity.points;
      const closed = entity.kind === "polygon" || entity.closed;
      ops.push(pathOps(points, px, py, f, closed));
      return;
    }
    case "circle": {
      const cx = px(entity.cx);
      const cy = py(entity.cy);
      const r = entity.r * s;
      const k = r * 0.5522847;
      ops.push(
        `${f(cx + r)} ${f(cy)} m ${f(cx + r)} ${f(cy + k)} ${f(cx + k)} ${f(cy + r)} ${f(cx)} ${f(cy + r)} c ` +
          `${f(cx - k)} ${f(cy + r)} ${f(cx - r)} ${f(cy + k)} ${f(cx - r)} ${f(cy)} c ` +
          `${f(cx - r)} ${f(cy - k)} ${f(cx - k)} ${f(cy - r)} ${f(cx)} ${f(cy - r)} c ` +
          `${f(cx + k)} ${f(cy - r)} ${f(cx + r)} ${f(cy - k)} ${f(cx + r)} ${f(cy)} c`,
      );
      ops.push(entity.filled ? "f" : "S");
      return;
    }
    case "arc": {
      const segments = 24;
      const delta = normalizeDelta(entity.startDeg, entity.endDeg);
      const start = (entity.startDeg * Math.PI) / 180;
      let d = "";
      for (let i = 0; i <= segments; i++) {
        const ang = start + (delta * Math.PI / 180) * (i / segments);
        const x = px(entity.cx + entity.r * Math.cos(ang));
        const y = py(entity.cy + entity.r * Math.sin(ang));
        d += `${i === 0 ? "m" : "l"} ${f(x)} ${f(y)} `;
      }
      ops.push(`${d}S`);
      return;
    }
    case "text": {
      const size = Math.min(22, Math.max(6, entity.height * s));
      drawText(entity.content, px(entity.x), py(entity.y), size, "F1", entity.anchor, entity.rotation);
      return;
    }
  }
}

function normalizeDelta(startDeg: number, endDeg: number): number {
  let delta = (endDeg - startDeg) % 360;
  if (delta < 0) delta += 360;
  return delta;
}

function pathOps(
  points: readonly (readonly [number, number])[],
  px: (x: number) => number,
  py: (y: number) => number,
  f: NumFmt,
  closed: boolean,
): string {
  let d = "";
  points.forEach(([x, y], i) => {
    d += `${i === 0 ? "m" : "l"} ${f(px(x))} ${f(py(y))} `;
  });
  return `${d}${closed ? "h " : ""}S`;
}
