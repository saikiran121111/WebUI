import { test, expect, type Page, type Locator } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { getDocumentProxy } from "unpdf";
import ExcelJS from "exceljs";

/**
 * PHASE 6 regression: every document modality end-to-end through the real
 * chat UI (mocked SSE upstream for the fence tests, real llama.cpp through
 * the logging proxy for the lazy-load test). Asserts the release-blocking
 * guarantees: zero cross-contamination in core skill routing, the minimal
 * auto-sizing dark HTML viewer, real multi-page PDFs, embedded DOCX charts
 * with zero temp leftovers, zero-null live-formula XLSX with a clean
 * server-side recalc, OOXML Morph + !! shape names in the PPTX, and a
 * cross-filtering Power BI preview producing a valid .pbip package.
 *
 * Requires: dev server on http://localhost:3000 started with
 * LLM_API_URL=http://127.0.0.1:8099/v1/chat/completions and
 * `node scripts/e2e-llm-proxy.mjs` running (see that file's header).
 */

const ASSISTANT_DONE = '[data-testid="assistant-message"][data-state="complete"]';
const DL_DIR = path.resolve("test-results/e2e-modality");

test.beforeAll(() => {
  fs.mkdirSync(DL_DIR, { recursive: true });
});

/** Respond to every POST /api/chat with `content` streamed in small SSE frames. */
async function mockStream(page: Page, content: string, chunkSize = 64): Promise<void> {
  await page.route("**/api/chat", async (route) => {
    const frames: string[] = [];
    for (let i = 0; i < content.length; i += chunkSize) {
      const chunk = content.slice(i, i + chunkSize);
      frames.push(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
    }
    frames.push("data: [DONE]\n\n");
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
      body: frames.join(""),
    });
  });
}

async function send(page: Page, text: string, timeout = 20_000): Promise<void> {
  const box = page.locator("textarea").first();
  await box.click();
  await box.fill(text);
  await box.press("Enter");
  await page.locator(ASSISTANT_DONE).first().waitFor({ timeout });
}

/** Click a download button, save the file, return its saved path. */
async function downloadVia(page: Page, button: Locator, timeout = 120_000): Promise<string> {
  const [download] = await Promise.all([page.waitForEvent("download", { timeout }), button.click()]);
  const file = path.join(DL_DIR, download.suggestedFilename());
  await download.saveAs(file);
  return file;
}

function readPdfPages(file: string): Promise<number> {
  return getDocumentProxy(new Uint8Array(fs.readFileSync(file))).then((d) => d.numPages);
}

// ---------------------------------------------------------------- lazy load

