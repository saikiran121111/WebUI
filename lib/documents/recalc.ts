/**
 * Headless formula recalculation (PHASE 3 XLSX gate). LibreOffice is not
 * installed on this machine, so the mandatory "recalculate, errors_found == 0"
 * check runs through this deterministic pure-JS evaluator instead: it parses
 * every formula, validates refs against real sheet bounds, and evaluates a
 * whitelisted function set — surfacing #REF!, #DIV/0!, #VALUE!, #NAME? and
 * #N/A exactly like Excel would. Shared by the server engine and the client
 * XLSX preview.
 */

export interface RecalcCell { formula?: string; value?: string | number | boolean | null }
export interface RecalcSheet { name: string; rowCount: number; colCount: number; cells: Map<string, RecalcCell> }
export interface RecalcError { sheet: string; cell: string; formula: string; error: string }
export interface RecalcResult { errors: RecalcError[]; computed: Map<string, string | number | boolean> }

export const FORMULA_FUNCTIONS = [
  "SUM", "AVERAGE", "MIN", "MAX", "COUNT", "COUNTA", "PRODUCT", "ROUND", "ROUNDUP", "ROUNDDOWN",
  "INT", "ABS", "MOD", "POWER", "SQRT", "IF", "IFS", "IFERROR", "IFNA", "AND", "OR", "NOT",
  "SUMIF", "SUMIFS", "COUNTIF", "COUNTIFS", "AVERAGEIF", "AVERAGEIFS", "SUMPRODUCT",
  "INDEX", "MATCH", "VLOOKUP", "XLOOKUP", "NPV", "IRR",
  "DATE", "YEAR", "MONTH", "DAY", "EDATE", "EOMONTH", "TODAY",
  "LEN", "TRIM", "UPPER", "LOWER", "CONCAT", "CONCATENATE", "TEXTJOIN",
];

class FError { constructor(public code: string) {} }
const ERR = (code: string) => new FError(code);

// ---------- address utilities ----------
export function colToIdx(col: string): number {
  let n = 0;
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
export function idxToCol(idx: number): string {
  let s = "";
  let n = idx + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
export function addrKey(col: number, row: number): string { return idxToCol(col) + (row + 1); }

const CELL_RE = /(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_.]*))?!|\$?([A-Za-z]{1,3})\$?([1-9][0-9]*)/y;

// ---------- tokenizer ----------
type Tok =
  | { t: "num"; v: number } | { t: "str"; v: string } | { t: "bool"; v: boolean }
  | { t: "cell"; sheet?: string; col: number; row: number }
  | { t: "range"; sheet?: string; c1: number; r1: number; c2: number; r2: number }
  | { t: "func"; name: string } | { t: "op"; v: string } | { t: "(" } | { t: ")" } | { t: "," };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"') {
      let j = i + 1, s = "";
      while (j < n && src[j] !== '"') { s += src[j]; j++; }
      toks.push({ t: "str", v: s }); i = j + 1; continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i;
      while (j < n && /[0-9.]/.test(src[j])) j++;
      toks.push({ t: "num", v: parseFloat(src.slice(i, j)) }); i = j; continue;
    }
    if (ch === "'" || /[A-Za-z_$]/.test(ch)) {
      CELL_RE.lastIndex = i;
      const m = CELL_RE.exec(src);
      if (m) {
        if (m[1] || m[2]) {
          // sheet prefix — must be followed by a cell ref
          const rest = src.slice(CELL_RE.lastIndex);
          const cm = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]*)/.exec(rest);
          if (cm) {
            const sheet = m[1] ?? m[2];
            const c1 = colToIdx(cm[1]), r1 = parseInt(cm[2], 10) - 1;
            i = CELL_RE.lastIndex + cm[0].length;
            if (src[i] === ":") {
              const m2 = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]*)/.exec(src.slice(i + 1));
              if (m2) {
                toks.push({ t: "range", sheet, c1, r1, c2: colToIdx(m2[1]), r2: parseInt(m2[2], 10) - 1 });
                i += 1 + m2[0].length; continue;
              }
            }
            toks.push({ t: "cell", sheet, col: c1, row: r1 }); continue;
          }
        } else {
          const col = colToIdx(m[3]), row = parseInt(m[4], 10) - 1;
          i = CELL_RE.lastIndex;
          if (src[i] === ":") {
            const m2 = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]*)/.exec(src.slice(i + 1));
            if (m2) {
              toks.push({ t: "range", c1: col, r1: row, c2: colToIdx(m2[1]), r2: parseInt(m2[2], 10) - 1 });
              i += 1 + m2[0].length; continue;
            }
          }
          toks.push({ t: "cell", col, row }); continue;
        }
      }
      // identifier → function name
      let j = i;
      while (j < n && /[A-Za-z0-9_.]/.test(src[j])) j++;
      const word = src.slice(i, j).toUpperCase().replace(/^_XLFN\./, "");
      if (src[j] === "(") { toks.push({ t: "func", name: word }); i = j; continue; }
      if (word === "TRUE") { toks.push({ t: "bool", v: true }); i = j; continue; }
      if (word === "FALSE") { toks.push({ t: "bool", v: false }); i = j; continue; }
      throw ERR("#NAME?");
    }
    if (ch === "(") { toks.push({ t: "(" }); i++; continue; }
    if (ch === ")") { toks.push({ t: ")" }); i++; continue; }
    if (ch === ",") { toks.push({ t: "," }); i++; continue; }
    const two = src.slice(i, i + 2);
    if (two === "<>" || two === "<=" || two === ">=") { toks.push({ t: "op", v: two }); i += 2; continue; }
    if ("+-*/^&=<>".includes(ch)) { toks.push({ t: "op", v: ch }); i++; continue; }
    throw ERR("#VALUE!");
  }
  return toks;
}

