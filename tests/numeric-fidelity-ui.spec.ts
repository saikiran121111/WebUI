import { test, expect, Page, Locator } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

/**
 * F76 defect 1 end-to-end UI journey: upload a PDF whose printed amount uses
 * Indian digit grouping, ask the model (through the real chat UI) to quote it
 * and restate it in crore, and audit EVERY scale-word claim in the reply.
 *
 * The defect this pins (live 2026-11-20): extraction delivered the printed
 * amount verbatim, but the answer re-grouped or rescaled it 10x while also
 * quoting it correctly — one figure, two contradictory values. The fix is the
 * universal numeric-fidelity law on all delivery surfaces (lib/chat/client.ts,
 * the rules() base in lib/server/attachindex/turn.ts ⇔ ruke-attach turn.rs);
 * it is model-quality behavior, so the UI journey can fail while the law is
 * correctly wired. That is a genuine model defect, not a wiring bug — the
 * probe suite (docs/overnight/probes/f76_numeric_fidelity_probe.mjs) measures
 * the same law single-shot; this spec proves the SHIPPED UI path can produce
 * a fully faithful answer.
 *
 * The fixture is held-out: this amount appears in no probe fixture, answer
 * key or prompt. The audit is generic — a printed-digit check plus
 * arithmetic on every (number, scale-word) pair in the reply — so the
 * 10x-off family ("93.47215 crore", "0.9347215 crore") fails while correct
 * restatements ("9.347215 crore", "934.7215 lakh", "9 crore 34 lakh …"
 * composites) pass. Fixture numbers live here, in the test, never in
 * production code or prompts.
 */

const AMOUNT_GROUPED = "9,34,72,150";
const AMOUNT_VALUE = 93_472_150;
/** Mirrors the frozen probe scorer's tolerance for ≈ restatements. */
const REL_TOL = 0.02;
const SCALES: Record<string, number> = {
  thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12, crore: 1e7, lakh: 1e5,
};

const FIXTURE_PDF = path.join(__dirname, "fixtures", "f76-amount.pdf");

/** Escape a PDF literal string (ISO 32000-1 §7.3.4.2). */
function esc(s: string): string {
  return s.replace(/[\\()]/g, (ch) => "\\" + ch);
}

/**
 * Handcrafted one-page native-text PDF — same stdlib-only raw-PDF route as
 * docs/overnight/fixtures/d1/ocr_docs.py (whose extractability through the
 * production extractor is proven). Object layout follows that generator's
 * proven shape (catalog/pages/fonts/info at 1..5, content, page).
 */