test("core skill router lazy-loads exactly the matched modality (zero cross-contamination)", async ({ page }) => {
  test.setTimeout(180_000);
  let proxyOk = true;
  try {
    await fetch("http://127.0.0.1:8099/__reset");
  } catch {
    proxyOk = false;
  }
  test.skip(!proxyOk, "e2e-llm-proxy not running (node scripts/e2e-llm-proxy.mjs)");

  await page.goto("http://localhost:3000/");
  await send(page, "make me a printable pdf report about quarterly revenue", 120_000);

  const bodies: string[] = await (await fetch("http://127.0.0.1:8099/__captured")).json();
  const mine = bodies.filter((b) => b.includes("printable pdf report about quarterly revenue"));
  expect(mine.length, "dev server never forwarded the prompt upstream (LLM_API_URL pointed at the proxy?)").toBeGreaterThan(0);
  // Unwrap the recorded request body so assertions see the real message text
  // (raw JSON would carry \" escapes inside the system content).
  const parsed = JSON.parse(mine[mine.length - 1]);
  const payload: string = (parsed.messages ?? [])
    .map((m: { content?: unknown }) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")))
    .join("\n");

  expect(payload).toContain("<core_skill_routing");
  expect(payload).toContain('<core_skill name="pdf">');
  for (const other of ["xlsx", "pptx", "docx", "powerbi", "resume-builder", "html-viewer"]) {
    expect(payload, `cross-contamination: ${other} loaded on a pdf prompt`).not.toContain(`<core_skill name="${other}">`);
  }
  expect((payload.match(/<core_skill name=/g) ?? []).length, "more than one core skill bundle injected").toBe(1);
});

// ------------------------------------------------------------- html viewer

const ARTIFACT = [
  '<div style="background:#000000;color:#FFFFFF;font-family:system-ui,sans-serif;padding:24px;min-height:520px">',
  '<h1 style="color:#38E8FF;margin:0 0 12px">Order Flow</h1>',
  '<svg width="420" height="120" viewBox="0 0 420 120">',
  '<rect x="4" y="34" width="110" height="46" rx="8" fill="#141414" stroke="#262626"/>',
  '<text x="59" y="62" fill="#FFFFFF" font-size="13" text-anchor="middle">Order</text>',
  '<line x1="114" y1="57" x2="150" y2="57" stroke="#38E8FF" stroke-width="2"/>',
  '<rect x="150" y="34" width="110" height="46" rx="8" fill="#141414" stroke="#262626"/>',
  '<text x="205" y="62" fill="#FFFFFF" font-size="13" text-anchor="middle">Kitchen</text>',
  '<line x1="260" y1="57" x2="296" y2="57" stroke="#38E8FF" stroke-width="2"/>',
  '<rect x="296" y="34" width="110" height="46" rx="8" fill="#141414" stroke="#262626"/>',
  '<text x="351" y="62" fill="#22C55E" font-size="13" text-anchor="middle">Served</text>',
  "</svg>",
  '<h2 style="color:#FFFFFF;margin:20px 0 8px">Dinner Splitter</h2>',
  '<label style="color:#A1A1AA">Bill <input id="bill" type="number" value="100" style="width:90px"></label>',
  '<label style="color:#A1A1AA"> Guests <input id="guests" type="number" value="4" style="width:60px"></label>',
  '<div id="out" style="margin-top:14px;font-size:24px;color:#22C55E">$25.00 each</div>',
  "<script>",
  "var b=document.getElementById('bill'),g=document.getElementById('guests'),o=document.getElementById('out');",
  'function calc(){var bb=parseFloat(b.value)||0,gg=parseInt(g.value,10)||1;o.textContent="$"+(bb/gg).toFixed(2)+" each";}',
  "b.addEventListener('input',calc);g.addEventListener('input',calc);calc();",
  "<\/script>",
  "</div>",
].join("\n");

test("html artifact viewer: #000000 canvas, zero chrome, ResizeObserver auto-fit, live input state", async ({ page }) => {
  await mockStream(page, "```html\n" + ARTIFACT + "\n```");
  await page.goto("http://localhost:3000/");
  await send(page, "interactive dinner splitter artifact with a flowchart");

  const block = page.locator('[data-testid="html-artifact-block"]');
  await expect(block).toBeVisible();

  // The viewer frame itself is the dark canvas: #000000, 1px hairline border,
  // 16px radius — the minimal chrome-free contract.
  const frame = block.locator(".html-artifact-frame");
  await expect(frame).toHaveCSS("background-color", "rgb(0, 0, 0)");

  // Zero chrome inside the viewer: only the three action-row buttons exist,
  // no toolbar, no icons, no code toggle.
  await expect(block.locator("button")).toHaveCount(3);
  await expect(block.getByText(/show code|view code|<\/?>/i)).toHaveCount(0);

  // ResizeObserver auto-fit: the frame settles to the artifact's content
  // height (min-height 520px forces it past the 420 default).
  await expect
    .poll(() => frame.evaluate((el) => parseInt((el as HTMLElement).style.height || "0", 10)), {
      message: "ResizeObserver never resized the frame",
      timeout: 8_000,
    })
    .toBeGreaterThan(500);

  const inner = block.locator("iframe").contentFrame();
  await expect(inner.locator("body")).toHaveCSS("background-color", "rgb(0, 0, 0)");
  await expect(inner.locator("#out")).toHaveText("$25.00 each");

  // Pass-through interactivity: typing updates the artifact's own state.
  await inner.locator("#bill").fill("80");
  await inner.locator("#guests").fill("5");
  await expect(inner.locator("#out")).toHaveText("$16.00 each");
});

test("html artifact exports a real multi-page A4 PDF", async ({ page }) => {
  const pages = [1, 2, 3]
    .map(
      (i) =>
        `<section style="page-break-after:always;min-height:1050px;padding:48px;font-family:Georgia,serif;color:#111"><h1>Section ${i}</h1><p>Quarterly narrative block ${i} with substantive content to force pagination across A4 pages.</p></section>`,
    )
    .join("");
  await mockStream(page, "```html\n" + pages + "\n```");
  await page.goto("http://localhost:3000/");
  await send(page, "printable multi page report");

  const block = page.locator('[data-testid="html-artifact-block"]');
  await expect(block).toBeVisible();
  const file = await downloadVia(page, block.getByRole("button", { name: "Export as PDF" }));
  expect(path.basename(file)).toMatch(/\.pdf$/i);
  expect(await readPdfPages(file)).toBeGreaterThanOrEqual(2);
});

test("html artifact: light report inverts for the dark viewer; over-tall content scrolls", async ({ page }) => {
  const tall =
    '<!DOCTYPE html><html><head><style>html,body{margin:0;background:#FFFFFF;color:#111}</style></head>' +
    '<body><h1>White paper report</h1><div style="height:3000px">taller than the MAX_H clamp</div></body></html>';
  await mockStream(page, "```html\n" + tall + "\n```");
  await page.goto("http://localhost:3000/");
  await send(page, "white background status report");

  const frame = page.locator(".html-artifact-iframe");
  // White luma probe → invert+hue-rotate so the viewer matches the dark app;
  // Download HTML / Export PDF stay white (paths untouched).
  await expect(frame).toHaveClass(/html-artifact-iframe--invert/);
  // 3000px content exceeds the 2400px clamp → the frame must scroll, or the
  // tail of long split-page previews is unreachable.
  await expect(frame).toHaveAttribute("scrolling", "yes");
});

// ------------------------------------------------------------------ resume

const RESUME = JSON.stringify({
  basics: {
    name: "Ada Lovelace", title: "Data Engineer", email: "ada@example.com", phone: "+1-555-0100",
    location: "Berlin", links: [{ label: "GitHub", url: "https://github.com/ada" }],
    summary: "Data engineer with 6 years building batch and streaming pipelines at scale.",
  },
  sections: [
    { id: "exp", title: "Experience", items: [{ heading: "Acme Corp", subheading: "Data Engineer", dateLocation: "2022-2025 · Berlin", keywords: ["ETL", "Airflow", "dbt"], bullets: ["Built streaming pipelines cutting latency 70%", "Cut warehouse spend 40% with partition pruning"] }] },
    { id: "edu", title: "Education", items: [{ heading: "TU Berlin", subheading: "B.Sc. Computer Science", dateLocation: "2016-2020 · Berlin", keywords: [], bullets: ["Thesis on query optimization"] }] },
  ],
});

test("resume fence: ATS preview renders and the PDF download is 1-2 pages", async ({ page }) => {
  await mockStream(page, "```resume\n" + RESUME + "\n```");
  await page.goto("http://localhost:3000/");
  await send(page, "tailor my resume for a data engineering role");

  const block = page.locator('[data-testid="resume-block"]');
  await expect(block).toBeVisible();
  await expect(block.locator("iframe.resume-paper")).toBeVisible();

  // Preview is dark-aligned with the app chrome (#141414 injected override);
  // the DOWNLOAD path never sees that CSS (server uses raw resumeHtml = white).
  const rframe = block.locator("iframe.resume-paper").contentFrame();
  await expect(rframe.locator("body"), "resume preview background must match the dark viewer")
    .toHaveCSS("background-color", "rgb(20, 20, 20)");
  await expect(rframe.locator(".resume-name")).toHaveText(/Ada/);
  await expect(rframe.locator(".resume-item-head").first()).toBeVisible(); // flex head/meta rows render

  const file = await downloadVia(page, block.getByRole("button", { name: "Download RESUME file" }));
  expect(path.basename(file)).toMatch(/Ada_Lovelace_Resume\.pdf$/);
  const pages = await readPdfPages(file);
  expect(pages).toBeGreaterThanOrEqual(1);
  expect(pages).toBeLessThanOrEqual(2);
});

// -------------------------------------------------------------------- docx

const DOCX = JSON.stringify({
  filename: "Q4 Review",
  title: "Q4 Business Review",
  author: "Local AI",
  sections: [
    { type: "heading", level: 1, text: "Q4 Business Review" },
    { type: "paragraph", text: "Revenue grew across all regions while churn held flat." },
    { type: "chart", title: "Revenue by Month", chart: { type: "bar", categories: ["Jul", "Aug", "Sep"], series: [{ name: "Revenue", data: [120, 180, 240] }] } },
    { type: "chart", title: "Revenue Mix", chart: { type: "pie", categories: ["NA", "EMEA", "APAC"], series: [{ name: "Share", data: [55, 30, 15] }] } },
    { type: "table", headers: ["Region", "Q4"], rows: [["NA", "1.2M"], ["EMEA", "640K"]] },
  ],
});

test("docx fence: preview + download embeds both charts as images with zero temp leftovers", async ({ page }) => {
  await mockStream(page, "```docx\n" + DOCX + "\n```");
  await page.goto("http://localhost:3000/");
  await send(page, "word document with two charts");

  await expect(page.locator('[data-testid="docx-preview"]')).toBeVisible();
  const file = await downloadVia(page, page.locator('[data-testid="docx-block"]').getByRole("button", { name: "Download DOCX file" }));

  const zip = unzipSync(fs.readFileSync(file));
  const xml = Buffer.from(zip["word/document.xml"]).toString("utf8");
  expect((xml.match(/<w:drawing/g) ?? []).length, "charts not embedded as images").toBeGreaterThanOrEqual(2);
  const media = Object.keys(zip).filter((k) => k.startsWith("word/media/"));
  expect(media.length, "chart PNGs missing from word/media").toBeGreaterThanOrEqual(2);

  // Chart screenshot temps are cleaned up by the engine.
  const leftovers = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("temp_chart_"));
  expect(leftovers, "temp chart files left on disk").toEqual([]);
});