// ---------- parser (Pratt) ----------
type Node =
  | { k: "num" | "str" | "bool"; v: number | string | boolean }
  | { k: "cell"; sheet?: string; col: number; row: number }
  | { k: "range"; sheet?: string; c1: number; r1: number; c2: number; r2: number }
  | { k: "func"; name: string; args: Node[] }
  | { k: "un"; op: string; e: Node }
  | { k: "bin"; op: string; l: Node; r: Node };

const PREC: Record<string, number> = { "<": 1, ">": 1, "=": 1, "<>": 1, "<=": 1, ">=": 1, "&": 2, "+": 3, "-": 3, "*": 4, "/": 4, "^": 5 };

function parse(toks: Tok[]): Node {
  let p = 0;
  const peek = () => toks[p];
  const eat = () => toks[p++];

  function parsePrimary(): Node {
    const t = peek();
    if (!t) throw ERR("#VALUE!");
    if (t.t === "num") { eat(); return { k: "num", v: t.v }; }
    if (t.t === "str") { eat(); return { k: "str", v: t.v }; }
    if (t.t === "bool") { eat(); return { k: "bool", v: t.v }; }
    if (t.t === "cell") { eat(); return { k: "cell", sheet: t.sheet, col: t.col, row: t.row }; }
    if (t.t === "range") { eat(); return { k: "range", sheet: t.sheet, c1: t.c1, r1: t.r1, c2: t.c2, r2: t.r2 }; }
    if (t.t === "func") {
      eat();
      if (!FORMULA_FUNCTIONS.includes(t.name)) throw ERR("#NAME?");
      eat(); // (
      const args: Node[] = [];
      if (peek()?.t === ")") { eat(); return { k: "func", name: t.name, args }; }
      for (;;) {
        args.push(parseExpr(0));
        const nt = peek();
        if (nt?.t === ",") { eat(); continue; }
        if (nt?.t === ")") { eat(); break; }
        throw ERR("#VALUE!");
      }
      return { k: "func", name: t.name, args };
    }
    if (t.t === "(") { eat(); const e = parseExpr(0); if (peek()?.t !== ")") throw ERR("#VALUE!"); eat(); return e; }
    if (t.t === "op" && (t.v === "-" || t.v === "+")) { eat(); return { k: "un", op: t.v, e: parseUnary() }; }
    throw ERR("#VALUE!");
  }
  function parseUnary(): Node { return parsePrimary(); }
  function parseExpr(minPrec: number): Node {
    let left = parseUnary();
    for (;;) {
      const t = peek();
      if (t?.t !== "op") break;
      const prec = PREC[t.v];
      if (prec == null || prec < minPrec) break;
      eat();
      const right = parseExpr(prec + 1);
      left = { k: "bin", op: t.v, l: left, r: right };
    }
    return left;
  }
  const ast = parseExpr(0);
  if (p !== toks.length) throw ERR("#VALUE!");
  return ast;
}

