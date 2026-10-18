/**
 * DOCX engine (PHASE 3): docx-js with explicit OOXML discipline —
 * 1440 DXA = 1 inch page geometry (A4), real HeadingLevel hierarchy,
 * ShadingType.CLEAR header fills, explicit cell padding, cantSplit rows and
 * keepNext/keepLines so headings and chart captions never orphan from their
 * content. Charts render through a temporary self-contained HTML file
 * (temp_chart_<uuid>.html) screenshotted at deviceScaleFactor 2
 * (temp_chart_<uuid>.png) and are ALWAYS deleted in the finally block.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, ShadingType, ImageRun, BorderStyle,
} from "docx";
import { normalizeDocx, type DocxSpec, type DocxSection } from "./schemas";
import { chartHtmlDocument } from "./chartHtml";
import { renderChartPng, safeName } from "./pdfEngine";

// A4 in DXA (1440 DXA = 1 inch): 11906 × 16838, 1in margins.
const PAGE_W = 11906;
const PAGE_H = 16838;
const MARGIN = 1440;
const CONTENT_W = PAGE_W - MARGIN * 2; // 9026 DXA usable
const CONTENT_PX = Math.round((CONTENT_W / 1440) * 96); // 96dpi pixel width

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4];

const thinBorder = { style: BorderStyle.SINGLE, size: 4, color: "9CA3AF" };
const tableBorders = {
  top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder,
  insideHorizontal: thinBorder, insideVertical: thinBorder,
};

async function chartImageParagraphs(section: Extract<DocxSection, { type: "chart" }>): Promise<Paragraph[]> {
  const id = crypto.randomUUID();
  const tmpPng = path.join(os.tmpdir(), `temp_chart_${id}.png`);
  try {
    const html = chartHtmlDocument({ ...section.chart, title: section.title || undefined }, { width: 640, height: 360, theme: "light" });
    const shot = await renderChartPng(html, { width: 640, height: 360, scale: 2 });
    await fs.writeFile(tmpPng, shot.buffer);
    const data = await fs.readFile(tmpPng);
    const scale = Math.min(1, CONTENT_PX / shot.width);
    const caption = new Paragraph({
      keepNext: true,
      spacing: { before: 160, after: 60 },
      children: [new TextRun({ text: section.title || "Chart", bold: true, size: 22 })],
    });
    const image = new Paragraph({
      keepLines: true,
      keepNext: true,
      spacing: { after: 160 },
      children: [new ImageRun({ type: "png", data, transformation: { width: Math.round(shot.width * scale), height: Math.round(shot.height * scale) } })],
    });
    return [caption, image];
  } finally {
    await fs.rm(tmpPng, { force: true }); // renderChartPng deletes its temp .html
  }
}

function tableFrom(section: Extract<DocxSection, { type: "table" }>): Table {
  const headers = section.headers.length ? section.headers : section.rows[0]?.map((_, i) => "Column " + (i + 1)) ?? [];
  const nCols = Math.max(headers.length, 1);
  const colW = Math.floor(CONTENT_W / nCols);
  const headerRow = new TableRow({
    cantSplit: true,
    children: headers.map((h) => new TableCell({
      width: { size: colW, type: WidthType.DXA },
      shading: { fill: "1F2937", type: ShadingType.CLEAR, color: "auto" },
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [new Paragraph({ children: [new TextRun({ text: String(h), bold: true, color: "FFFFFF", size: 20 })] })],
    })),
  });
  const bodyRows = section.rows.map((r) => new TableRow({
    cantSplit: true, // break-inside: avoid on <tr>
    children: Array.from({ length: nCols }, (_, ci) => new TableCell({
      width: { size: colW, type: WidthType.DXA },
      margins: { top: 60, bottom: 60, left: 120, right: 120 },
      children: [new Paragraph({ children: [new TextRun({ text: String(r[ci] ?? ""), size: 20 })] })],
    })),
  }));
  return new Table({ width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: Array(nCols).fill(colW), borders: tableBorders, rows: [headerRow, ...bodyRows] });
}

export interface DocxBuildResult { buffer: Buffer; filename: string; contentType: string }

export async function buildDocx(rawSpec: unknown): Promise<DocxBuildResult> {
  const spec: DocxSpec = (rawSpec as DocxSpec)?.sections ? (rawSpec as DocxSpec) : normalizeDocx(rawSpec)!;
  if (!spec) throw new Error("Invalid docx spec");

  const children: (Paragraph | Table)[] = [];
  if (spec.title) {
    children.push(new Paragraph({ heading: HeadingLevel.TITLE, keepNext: true, children: [new TextRun({ text: spec.title })] }));
  }
  for (const section of spec.sections) {
    switch (section.type) {
      case "heading":
        children.push(new Paragraph({
          heading: HEADINGS[Math.min(4, Math.max(1, section.level)) - 1] ?? HeadingLevel.HEADING_1,
          keepNext: true, // break-after: avoid on h1-h4
          children: [new TextRun({ text: section.text })],
        }));
        break;
      case "paragraph":
        children.push(new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: section.text })] }));
        break;
      case "bullets":
        for (const item of section.items) {
          children.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 60 }, children: [new TextRun({ text: item })] }));
        }
        break;
      case "table":
        children.push(tableFrom(section));
        children.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
        break;
      case "chart":
        children.push(...(await chartImageParagraphs(section)));
        break;
    }
  }

  const doc = new Document({
    creator: spec.author,
    title: spec.title || spec.filename,
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    sections: [{
      properties: {
        page: {
          size: { width: PAGE_W, height: PAGE_H },
          margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
        },
      },
      children,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  return {
    buffer: Buffer.from(buffer),
    filename: safeName(spec.filename) + ".docx",
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
}