// -------------------------------------------------------------------- xlsx

const XLSX = JSON.stringify({
  filename: "Q4 Model",
  sheets: [
    {
      name: "Revenue",
      columns: [
        { key: "month", label: "Month", format: "text" },
        { key: "region", label: "Region", format: "text", validation: { type: "list", values: ["NA", "EMEA", "APAC"] } },
        { key: "revenue", label: "Revenue", format: "currency" },
        { key: "cost", label: "Cost", format: "currency" },
        { key: "margin", label: "Margin %", format: "percent", validation: { type: "decimal", min: -1, max: 1 } },
      ],
      rows: [
        { month: "2025-01", region: "NA", revenue: 120000, cost: 80000, margin: "=IF(C2=0,0,(C2-D2)/C2)" },
        { month: "2025-02", region: "EMEA", revenue: 95000, cost: null, margin: "=IF(C3=0,0,(C3-D3)/C3)" },
        { month: "2025-03", region: "APAC", revenue: null, cost: 40000, margin: "=IF(C4=0,0,(C4-D4)/C4)" },
      ],
      freezeHeader: true,
      totalRow: true,
    },
    {
      name: "Summary",
      columns: [
        { key: "metric", label: "Metric", format: "text" },
        { key: "value", label: "Value", format: "currency" },
      ],
      rows: [
        { metric: "Total Revenue", value: "=SUM(Revenue!C2:C4)" },
        { metric: "Average Margin", value: "=AVERAGE(Revenue!E2:E4)" },
      ],
      freezeHeader: true,
      totalRow: false,
    },
  ],
});