// ---------- evaluator ----------
type Val = number | string | boolean | RangeVal;
interface RangeVal { __range: true; cells: (string | number | boolean | null)[][] }

interface Ctx {
  sheets: Map<string, RecalcSheet>;
  current: string;
  cache: Map<string, Val>;
  stack: Set<string>;
}

function toNum(v: Val): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    if (v === "") return 0;
    const n = Number(v);
    if (isFinite(n)) return n;
    throw ERR("#VALUE!");
  }
  throw ERR("#VALUE!");
}
function toStr(v: Val): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  throw ERR("#VALUE!");
}
function isRange(v: Val): v is RangeVal { return typeof v === "object" && v !== null && (v as RangeVal).__range === true; }
function flatten(v: Val): Val[] { return isRange(v) ? v.cells.flat().filter((c) => c != null) as Val[] : [v]; }

function matchCriteria(value: Val, criteria: Val): boolean {
  const c = toStr(criteria);
  const m = /^(<=|>=|<>|<|>|=)(.*)$/.exec(c);
  const cmp = (numSide: number | null, strSide: string) => {
    if (m) {
      const rhsRaw = m[2].trim();
      const rhsNum = Number(rhsRaw);
      const hasNum = rhsRaw !== "" && isFinite(rhsNum);
      switch (m[1]) {
        case "<": return numSide != null ? numSide < (hasNum ? rhsNum : 0) : strSide < rhsRaw;
        case ">": return numSide != null ? numSide > (hasNum ? rhsNum : 0) : strSide > rhsRaw;
        case "<=": return numSide != null ? numSide <= (hasNum ? rhsNum : 0) : strSide <= rhsRaw;
        case ">=": return numSide != null ? numSide >= (hasNum ? rhsNum : 0) : strSide >= rhsRaw;
        case "<>": return strSide.toLowerCase() !== rhsRaw.toLowerCase();
        default: return hasNum && numSide != null ? numSide === rhsNum : strSide.toLowerCase() === rhsRaw.toLowerCase();
      }
    }
    const cn = Number(c);
    if (c !== "" && isFinite(cn) && numSide != null) return numSide === cn;
    return strSide.toLowerCase() === c.toLowerCase();
  };
  const numSide = typeof value === "number" ? value : typeof value === "boolean" ? (value ? 1 : 0) : (value !== "" && isFinite(Number(value)) ? Number(value) : null);
  return cmp(numSide, toStr(value));
}

function getCellValue(ctx: Ctx, sheetName: string | undefined, col: number, row: number): Val {
  const sheet = ctx.sheets.get(sheetName ?? ctx.current);
  if (!sheet) throw ERR("#REF!");
  if (col < 0 || row < 0 || col >= sheet.colCount || row >= sheet.rowCount) throw ERR("#REF!");
  const cell = sheet.cells.get(addrKey(col, row));
  if (!cell) return 0;
  if (cell.formula) {
    const key = (sheetName ?? ctx.current) + "!" + addrKey(col, row);
    if (ctx.stack.has(key)) throw ERR("#REF!");
    if (ctx.cache.has(key)) return ctx.cache.get(key)!;
    ctx.stack.add(key);
    try {
      const v = evalFormula(ctx, cell.formula, sheetName ?? ctx.current);
      ctx.cache.set(key, v);
      return v;
    } finally {
      ctx.stack.delete(key);
    }
  }
  const v = cell.value;
  if (v == null || v === "") return 0;
  return v;
}

function getRange(ctx: Ctx, sheetName: string | undefined, c1: number, r1: number, c2: number, r2: number): RangeVal {
  const cells: (string | number | boolean | null)[][] = [];
  for (let r = r1; r <= r2; r++) {
    const rowVals: (string | number | boolean | null)[] = [];
    for (let c = c1; c <= c2; c++) {
      const v = getCellValue(ctx, sheetName, c, r);
      rowVals.push(isRange(v) ? null : (v as string | number | boolean));
    }
    cells.push(rowVals);
  }
  return { __range: true, cells };
}