function buildAmountPdf(): Buffer {
  const lines = [
    "District Registry of Deeds - transfer record 214-B",
    "Buyer: K. Raman. Seller: Estate of M. Naidu.",
    "Survey 88, plot 7; area 1,250 square feet.",
    `Consideration for this transfer: ${AMOUNT_GROUPED} rupees.`,
    "Paid in full before registration on 14 March.",
  ];
  const ops = lines.map((line, i) => `BT /F1 11 Tf 56 ${760 - 16 * i} Td (${esc(line)}) Tj ET`);
  const stream = Buffer.from(ops.join("\n"), "latin1");

  const objs: Record<number, Buffer> = {
    1: Buffer.from("<</Type/Catalog/Pages 2 0 R /Lang(en-US)>>", "latin1"),
    2: Buffer.from("<</Type/Pages/Count 1/Kids[7 0 R]>>", "latin1"),
    3: Buffer.from("<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>", "latin1"),
    4: Buffer.from("<</Type/Font/Subtype/Type1/BaseFont/Courier>>", "latin1"),
    5: Buffer.from("<</Producer(Ruke F76 numeric-fidelity UI fixture)/CreationDate(D:20261121000000)>>", "latin1"),
    6: Buffer.concat([
      Buffer.from(`<</Length ${stream.length}>>\nstream\n`, "latin1"), stream, Buffer.from("\nendstream", "latin1"),
    ]),
    7: Buffer.from(
      "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 3 0 R/F2 4 0 R>>>>/Contents 6 0 R>>",
      "latin1",
    ),
  };

  const order = Object.keys(objs).map(Number).sort((a, b) => a - b);
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  const off = new Map<number, number>();
  for (const ref of order) {
    off.set(ref, Buffer.concat(parts).length);
    parts.push(Buffer.from(`${ref} 0 obj\n`, "latin1"), objs[ref], Buffer.from("\nendobj\n", "latin1"));
  }
  const start = Buffer.concat(parts).length;
  parts.push(Buffer.from(`xref\n0 ${order.length + 1}\n0000000000 65535 f \n`, "latin1"));
  for (const ref of order) parts.push(Buffer.from(`${String(off.get(ref)).padStart(10, "0")} 00000 n \n`, "latin1"));
  parts.push(Buffer.from(
    `trailer\n<</Size ${order.length + 1}/Root 1 0 R/Info 5 0 R>>\nstartxref\n${start}\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}

/** Write the fixture at module load so both the API test and the UI test see it. */
fs.mkdirSync(path.dirname(FIXTURE_PDF), { recursive: true });
fs.writeFileSync(FIXTURE_PDF, buildAmountPdf());

/**
 * Audit EVERY (number, scale-word) claim in the answer. Adjacent descending-
 * scale tokens compose (Indian-style "9 crore 34 lakh …" is one figure), so
 * groups sum. Acceptance mirrors the frozen probe scorer's rule, generalized:
 * a restatement equal to the printed amount must EXIST (non-vacuous), and NO
 * group may equal the amount scaled by any power of ten (the live 10x defect
 * family — it fails even beside a correct quote, and in an aside anywhere).
 * Unit statements the law itself demands ("1 crore = 100 lakh") and restated
 * figures belonging to OTHER printed numbers pass untouched — content-neutral.
 */
function scaleGroups(answer: string): { text: string; value: number }[] {
  const re = /\b(\d[\d,]*(?:\.\d+)?)\s*(crores?|lakhs?|millions?|billions?|trillions?|thousands?)\b/gi;
  const groups: { text: string; value: number }[] = [];
  let prevEnd = -1, prevScale = 0;
  for (const m of answer.matchAll(re)) {
    const digits = m[1].replace(/,/g, "");
    const word = m[2].toLowerCase().replace(/s$/, "");
    const scale = SCALES[word];
    const value = parseFloat(digits) * scale;
    const gap = answer.slice(prevEnd, m.index);
    const composes = prevEnd >= 0 && scale < prevScale && /^[\s,]*(?:(?:and|plus)\s+)?[\s,]*$/.test(gap);
    if (composes) {
      const g = groups[groups.length - 1];
      g.text += gap + m[0];
      g.value += value;
    } else {
      groups.push({ text: m[0], value });
    }
    prevEnd = (m.index ?? 0) + m[0].length;
    prevScale = scale;
  }
  return groups;
}

async function askQuoteAndRestate(page: Page): Promise<string> {
  await page.goto("/");

  // Reasoning off keeps the turn a few seconds (same guard as file-reading).
  const effort = page.getByRole("button", { name: /^Reasoning effort:/ });
  if ((await effort.getAttribute("aria-label")) !== "Reasoning effort: Off") {
    await effort.click();
    await page.getByRole("menuitemradio", { name: "Off", exact: true }).click();
    await expect(effort).toHaveAttribute("aria-label", "Reasoning effort: Off");
  }

  await page.setInputFiles('[data-testid="file-input"]', FIXTURE_PDF);
  const chip = page.locator('[data-testid="attachment-chip"]').last();
  await expect(chip).toBeVisible();
  const chipDeadline = Date.now() + 60_000;
  let status = "";
  while (Date.now() < chipDeadline) {
    status = (await chip.getAttribute("data-status").catch(() => null)) ?? "(no chip)";
    if (status === "ready") break;
    if (status === "error") throw new Error(`extraction failed: ${await chip.getAttribute("title")}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  if (status !== "ready") throw new Error(`attachment never became ready (last status: ${status})`);

  // Neutral prompt — names no value, no digits, no conversion shortcut.
  await page
    .locator("textarea")
    .first()
    .fill(
      "What consideration amount does this document record? Quote it exactly as printed, " +
        "then restate that same amount in crore and show the conversion you applied.",
    );
  await expect(page.locator('[data-testid="send-button"]')).toBeEnabled();
  await page.locator('[data-testid="send-button"]').click();

  const reply = page.locator('[data-testid="assistant-message"]').last();
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const state = await reply.getAttribute("data-state").catch(() => null);
    if (state === "error") throw new Error(`chat failed: ${await reply.innerText()}`);
    if (state === "complete") return (await reply.innerText()).trim();
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("the assistant never finished answering");
}

test.describe("numeric fidelity through the real UI (F76 defect 1)", () => {
  test.setTimeout(380_000);

  test("the extract route reads the fixture's printed amount verbatim", async ({ request }) => {
    // Model-free precondition: the audit below is only meaningful if the
    // server-side text already carries the exact printed grouping.
    const resp = await request.post(`/api/files/extract?name=${encodeURIComponent(path.basename(FIXTURE_PDF))}`, {
      data: fs.readFileSync(FIXTURE_PDF),
      headers: { "content-type": "application/octet-stream" },
      timeout: 60_000,
    });
    const body = await resp.json().catch(() => null);
    expect(resp.status(), `extract failed: ${body?.error ?? "(no response body)"}`).toBe(200);
    expect(body?.text, "extracted text is missing the printed digit grouping").toContain(AMOUNT_GROUPED);
  });

  test("the reply quotes the printed amount and every scale-word claim equals it", async ({ page }) => {
    // Same bounded-retry law as file-reading's live turns: slow-turn and
    // truncated-tail nondeterminism of the local model get one retry, and
    // EVERY attempt is audited in full on its own (never best-of-partial:
    // a contradictory answer fails its own audit no matter what the retry
    // says). Genuine chat/extraction errors still throw immediately.
    let said = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        said = await askQuoteAndRestate(page);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "the assistant never finished answering" && attempt < 2) continue;
        throw err;
      }
      console.log(`  f76-amount.pdf ${attempt === 2 ? "(retry) " : ""}${said.replace(/\s+/g, " ").slice(0, 90)}`);

      const flat = said.replace(/\s+/g, " ");
      // 1) the printed grouping is quoted exactly (digit-fidelity half),
      // 2) at least one scale-word restatement EQUALS the printed amount
      //    (non-vacuous), and 3) NO scale-word group equals the amount times
      //    any power of ten — the contradiction family, caught anywhere in
      //    the answer including asides.
      const near = (v: number, target: number) => Math.abs(v - target) / target <= REL_TOL;
      const groups = scaleGroups(flat);
      const quoted = flat.includes(AMOUNT_GROUPED);
      const restated = groups.filter((g) => near(g.value, AMOUNT_VALUE));
      // ±8: catches any power-of-ten misplacement, including a scale word
      // wrongly attached to the bare printed digits (k = +7). Unit sentences
      // ("1 crore", "100 lakh") sit 7% from every target for this value and
      // stay clear of the 2% window.
      const contradictions = groups.filter((g) =>
        Array.from({ length: 16 }, (_, i) => i - 8).some((k) => k !== 0 && near(g.value, AMOUNT_VALUE * 10 ** k)),
      );
      if (quoted && restated.length >= 1 && contradictions.length === 0) break;
      if (attempt === 2) {
        expect(quoted, `the printed grouping "${AMOUNT_GROUPED}" never appears in the reply. It said: ${said.slice(0, 400)}`).toBe(true);
        expect(
          restated.map((g) => g.text.trim()),
          `no scale-word restatement equals the printed ${AMOUNT_GROUPED} (=${AMOUNT_VALUE.toLocaleString("en-US")}). Scale claims found: ${groups.map((g) => `"${g.text.trim()}"=${g.value.toLocaleString("en-US")}`).join("; ") || "(none)"}. Full reply: ${said.slice(0, 400)}`,
        ).not.toHaveLength(0);
        expect(
          contradictions.map((g) => `"${g.text.trim()}" = ${g.value.toLocaleString("en-US")}`),
          `the reply gives a power-of-ten-shifted version of the printed ${AMOUNT_GROUPED} (=${AMOUNT_VALUE.toLocaleString("en-US")}): ${contradictions.join("; ")}. Full reply: ${said.slice(0, 400)}`,
        ).toEqual([]);
      }
    }
  });
});