test("xlsx fence: multi-sheet preview + download with live formulas and a zero-error recalc", async ({ page }) => {
  await mockStream(page, "```xlsx\n" + XLSX + "\n```");
  await page.goto("http://localhost:3000/");
  await send(page, "spreadsheet financial model with formulas");

  const preview = page.locator('[data-testid="xlsx-preview"]');
  await expect(preview).toBeVisible();
  await expect(page.locator(".xlsx-tabs [role=tab]")).toHaveCount(2);
  await page.locator(".xlsx-tabs [role=tab]", { hasText: "Summary" }).click();
  await expect(preview.locator("thead th")).toHaveText(["Metric", "Value"]);

  // View mode shows the RECALCULATED VALUES, never the formula source
  // (SUM = 120000+95000+0 = $215,000.00; AVERAGE margin = 0.444, rendered in
  // the Summary "value" column's currency format). The live formulas still
  // ship in the downloaded workbook — asserted below.
  await expect(preview.getByText("$215,000.00")).toBeVisible();
  await expect(preview.getByText("$0.44")).toBeVisible();
  await expect(preview.locator("td", { hasText: "=SUM(" })).toHaveCount(0);

  const block = page.locator('[data-testid="xlsx-block"]');
  const [resp, download] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/documents/xlsx"), { timeout: 120_000 }),
    page.waitForEvent("download", { timeout: 120_000 }),
    block.getByRole("button", { name: "Download XLSX file" }).click(),
  ]);
  // A recalc error would 500 (XlsxRecalcError) — 200 proves errors_found == 0.
  expect(resp.status(), await resp.text().catch(() => "")).toBe(200);

  const file = path.join(DL_DIR, download.suggestedFilename());
  await download.saveAs(file);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(fs.readFileSync(file) as unknown as Parameters<typeof wb.xlsx.load>[0]);
  expect(wb.worksheets.map((w) => w.name)).toEqual(["Revenue", "Summary"]);

  const ws = wb.getWorksheet("Revenue")!;
  let nulls = 0;
  ws.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      const v = cell.value;
      if (v == null || (typeof v === "string" && v.trim() === "")) nulls++;
    });
  });
  expect(nulls, "null/blank cells in the used range").toBe(0);

  const fx = (addr: string) => String((ws.getCell(addr).value as { formula?: string })?.formula ?? "");
  expect(fx("E2"), "margin cell is not a live formula").toMatch(/^IF\(/);
  expect(String((ws.getRow(5).getCell(3).value as { formula?: string })?.formula)).toBe("SUM(C2:C4)");
});