function evalNode(ctx: Ctx, node: Node): Val {
  switch (node.k) {
    case "num": case "str": case "bool": return node.v;
    case "cell": return getCellValue(ctx, node.sheet, node.col, node.row);
    case "range": return getRange(ctx, node.sheet, node.c1, node.r1, node.c2, node.r2);
    case "un": {
      const v = evalNode(ctx, node.e);
      if (node.op === "-") return -toNum(v);
      return toNum(v);
    }
    case "bin": {
      const l = evalNode(ctx, node.l), r = evalNode(ctx, node.r);
      switch (node.op) {
        case "+": case "-": case "*": case "/": case "^": {
          if (isRange(l) || isRange(r)) return binRange(node.op, l, r);
          const a = toNum(l), b = toNum(r);
          if (node.op === "+") return a + b;
          if (node.op === "-") return a - b;
          if (node.op === "*") return a * b;
          if (node.op === "/") { if (b === 0) throw ERR("#DIV/0!"); return a / b; }
          return Math.pow(a, b);
        }
        case "&": return toStr(l) + toStr(r);
        default: {
          if (isRange(l) || isRange(r)) return cmpRange(node.op, l, r);
          const ls = toStr(l).toLowerCase(), rs = toStr(r).toLowerCase();
          // Never call toNum() here: it throws #VALUE! on text operands, which
          // would break legitimate text equality ("OK"="OK"). Coerce to a
          // number only when the operand is genuinely numeric (numbers,
          // booleans, numeric strings); everything else is NaN → string path.
          const toN = (v: Val): number => (typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "string" && v !== "" && isFinite(Number(v)) ? Number(v) : NaN);
          const ln = toN(l), rn = toN(r);
          const useNum = isFinite(ln) && isFinite(rn);
          switch (node.op) {
            case "=": return useNum ? ln === rn : ls === rs;
            case "<>": return useNum ? ln !== rn : ls !== rs;
            case "<": return useNum ? ln < rn : ls < rs;
            case ">": return useNum ? ln > rn : ls > rs;
            case "<=": return useNum ? ln <= rn : ls <= rs;
            case ">=": return useNum ? ln >= rn : ls >= rs;
          }
          throw ERR("#VALUE!");
        }
      }
    }
    case "func": return evalFunc(ctx, node.name, node.args);
  }
}

const truthyVal = (v: Val): boolean => (typeof v === "boolean" ? v : toNum(v) !== 0);

// ---------- array semantics (SUMPRODUCT boolean expressions) ----------
// (YEAR(D2:D501)=2026)*(MONTH(D2:D501)=1)*F2:F501 needs element-wise binary
// ops over ranges with scalar broadcast, and scalar functions mapped across
// ranges (MAP_SCALARS below).
const MAP_SCALARS = new Set(["YEAR", "MONTH", "DAY", "ROUND", "ROUNDUP", "ROUNDDOWN", "INT", "ABS", "SQRT", "NOT", "UPPER", "LOWER", "TRIM"]);

const asRange = (v: Val): RangeVal => (isRange(v) ? v : { __range: true, cells: [[v as string | number | boolean]] });
const rangeShape = (r: RangeVal): [number, number] => [r.cells.length, r.cells[0]?.length ?? 0];
function broadcastCells(r: RangeVal, rows: number, cols: number): (string | number | boolean | null)[][] {
  const [rs, cs] = rangeShape(r);
  if (rs === rows && cs === cols) return r.cells;
  if (rs === 1 && cs === 1) {
    const v = r.cells[0][0];
    return Array.from({ length: rows }, () => Array.from({ length: cols }, () => v));
  }
  throw ERR("#VALUE!");
}
function binRange(op: string, l: Val, r: Val): RangeVal {
  const a = asRange(l), b = asRange(r);
  const [ar, ac] = rangeShape(a), [br, bc] = rangeShape(b);
  const R = Math.max(ar, br), C = Math.max(ac, bc);
  const ca = broadcastCells(a, R, C), cb = broadcastCells(b, R, C);
  const cells = ca.map((row, ri) => row.map((x, ci) => {
    const y = cb[ri][ci];
    const na = x == null ? 0 : toNum(x), nb = y == null ? 0 : toNum(y);
    switch (op) {
      case "+": return na + nb;
      case "-": return na - nb;
      case "*": return na * nb;
      case "/": if (nb === 0) throw ERR("#DIV/0!"); return na / nb;
      case "^": return Math.pow(na, nb);
      default: throw ERR("#VALUE!");
    }
  }));
  return { __range: true, cells };
}
const numOrNull = (x: string | number | boolean | null): number | null =>
  (typeof x === "number" ? x : typeof x === "boolean" ? (x ? 1 : 0) : (x != null && x !== "" && isFinite(Number(x)) ? Number(x) : null));
