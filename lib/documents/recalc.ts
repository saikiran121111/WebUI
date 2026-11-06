/**
 * Headless workbook recalculation — the SINGLE shared calculation path used
 * by the XLSX preview (components/render/XlsxBlock, lazy-loaded client
 * chunk) and the export gate (lib/documents/xlsxEngine → API 422).
 *
 * Backed by xlcalc@0.84.0 (MIT, zero runtime dependencies, installed
 * exact via repo-local npm): an Excel-faithful engine where invalid
 * formulas never throw — they surface as error values with machine-
 * readable diagnostics, numbers round to Excel's 15 significant digits,
 * and dynamic arrays (FILTER/LET/MAP/LAMBDA/SEQUENCE…) compute with full
 * spill information. The original hand-written evaluator it replaced kept
 * the public contract below, and callers depend on it verbatim:
 *
 *  - `computed` is keyed "Sheet!A1"; it holds formula cells (plus the
 *    blank cells a dynamic array spilled into, for preview parity).
 *  - `errors` flags every failing cell by sheet, address, formula and a
 *    "#..." display string; the export gate refuses to emit when it is
 *    non-empty, and the model sees the message verbatim.
 *  - Circular references are NEVER cached as verified: xlcalc answers a
 *    cycled formula with its held value (or 0 — the exact trap) PLUS a
 *    CYCLE diagnostic, so the cell is flagged "#CYCLE!" and kept out of
 *    `computed` no matter what value the engine reports.
 */
import { compute, validateFormula, errorText } from "xlcalc";
import type { BookInput, CellInput, ComputeResult } from "xlcalc/contract";

export interface RecalcCell { formula?: string; value?: string | number | boolean | null }
export interface RecalcSheet { name: string; rowCount: number; colCount: number; cells: Map<string, RecalcCell> }
export interface RecalcError { sheet: string; cell: string; formula: string; error: string; reason?: string }
export interface RecalcResult { errors: RecalcError[]; computed: Map<string, string | number | boolean> }
export interface RecalcOptions {
  /** Pin TODAY/NOW/RAND for a deterministic run (tests). Defaults to the real clock. */
  clock?: { now: string; seed: number };
}

// ---------- address helpers (0-based ↔ A1, unchanged from the original) ----------
export function colToIdx(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    if (ch < "A" || ch > "Z") return -1;
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}
export function idxToCol(idx0: number): string {
  let s = "";
  let n = idx0 + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
export function addrKey(col0: number, row0: number): string {
  return idxToCol(col0) + (row0 + 1);
}

/**
 * Normalize formula text to xlcalc input form: drop the leading "=" and
 * strip the `_xlfn.` / `_xlws.` compatibility prefixes that writers (and
 * models copying from xlsx files) add for newer functions — xlcalc knows
 * them by their plain names, and the old evaluator stripped these too.
 */
function xlFormula(formula: string): string {
  return formula.trim().replace(/^=/, "").replace(/_xlfn\.|_xlws\./gi, "");
}

export function recalcWorkbook(sheets: RecalcSheet[], opts?: RecalcOptions): RecalcResult {
  const errors: RecalcError[] = [];
  const computed = new Map<string, string | number | boolean>();
  // "Sheet!A1" -> the formula exactly as the caller wrote it (kept for the
  // "[=...]" text in the gate message).
  const formulas = new Map<string, string>();

  const book: BookInput = {
    sheets: sheets.map((s) => {
      const cells: Record<string, CellInput> = {};
      for (const [address, cell] of s.cells) {
        const f = cell.formula?.trim();
        if (f) {
          // `held` is the value a cycled formula keeps while the cycle
          // prevents calculation; held values still never enter `computed`.
          cells[address] = { formula: xlFormula(f), held: cell.value ?? undefined };
          formulas.set(s.name + "!" + address, f);
        } else if (cell.value !== undefined && cell.value !== null) {
          cells[address] = { value: cell.value };
        }
      }
      return { name: s.name, cells };
    }),
  };

  let result: ComputeResult;
  try {
    result = compute(book, {
      display: true,
      clock: opts?.clock ?? { now: new Date().toISOString(), seed: 1 },
    });
  } catch (err) {
    // A malformed book (illegal address/sheet name) throws instead of
    // computing; callers must still get a report, never an exception.
    for (const [key, formula] of formulas) {
      const bang = key.indexOf("!");
      errors.push({
        sheet: key.slice(0, bang),
        cell: key.slice(bang + 1),
        formula,
        error: "#ERROR!",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    return { errors, computed };
  }

  // Diagnostics are the single source of truth for failures: every cell
  // that errored AND every formula stopped by a circular reference lands
  // here with its reason (and check/function codes for unsupported input).
  for (const d of result.diagnostics) {
    if (d.kind === "cell") {
      const key = d.sheet + "!" + d.cell;
      const reason = d.check ? `${d.reason} (${d.check}${d.fn ? ":" + d.fn : ""})` : d.reason;
      errors.push({ sheet: d.sheet, cell: d.cell, formula: formulas.get(key) ?? "", error: errorText(d.error), reason });
    } else {
      // Name-level issues (defined-name problems) carry no cell error code;
      // surface them as #NAME? with their reason.
      const n = d as unknown as { sheet?: string; name?: string; reason?: string };
      errors.push({ sheet: n.sheet ?? "", cell: n.name ?? "", formula: "", error: "#NAME?", reason: n.reason });
    }
  }
  const failed = new Set(errors.map((e) => e.sheet + "!" + e.cell));

  for (const sheet of result.sheets) {
    for (const [address, cell] of Object.entries(sheet.cells)) {
      const key = sheet.name + "!" + address;
      // Formula cells participate by definition; spilled-into blank cells
      // (spillOf) join so the preview shows the array like Excel does.
      if (!formulas.has(key) && !cell.spillOf) continue;
      if (failed.has(key)) continue; // CYCLE / error values: flagged, never cached
      const v = cell.value;
      if (v === null || typeof v === "object") continue; // empty / {error}
      computed.set(key, v);
    }
  }
  return { errors, computed };
}

/** Static sanity check (fence repair): does the text parse as a formula at all? */
export function formulaLooksValid(formula: string): { ok: boolean; error?: string } {
  const text = xlFormula(formula);
  if (!text) return { ok: false, error: "empty formula" };
  const v = validateFormula(text);
  return v.ok ? { ok: true } : { ok: false, error: v.message };
}