// -------------------------------------------------------------------- pptx

const PPTX = JSON.stringify({
  filename: "Launch Deck",
  title: "Launch",
  tier: "insane",
  theme: { bg: "#0A0A0A", accent: "#38E8FF", positive: "#22C55E" },
  slides: [
    { layout: "title", title: "Launch 2026", subtitle: "Seed Round" },
    { layout: "stats", title: "Traction", stats: [{ label: "MRR", value: "$120K" }, { label: "Growth", value: "38%" }], morphGroup: "accent" },
    { layout: "stats", title: "What Comes Next", stats: [{ label: "ARR", value: "$1.4M" }], morphGroup: "accent" },
  ],
});

test("pptx fence: preview carousel, fullscreen slideshow nav, Morph + !! names in the downloaded XML", async ({ page }) => {
  await mockStream(page, "```pptx\n" + PPTX + "\n```");
  await page.goto("http://localhost:3000/");
  await send(page, "insane animated pitch deck");

  const preview = page.locator('[data-testid="pptx-preview"]');
  await expect(preview.getByText("Launch 2026")).toBeVisible();
  await preview.getByRole("button", { name: "Next slide" }).click();
  await expect(preview.getByText("Traction")).toBeVisible();

  // The card-level Fullscreen button is gone: the slideshow itself takes
  // native fullscreen (browser chrome hidden), so a separate FS is redundant.
  await expect(page.locator('[data-testid="pptx-block"]').getByRole("button", { name: /fullscreen/i })).toHaveCount(0);

  await page.getByRole("button", { name: "Run Slideshow" }).click();
  const show = page.locator('[data-testid="pptx-slideshow"]');
  await expect(show).toBeVisible();
  await expect(show.locator(".pptx-show-hud")).toContainText("1 / 3");
  await page.keyboard.press("ArrowRight");
  await expect(show.locator(".pptx-show-hud")).toContainText("2 / 3");
  await page.keyboard.press("Escape");
  await expect(show).toBeHidden();

  const file = await downloadVia(page, page.locator('[data-testid="pptx-block"]').getByRole("button", { name: "Download PPTX file" }));
  const zip = unzipSync(fs.readFileSync(file));
  const slideXml = Object.keys(zip)
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .map((k) => Buffer.from(zip[k]).toString("utf8"))
    .join("\n");
  expect(slideXml, "OOXML Morph transition missing").toContain('p159:morph option="byObject"');
  expect(slideXml, "!!-prefixed paired shape names missing").toContain('name="!!');
});