function cmpRange(op: string, l: Val, r: Val): RangeVal {
  const a = asRange(l), b = asRange(r);
  const [ar, ac] = rangeShape(a), [br, bc] = rangeShape(b);
  const R = Math.max(ar, br), C = Math.max(ac, bc);
  const ca = broadcastCells(a, R, C), cb = broadcastCells(b, R, C);
  const cells = ca.map((row, ri) => row.map((x, ci) => {
    const y = cb[ri][ci];
    const nx = numOrNull(x), ny = numOrNull(y);
    if (nx != null && ny != null) {
      switch (op) {
        case "=": return nx === ny; case "<>": return nx !== ny; case "<": return nx < ny;
        case ">": return nx > ny; case "<=": return nx <= ny; case ">=": return nx >= ny;
      }
    }
    const sx = toStr(x ?? "").toLowerCase(), sy = toStr(y ?? "").toLowerCase();
    switch (op) {
      case "=": return sx === sy; case "<>": return sx !== sy; case "<": return sx < sy;
      case ">": return sx > sy; case "<=": return sx <= sy; case ">=": return sx >= sy;
      default: throw ERR("#VALUE!");
    }
  }));
  return { __range: true, cells };
}

// ---------- Excel date serials (1900 system; epoch = 1899-12-30) ----------
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
function toSerial(v: Val): number {
  if (typeof v === "number") return v;
  const s = toStr(v).trim();
  const t = Date.parse(s);
  if (isFinite(t)) return Math.round((t - EXCEL_EPOCH) / 86400000);
  const n = Number(s);
  if (s !== "" && isFinite(n)) return n;
  throw ERR("#VALUE!");
}
const serialToDate = (serial: number): Date => new Date(EXCEL_EPOCH + Math.round(serial) * 86400000);
function serialFromParts(y: number, m: number, d: number): number {
  const t = Date.UTC(y, m - 1, d);
  if (!isFinite(t)) throw ERR("#VALUE!");
  return Math.round((t - EXCEL_EPOCH) / 86400000);
}
function addMonthsSerial(serial: number, months: number, endOfMonth = false): number {
  const d = serialToDate(serial);
  const m = d.getUTCMonth() + 1 + months;
  const ty = d.getUTCFullYear() + Math.floor((m - 1) / 12);
  const tm = (((m - 1) % 12) + 12) % 12 + 1;
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  if (endOfMonth) return Math.round((Date.UTC(ty, tm - 1, lastDay) - EXCEL_EPOCH) / 86400000);
  const day = Math.min(d.getUTCDate(), lastDay);
  return Math.round((Date.UTC(ty, tm - 1, day) - EXCEL_EPOCH) / 86400000);
}

function evalFunc(ctx: Ctx, name: string, argNodes: Node[]): Val {
  // Short-circuit functions: their untaken branches must NOT be evaluated
  // (IF(x=0,0,=A/0) is valid Excel — eager evaluation would fake a #DIV/0!).
  if (name === "IFERROR") {
    try { return evalNode(ctx, argNodes[0]); }
    catch { return argNodes[1] != null ? evalNode(ctx, argNodes[1]) : ""; }
  }
  if (name === "IFNA") {
    try { return evalNode(ctx, argNodes[0]); }
    catch (e) {
      if (e instanceof FError && e.code === "#N/A") return argNodes[1] != null ? evalNode(ctx, argNodes[1]) : "";
      throw e;
    }
  }
  if (name === "IF") {
    const cond = evalNode(ctx, argNodes[0]);
    if (truthyVal(cond)) return argNodes[1] != null ? evalNode(ctx, argNodes[1]) : true;
    return argNodes[2] != null ? evalNode(ctx, argNodes[2]) : false;
  }
  if (name === "AND") {
    for (const a of argNodes) for (const f of flatten(evalNode(ctx, a))) if (!truthyVal(f)) return false;
    return true;
  }
  if (name === "OR") {
    for (const a of argNodes) for (const f of flatten(evalNode(ctx, a))) if (truthyVal(f)) return true;
    return false;
  }
  if (name === "IFS") {
    for (let i = 0; i + 1 < argNodes.length; i += 2) {
      if (truthyVal(evalNode(ctx, argNodes[i]))) return evalNode(ctx, argNodes[i + 1]);
    }
    throw ERR("#N/A");
  }
  const args = argNodes.map((a) => evalNode(ctx, a));
  // Scalar function over a range maps element-wise: YEAR(D2:D501) → array of
  // years, enabling SUMPRODUCT((YEAR(rng)=2026)*(MONTH(rng)=1)*vals).
  if (MAP_SCALARS.has(name) && args.some(isRange)) {
    const rng = args.find(isRange) as RangeVal;
    const others = args.filter((a) => !isRange(a));
    // MAP_SCALARS functions are total on scalars: their mapped results are never ranges.
    return { __range: true, cells: rng.cells.map((row) => row.map((c) => applyFunc(name, [c == null ? 0 : c, ...others]) as string | number | boolean | null)) };
  }
  return applyFunc(name, args);
}