// ----------------------------------------------------------------- powerbi

const POWERBI = JSON.stringify({
  filename: "Sales Report",
  dataset: {
    columns: [
      { name: "Month", type: "date" },
      { name: "Region", type: "string" },
      { name: "Revenue", type: "number" },
    ],
    rows: [
      ["2025-01", "NA", 100],
      ["2025-01", "EMEA", 50],
      ["2025-02", "NA", 200],
      ["2025-02", "EMEA", 80],
      ["2025-03", "NA", 150],
      ["2025-03", "APAC", 60],
    ],
  },
  measures: [{ name: "Total Revenue", dax: "SUM([Revenue])" }],
  visuals: [
    { type: "kpi", title: "Total Revenue", measure: "Total Revenue", format: "currency" },
    { type: "bar", title: "Revenue by Region", dimension: "Region", measure: "Total Revenue", format: "currency" },
    { type: "table", title: "Detail", columns: ["Month", "Region", "Revenue"] },
  ],
  slicers: [{ field: "Region", type: "list" }],
});

test("power bi fence: live cross-filtering preview + valid .pbip package download", async ({ page }) => {
  await mockStream(page, "```powerbi\n" + POWERBI + "\n```");
  await page.goto("http://localhost:3000/");
  await send(page, "power bi dashboard from this sales data");

  await expect(page.locator('[data-testid="bi-preview"]')).toBeVisible();
  const kpi = page.locator('[data-testid="bi-kpi-0"] .bi-kpi-value');
  await expect.poll(() => kpi.textContent(), { timeout: 6_000, message: "KPI never counted up to the unfiltered total" }).toContain("640");

  // Cross-filter: clicking a bar row re-aggregates every visual.
  await page.getByRole("button", { name: "Filter Region: NA" }).click();
  await expect.poll(() => kpi.textContent(), { timeout: 6_000, message: "KPI did not follow the cross-filter" }).toContain("450");
  await expect(page.locator(".bi-chip--cross")).toBeVisible();
  await page.getByRole("button", { name: "Clear cross-filter" }).click();
  await expect.poll(() => kpi.textContent(), { timeout: 6_000, message: "KPI did not restore after clearing" }).toContain("640");

  const file = await downloadVia(page, page.locator('[data-testid="powerbi-block"]').getByRole("button", { name: "Download POWER BI file" }));
  expect(path.basename(file)).toMatch(/\.pbip\.zip$/);

  const keys = Object.keys(unzipSync(fs.readFileSync(file)));
  expect(keys.some((k) => k.endsWith(".pbip")), ".pbip project file missing").toBe(true);
  expect(keys.some((k) => k.endsWith(".tmdl")), "TMDL definition missing").toBe(true);
  expect(keys.some((k) => /\.pbir$/i.test(k)), "PBIR report layout missing").toBe(true);
  expect(keys.some((k) => /theme/i.test(k)), "dark theme missing").toBe(true);
});