function applyFunc(name: string, args: Val[]): Val {
  const nums = (vals: Val[]): number[] => vals.flatMap(flatten).filter((v) => typeof v === "number" || (typeof v === "string" && v !== "" && isFinite(Number(v)))).map((v) => typeof v === "number" ? v : Number(v));
  switch (name) {
    case "SUM": return nums(args).reduce((s, v) => s + v, 0);
    case "PRODUCT": return nums(args).reduce((s, v) => s * v, 1);
    case "AVERAGE": { const ns = nums(args); if (!ns.length) throw ERR("#DIV/0!"); return ns.reduce((s, v) => s + v, 0) / ns.length; }
    case "MIN": { const ns = nums(args); return ns.length ? Math.min(...ns) : 0; }
    case "MAX": { const ns = nums(args); return ns.length ? Math.max(...ns) : 0; }
    case "COUNT": return nums(args).length;
    case "ROUND": { const v = toNum(args[0]); const d = args[1] != null ? toNum(args[1]) : 0; const f = Math.pow(10, d); return Math.round(v * f) / f; }
    case "ABS": return Math.abs(toNum(args[0]));
    case "NOT": { const v = args[0]; return !truthyVal(v); }
    case "SUMIF": {
      const range = args[0]; const crit = args[1];
      const cells = isRange(range) ? range.cells.flat() : [range];
      const sumCells = args[2] != null ? (isRange(args[2]) ? args[2].cells.flat() : [args[2]]) : cells;
      let total = 0;
      cells.forEach((c, i) => { if (c != null && matchCriteria(c as Val, crit)) total += typeof sumCells[i] === "number" ? (sumCells[i] as number) : 0; });
      return total;
    }
    case "COUNTIF": {
      const cells = isRange(args[0]) ? args[0].cells.flat() : [args[0]];
      return cells.filter((c) => c != null && matchCriteria(c as Val, args[1])).length;
    }
    case "INDEX": {
      const r = args[0];
      if (!isRange(r)) throw ERR("#VALUE!");
      const row = toNum(args[1]); const col = args[2] != null ? toNum(args[2]) : 1;
      if (row < 1 || row > r.cells.length || col < 1 || col > (r.cells[0]?.length ?? 0)) throw ERR("#REF!");
      const v = r.cells[row - 1][col - 1];
      return v == null ? 0 : v;
    }
    case "MATCH": {
      const target = args[0];
      const cells = (isRange(args[1]) ? args[1].cells.flat() : [args[1]]).filter((c) => c != null);
      for (let i = 0; i < cells.length; i++) if (matchCriteria(cells[i] as Val, target)) return i + 1;
      throw ERR("#N/A");
    }
    case "VLOOKUP": {
      const table = args[1];
      if (!isRange(table)) throw ERR("#VALUE!");
      const colIdx = toNum(args[2]);
      if (colIdx < 1 || colIdx > (table.cells[0]?.length ?? 0)) throw ERR("#REF!");
      for (const row of table.cells) {
        if (row[0] != null && matchCriteria(row[0] as Val, args[0])) {
          const v = row[colIdx - 1];
          return v == null ? 0 : v;
        }
      }
      throw ERR("#N/A");
    }
    case "XLOOKUP": {
      const lookupCells = (isRange(args[1]) ? args[1].cells.flat() : [args[1]]).filter((c) => c != null);
      const returnCells = (isRange(args[2]) ? args[2].cells.flat() : [args[2]]);
      for (let i = 0; i < lookupCells.length; i++) {
        if (matchCriteria(lookupCells[i] as Val, args[0])) {
          const v = returnCells[i];
          return v == null ? (args[3] ?? 0) : v;
        }
      }
      if (args[3] != null) return args[3];
      throw ERR("#N/A");
    }
    case "IFS": {
      for (let i = 0; i + 1 < args.length; i += 2) {
        const c = args[i];
        if (typeof c === "boolean" ? c : toNum(c) !== 0) return args[i + 1];
      }
      throw ERR("#N/A");
    }
    case "TEXTJOIN": {
      const delim = toStr(args[0]); const ignoreEmpty = args[1] === true;
      const parts = flattenAll(args.slice(2)).map(toStr).filter((s) => (ignoreEmpty ? s !== "" : true));
      return parts.join(delim);
    }
    case "CONCATENATE": case "CONCAT": return flattenAll(args).map(toStr).join("");
    case "COUNTA": return flattenAll(args).filter((v) => v != null && v !== "").length;
    case "SUMIFS": case "COUNTIFS": case "AVERAGEIFS": {
      // args: [sum/avg range (SUMIFS/AVERAGEIFS) | none (COUNTIFS), critRange1, crit1, ...]
      const critStart = name === "COUNTIFS" ? 0 : 1;
      const firstCells = isRange(args[critStart]) ? args[critStart].cells.flat() : [args[critStart]];
      const critOk = (i: number): boolean => {
        for (let k = critStart; k + 1 < args.length; k += 2) {
          const ck = args[k];
          const cells = isRange(ck) ? ck.cells.flat() : [ck];
          const c = cells[i];
          if (c == null || !matchCriteria(c as Val, args[k + 1])) return false;
        }
        return true;
      };
      if (name === "COUNTIFS") return firstCells.filter((_, i) => critOk(i)).length;
      const sumCells = isRange(args[0]) ? args[0].cells.flat() : [args[0]];
      let total = 0, n = 0;
      for (let i = 0; i < firstCells.length; i++) {
        if (!critOk(i)) continue;
        const v = sumCells[i];
        const num = typeof v === "number" ? v : (typeof v === "string" && v !== "" && isFinite(Number(v)) ? Number(v) : null);
        if (num != null) { total += num; n++; }
      }
      if (name === "SUMIFS") return total;
      if (!n) throw ERR("#DIV/0!");
      return total / n;
    }
    case "AVERAGEIF": {
      const cells = isRange(args[0]) ? args[0].cells.flat() : [args[0]];
      const avgCells = args[2] != null ? (isRange(args[2]) ? args[2].cells.flat() : [args[2]]) : cells;
      let total = 0, n = 0;
      cells.forEach((c, i) => {
        if (c != null && matchCriteria(c as Val, args[1])) {
          const v = avgCells[i];
          const num = typeof v === "number" ? v : (typeof v === "string" && v !== "" && isFinite(Number(v)) ? Number(v) : null);
          if (num != null) { total += num; n++; }
        }
      });
      if (!n) throw ERR("#DIV/0!");
      return total / n;
    }
    case "SUMPRODUCT": {
      const arrays = args.map((a) => (isRange(a) ? a.cells.flat() : [a]));
      const len = Math.max(...arrays.map((a) => a.length));
      if (arrays.some((a) => a.length !== len && a.length !== 1)) throw ERR("#VALUE!");
      let total = 0;
      for (let i = 0; i < len; i++) {
        let prod = 1;
        for (const a of arrays) {
          const v = a.length === 1 ? a[0] : a[i];
          prod *= v == null ? 0 : toNum(v); // booleans from (YEAR(rng)=2026) → 1/0
        }
        total += prod;
      }
      return total;
    }
    case "NPV": {
      const rate = toNum(args[0]);
      const vs = nums(args.slice(1));
      return vs.reduce((s, v, i) => s + v / Math.pow(1 + rate, i + 1), 0);
    }
    case "IRR": {
      const vs = nums([args[0]]);
      if (vs.length < 2) throw ERR("#NUM!");
      const npv = (r: number) => vs.reduce((s, v, i) => s + v / Math.pow(1 + r, i), 0);
      let lo = -0.999999, hi = 1e6, flo = npv(lo), fhi = npv(hi);
      if (!isFinite(flo) || !isFinite(fhi) || flo * fhi > 0) throw ERR("#NUM!");
      for (let it = 0; it < 200; it++) {
        const mid = (lo + hi) / 2, fm = npv(mid);
        if (Math.abs(fm) < 1e-9) return mid;
        if (flo * fm <= 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
      }
      return (lo + hi) / 2;
    }
    case "ROUNDUP": { const v = toNum(args[0]); const d = args[1] != null ? toNum(args[1]) : 0; const f = Math.pow(10, d); return (v < 0 ? -1 : 1) * Math.ceil(Math.abs(v) * f) / f; }
    case "ROUNDDOWN": { const v = toNum(args[0]); const d = args[1] != null ? toNum(args[1]) : 0; const f = Math.pow(10, d); return (v < 0 ? -1 : 1) * Math.floor(Math.abs(v) * f) / f; }
    case "INT": return Math.floor(toNum(args[0]));
    case "MOD": { const a = toNum(args[0]), b = toNum(args[1]); if (b === 0) throw ERR("#DIV/0!"); return a - Math.floor(a / b) * b; }
    case "POWER": return Math.pow(toNum(args[0]), toNum(args[1]));
    case "SQRT": { const v = toNum(args[0]); if (v < 0) throw ERR("#NUM!"); return Math.sqrt(v); }
    case "LEN": return toStr(args[0]).length;
    case "TRIM": return toStr(args[0]).replace(/\s+/g, " ").trim();
    case "UPPER": return toStr(args[0]).toUpperCase();
    case "LOWER": return toStr(args[0]).toLowerCase();
    case "DATE": return serialFromParts(toNum(args[0]), toNum(args[1]), toNum(args[2]));
    case "YEAR": return serialToDate(toSerial(args[0])).getUTCFullYear();
    case "MONTH": return serialToDate(toSerial(args[0])).getUTCMonth() + 1;
    case "DAY": return serialToDate(toSerial(args[0])).getUTCDate();
    case "EDATE": return addMonthsSerial(toSerial(args[0]), args[1] != null ? toNum(args[1]) : 0);
    case "EOMONTH": return addMonthsSerial(toSerial(args[0]), args[1] != null ? toNum(args[1]) : 0, true);
    case "TODAY": { const now = new Date(); return serialFromParts(now.getFullYear(), now.getMonth() + 1, now.getDate()); }
    default: throw ERR("#NAME?");
  }
}

function flattenAll(vals: Val[]): Val[] { return vals.flatMap((v) => (isRange(v) ? v.cells.flat().filter((c) => c != null) as Val[] : [v])); }

function evalFormula(ctx: Ctx, formula: string, currentSheet: string): Val {
  const body = formula.startsWith("=") ? formula.slice(1) : formula;
  const prev = ctx.current;
  ctx.current = currentSheet;
  try {
    return evalNode(ctx, parse(tokenize(body)));
  } finally {
    ctx.current = prev;
  }
}

/**
 * Validate + evaluate every formula cell across the workbook.
 * errors_found == 0 is the mandatory XLSX build gate.
 */
export function recalcWorkbook(sheets: RecalcSheet[]): RecalcResult {
  const ctx: Ctx = { sheets: new Map(sheets.map((s) => [s.name, s])), current: "", cache: new Map(), stack: new Set() };
  const errors: RecalcError[] = [];
  const computed = new Map<string, string | number | boolean>();
  for (const sheet of sheets) {
    for (const [addr, cell] of sheet.cells) {
      if (!cell.formula) continue;
      try {
        const v = evalFormula(ctx, cell.formula, sheet.name);
        const out: string | number | boolean = isRange(v) ? "" : (typeof v === "object" ? "" : v);
        computed.set(sheet.name + "!" + addr, out);
      } catch (e) {
        const code = e instanceof FError ? e.code : "#VALUE!";
        errors.push({ sheet: sheet.name, cell: addr, formula: cell.formula, error: code });
      }
    }
  }
  return { errors, computed };
}

/** Quick syntax/whitelist check without a workbook context (used by fence repair). */
export function formulaLooksValid(formula: string): { ok: boolean; error?: string } {
  try {
    parse(tokenize(formula.startsWith("=") ? formula.slice(1) : formula));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof FError ? e.code : "#VALUE!" };
  }
}
