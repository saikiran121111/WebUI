/**
 * F76 defect-1 acceptance probe (attended policy: manual, never a gate).
 *
 * The user's live failure: the scanned d1 page-6 amount 4,18,25,000 (value
 * 41,825,000 = 4.1825 crore) was rendered as ₹418,250,000 / ₹41.825 crore —
 * a 10x re-grouping error AT THE MODEL-ANSWER STAGE (extraction delivered the
 * correct figure verbatim, probes f74i/f74a). No chat calculator capability
 * exists in this product (inventory: spreadsheet recalculation only), so the
 * fix is a delivery-contract law: quote figures digit-for-digit; when a
 * restatement is requested, state the conversion and verify the value.
 *
 * The probe rides the routes the browser exercises:
 *   pdf cases: POST /api/files/extract (raw bytes) then the parts lib/chat/
 *     client.ts builds for the delivered text (inline default branch);
 *   inline cases: the same default-branch shape around frozen synthetic docs.
 * Answers are scored against docs/overnight/fixtures/f76/numeric-answer-key.json
 * (f76-numeric-1, frozen model-free before any model ran). Scoring is
 * UNIVERSAL — content-neutral value audit: every in-scope figure (currency-
 * marked or scale/unit-suffixed) is converted to its numeric value and must
 * equal one of the case's accepted values. A right read inside a contradictory
 * answer FAILS: the wrong-valued figure is caught even when the right digits
 * also appear. No fixture number, currency word or unit string lives in this
 * file's logic — scope tokens and expectations all come from the key.
 *
 * Usage:
 *   node docs/overnight/probes/f76_numeric_fidelity_probe.mjs [--selftest] [caseId...]
 *   node docs/overnight/probes/f76_numeric_fidelity_probe.mjs --rescore docs/overnight/logs/f76-num-*.json
 *     (re-scores saved answers with the current scorer — model-free)
 *   F76_DEBUG_AUDIT=1 dumps every in-scope figure, exclusion and decomposition
 *   RUKE_F76_LAW=1 mirrors the post-fix delivery law in the parts (keep in
 *   step with NUMERIC_FIDELITY_LAW in lib/chat/client.ts); without it the
 *   parts mirror today's pre-law production wording (baseline sampling).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const BASE = process.env.RUKE_BASE ?? "http://localhost:3000";
const KEY = JSON.parse(fs.readFileSync(process.env.RUKE_F76_NUM_KEY
  ?? path.join("docs", "overnight", "fixtures", "f76", "numeric-answer-key.json"), "utf8"));
const WITH_LAW = process.env.RUKE_F76_LAW === "1";
// NUMERIC_FIDELITY_LAW mirror — keep in step with lib/chat/client.ts.
const LAW =
  "When quoting a figure from the material, keep its exact digits and digit grouping. When restating " +
  "a figure in different units or a different grouping convention, state the exact conversion being " +
  "applied and verify the restated figure has the same value; never give two versions of one figure " +
  "that have different values. This applies to every restated version anywhere in the answer, " +
  "including brief asides.";

const argv = process.argv.slice(2);
const SELFTEST = argv.includes("--selftest");
const only = argv.filter(a => !a.startsWith("--"));
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 15);

const collapse = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// --------------------------------------------------------------- value audit
// Converts every IN-SCOPE figure in an answer to a plain number and compares
// against accepted values. In scope = currency-marked (mark before or after)
// or suffixed with a scale word / unit from the case's scope config.
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
// Value audit v2 — refined OFFLINE against saved live answers (no model),
// never by loosening the contradiction law itself (the selftest fail-strings
// must keep failing). Universal in-scope rules, all driven by the case's
// scope config:
//  * a currency mark counts only ADJACENT (≤3 chars, no operators) — loose
//    windows caught "789 = ₹12..." and "₹12,34,56,789 ÷ 1,00,00,000";
//  * scale-suffixed figures are always in scope (lakh/crore/million ARE
//    restatement vocabulary), EXCEPT when the law itself asks for them:
//      - a conversion FACTOR as a definition: "1 crore = 1,00,00,000",
//        "× 1000 µg/mg" (n==1 + "=" ahead, or a slash-ratio right behind);
//      - a physical measurement behind the scale word ("1.4 million m³")
//        — scope.measure_next lists the case's measurement units;
//  * an ADDITIVE RUN (a place-value decomposition used to verify: "4 crore,
//    18 lakh, 25 thousand", "12 crore + 34 lakh + 56 thousand 789") is one
//    verification, not several claims: if the components sum to an accepted
//    value they are all explained; a decomposition that sums WRONG stays
//    flagged (41 crore, 82 lakh, 50 thousand = 418,250,000 fails).
// v3 (F76 live-run audit, still scorer-side only — expectations untouched):
//  * a scale-suffixed figure followed by a plain UNIT word ("1.4 million
//    cubic metres") is a measurement, not an amount restatement — the unit
//    class is generalized from the case's measure_next symbols; only ever
//    for an UNMARKED figure behind a counting scale, and never when the
//    follower is a connector/currency/scale word, so money phrasing stays
//    in scope;
//  * a run may span a component ECHO ("₹12 crore = 12,00,00,000; ₹0.34568
//    crore = …"): gap digits allowed only if each equals a component's own
//    value; and the run's one attached figure may be currency-marked
//    ("56 thousand, 789 rupees") — attach only when the sum needs it;
//  * a DENOUNCED restatement — the answer states an accepted exact figure
//    and explicitly marks another version as NOT the same value ("the
//    shorthand ₹12.35 crore is not the same value — it adds ₹4,311") — is
//    the law working, not the defect: no two versions are ASSERTED. The
//    exemption is anchored (an accepted figure must be present) and
//    local (a wrong figure asserted anywhere is still flagged at that
//    assertion; "not X — the value is Y" fails with Y asserted).
// v4 (live-run 2 audit, still scorer-side only — expectations untouched):
//  * HEDGES are sentence-scoped, not adjacent-only: "Rounded alternatives,
//    if a shorter form is needed: ₹12.35 crore (to 2 decimals) … the
//    exact-value version remains ₹12.3456789 crore" LABELS the figure as a
//    rounding — the same class as an adjacent "≈". A hedge never exempts a
//    wrong value: it only lowers the comparison to the case's
//    approx_tolerance, so a 10x/1000x restatement (hundreds of percent off)
//    stays flagged no matter what hedge vocabulary surrounds it; the
//    selftest pins exactly that (a "rounded short form" that is 10x off
//    must keep failing).
//  * denouncement windows are sentence-scoped too (a renunciation speaks
//    about the figure IN ITS SENTENCE), and an approx-flagged figure can
//    still be denounced (the two mechanisms are orthogonal).
// v5 (rescore of the same audit, still scorer-side only — expectations
// untouched):
//  * A place-value check may expand EACH component as its own multiplication
//    ("4 crore (4 × 10,000,000) + 18 lakh (18 × 100,000)") — echo in another
//    form. gapEcho now accepts a gap digit equal to a component's printed
//    coefficient, its scaled value, or its unit multiplier (= value ÷
//    coefficient — e.g. 10,000,000 for a crore component), and the residue
//    additionally allows multiplication punctuation (× ( ) ). Nothing else:
//    any word or foreign digit still breaks the run. Runs still only COUNT
//    when their sum is near an accepted value, so a decomposition that sums
//    wrong stays flagged no matter how well-formed its gaps are (selftest
//    pins the wrong-multiplication shape as a KEEP-FAILING case).
//  * markdown code spans count as mark adjacency: a figure quoted as
//    `4,18,25,000` rupees is audited like an unquoted one (the closer class
//    now includes the backtick — a strictly-inclusive change: figures that
//    were invisible to the audit become auditable).
// v6 (live-run 3 audit, still scorer-side only — expectations untouched):
//  * a CURRENCY-MARKED figure followed by a TRUE product identity ("₹12 ×
//    100,000 = 1,200,000") is a place-value component written as its own
//    multiplication: the term's audited value is the product, and the figure
//    on the identity's right side is an echo of that same term — skipped as a
//    separate claim so it cannot hijack the attach step (an independent
//    figure could), while its digits still only verify their own identity
//    through gapEcho. A FALSE identity ("₹12 × 100,000 = 1,300,000")
//    converts NOTHING: the marked coefficient stays an audited claim and the
//    wrong product stays visible — fail-closed, pinned as a KEEP-FAILING case;
//  * a run may also COMPLETE across an echo gap ("… ₹34 × 1,000 = 34,000;
//    + 567") — the attach step gains the same digit/residue discipline as run
//    extension, still only when the sum needs the figure to reach an accepted
//    value;
//  * SI space grouping is a recognized digit form: "125 000 µg" is 125,000 µg
//    (0.125 g), not "125" and a phantom "000". An ambiguous merge ("page 6
//    100") can only ever land on an UNMARKED bare figure, which the audit
//    never flags; a MERGED figure that carries the wrong value still fails
//    ("4 500 µg" is 1000x off and keeps failing — merging never launders).
// v7 (live-run 4 audit, scorer-side only — expectations untouched):
//  * a SCALE-WORD term restated as an EQUALITY identity in digits ("8 lakh =
//    800,000") is ONE term spelled twice: the digits are an echo of that same
//    term — skipped as an independent claim (so its value cannot double up and
//    hijack the attach step) — while the term itself stays fully audited and
//    only becomes explained when it decomposes an accepted value. A FALSE
//    spelling ("8 lakh = 810,000") echoes NOTHING — the marked/scale term
//    remains an audited claim carrying its own (wrong) value: fail-closed,
//    pinned KEEP-FAILING;
//  * a decomposition run may consist of a SINGLE scale-word component plus
//    the completing figure ("8 lakh = 800,000 plus 120" = 800,120): attach
//    still requires the sum to EQUAL an accepted value across the same
//    gapOk/gapEcho discipline — a lone wrong figure can never attach its way
//    to innocence (pinned: "8 lakh (= 800,000)" for an accepted 800,120 keeps
//    failing; wrong-sum decompositions keep failing).
// v8 (live-run 5 audit, scorer-side only — expectations untouched):
//  * suffix ADJACENCY: a scale/unit suffix counts only when it touches the
//    figure (whitespace between, nothing else). The old dash bridge ("1 —
//    crore") turned document STRUCTURE vocabulary — a section number before
//    an em-dash next to a heading word — into a phantom scale claim; this is
//    the same adjacency discipline the currency marks already use. Removing
//    the bridge launders nothing: an adjacent wrong scale term ("the costs
//    are 9 lakh") stays a fully audited flagged claim;
//  * gap-token WORD BOUNDARY on every alternative: the gap token regex had
//    its boundary lookahead attached to only the LAST alternative, so the
//    plural scale word "crores" inside a decomposition gap was chopped to
//    "crore" + residue "s" — exact-summing plural place-value runs ("4
//    crores 18 lakhs 25 thousand" = the accepted figure) never formed and
//    correct answers stayed flagged. The fix only lets runs FORM; a run is
//    explained solely when its sum equals an accepted value (pinned
//    KEEP-FAILING: plural decompositions with wrong sums, wrong lone scale
//    claims, wrong lone completions).
function auditValues(answer, scope, accepted, tol, debug = false) {
  const marks = (scope.marks ?? []);
  const symMarks = marks.filter(m => /[₹$£€]/.test(m)).map(esc);
  const wordMarks = marks.filter(m => !/[₹$£€]/.test(m)).map(m => esc(m));
  const markAlts = [...symMarks, ...wordMarks.map(m => `\\b${m}(?:\\b|(?![\\p{L}]))`)];
  const mapFor = (obj) => { const o = {}; for (const [k, v] of Object.entries(obj ?? {})) o[k.toLowerCase()] = v; return o; };
  const scaleL = mapFor(scope.scales), unitL = mapFor(scope.units);
  const measureNext = (scope.measure_next ?? []).map(w => w.toLowerCase());
  const allScaleUnit = [...Object.keys(scaleL), ...Object.keys(unitL)];
  // v8: the suffix must TOUCH the figure (whitespace only). A dash between
  // ("Restatement 1 — crore") is heading structure, not a scale term — the
  // bridge used to turn section numbers into phantom "1 crore" claims.
  const suffixRe = allScaleUnit.length
    ? new RegExp(`^\\s*((?:${allScaleUnit.map(k => esc(k).replace(/µ|μ/g, "[µμ]")).join("|")})(?![\\p{L}\\p{M}]))`, "iu")
    : null;
  // adjacent-mark tests (shared by the currency classifier and the unit-word
  // rule): the mark must END the lookbehind window or START the lookahead
  // (after closing punctuation/emphasis like "**" or ")") — "= ₹...",
  // "÷ 1,00,00,000" and similar operator-spanning windows are arithmetic
  // context, not a labeled figure.
  const preMarkRe = markAlts.length
    ? new RegExp(`(?:${markAlts.join("|")})[\\s"'*)\\]\`]*\\s*$`, "iu") : null;
  const postMarkRe = markAlts.length
    ? new RegExp(`^[\\s)"'\\]*_\`]{0,4}(?:${markAlts.join("|")})(?![\\p{L}\\p{M}])`, "iu") : null;
  // general measurement test: a COUNTING-scale figure with no currency mark,
  // followed by a real (non-connector, non-currency, non-scale, alphabetic)
  // word, is a quantity — "1.4 million cubic metres", not a restated amount.
  const CONNECTORS = new Set(["of", "for", "to", "in", "at", "by", "from", "and", "or", "the",
    "a", "an", "is", "was", "were", "it", "its", "that", "this", "these", "those", "each", "per",
    "as", "on", "with", "without", "over", "under", "above", "below", "between", "about", "nearly",
    "almost", "roughly", "approximately", "equivalent", "equals", "equal", "meaning", "written",
    "read", "reads", "grouped", "restated", "total", "totalling", "totaling", "worth", "same",
    "called", "times", "plus", "minus", "out", "up", "down", "i.e", "ie", "e.g", "eg"]);
  const markWords = marks.map(m => m.toLowerCase());
  const isUnitWord = (w, nextWord, hasMark) =>
    !hasMark && scaleL[w] != null && nextWord.length > 1 && /[a-z]/i.test(nextWord) && !/^\d/.test(nextWord)
    && !CONNECTORS.has(nextWord) && !markWords.includes(nextWord) && !allScaleUnit.includes(nextWord);

  // sentence windows around a figure: a "." INSIDE a number is never a break;
  // breaks are [.!?] followed by space/quote/end, or a newline. Hedges and
  // renunciations only speak about figures IN THEIR SENTENCE.
  const HEDGE = /(≈|~|\babout\b|\broughly\b|\bapproximately\b|\bapprox\b|approx\.|\bnearly\b|close to|\bround\w*|\bestimat\w*|\bshorthand\b|short(?:er)? form|decimals?\b|decimal places|to \d+ dec)/i;
  const SENT = /(?:[.!?](?=[\s"')\]]|$)|\n)/g;
  const backWin = (s) => {
    const w = answer.slice(Math.max(0, s - 60), s);
    SENT.lastIndex = 0; let cut = 0, wm;
    while ((wm = SENT.exec(w))) cut = wm.index + wm[0].length;
    return w.slice(cut);
  };
  const fwdWin = (e) => {
    const w = answer.slice(e, e + 60);
    SENT.lastIndex = 0; const wm = SENT.exec(w);
    return wm ? w.slice(0, wm.index) : w;
  };

  const hits = [];
  const bare = []; // unmarked figures: never flagged alone, but may complete a decomposition run
  // a figure starts clean and ENDS on a digit — a trailing "," truncation
  // (backtracking "12,34,56,789." down to "12,34,56") is what produced a
  // phantom flag; (?!,\d) keeps the match from stopping one group early.
  // v6: SI space grouping ("125 000 µg") is one figure, not two — see header.
  const numRe = /(?<![\w.,])(\d[\d,]*\d|\d)(?:[ ]\d{3})*(?:\.\d+)?(?![\w])(?!,\d)/g;
  // identity echoes (v6/v7): absolute positions of right-hand figures that
  // restate an already-audited term — skipped as independent claims.
  const echoPos = new Map();
  let m;
  while ((m = numRe.exec(answer))) {
    const start = m.index, end = m.index + m[0].length;
    const post = answer.slice(end, end + 26);
    if (/^[eE][-+]?\d/.test(post)) continue; // scientific notation — not our formats
    if (echoPos.has(start)) { if (debug) console.error(`  audit-skip ${m[0]} (product-identity echo)`); continue; }
    const pre = answer.slice(Math.max(0, start - 14), start);
    let value = Number(m[0].replace(/[,\s]/g, ""));
    let kind = null, word = null;
    const hasMark = Boolean(preMarkRe?.test(pre) || postMarkRe?.test(post));
    const sm = suffixRe?.exec(post);
    if (sm) {
      const w = sm[1].toLowerCase().replace(/μ/g, "µ");
      const f = scaleL[w] ?? unitL[w];
      if (f != null) {
        const after = post.slice(sm[0].length).trimStart();
        const isFactor = (Number(m[0].replace(/[,\s]/g, "")) === 1 && /^\s*[=≈]/.test(after))
          || /^\s*[\p{L}µμ]*\/[\p{L}µμ]+/u.test(after); // "µg/mg"-style ratio
        const nextWord = after.match(/^([\p{L}µμ\d°²³√/]+)(?![\p{L}])/u)?.[1]?.toLowerCase() ?? "";
        const isMeasure = !isFactor && (measureNext.includes(nextWord) || isUnitWord(w, nextWord, hasMark));
        if (!isFactor && !isMeasure) { kind = "scale"; word = w; value *= f; }
        else if (debug) console.error(`  audit-skip ${m[0]} ${w} (${isFactor ? "factor" : "measure " + nextWord})`);
      }
    }
    // a figure sitting on the right side of a unit DEFINITION ("1 crore =
    // 1,00,00,000", "1 mg = 1000 µg") is conversion vocabulary the law itself
    // asks for, not a claim about the material's amounts.
    const preF = answer.slice(Math.max(0, start - 26), start);
    const factorDef = new RegExp(
      `(?:^|[^\\w.])1\\s*(?:${allScaleUnit.length ? allScaleUnit.map(k => esc(k).replace(/µ|μ/g, "[µμ]")).join("|") : "(?!x)x"})\\s*[=≈]\\s*(?:(?:${markAlts.join("|")})\\s*)?$`,
      "iu");
    const isFactorDef = allScaleUnit.length && factorDef.test(preF);
    if (kind == null && !isFactorDef && hasMark) kind = "currency";
    if (isFactorDef && kind === "currency" && debug) console.error(`  audit-skip ${m[0]} (unit-definition RHS)`);
    if (isFactorDef) kind = null;
    // v6: a currency-marked figure followed by a TRUE product identity is a
    // place-value component written as its multiplication ("₹12 × 100,000 =
    // 1,200,000") — the term's audited value is the PRODUCT, and the product
    // figure is recorded as an echo of this same term. A FALSE identity
    // converts nothing (fail-closed): the marked coefficient stays an audited
    // claim and the wrong product stays visible as its own figure.
    if (kind === "currency" && word == null) {
      const postF = answer.slice(end, end + 44);
      const idm = /^\s*[×x*]\s*(\d[\d,]*(?:[ ]\d{3})*|\d)\s*=\s*(\d[\d,]*(?:[ ]\d{3})*|\d)(?![\w.])/.exec(postF);
      if (idm) {
        const mul = Number(idm[1].replace(/[,\s]/g, ""));
        const prod = Number(idm[2].replace(/[,\s]/g, ""));
        if (Number.isFinite(mul) && Number.isFinite(prod)
            && Math.abs(value * mul - prod) <= 1e-9 + 1e-9 * Math.abs(prod)) {
          const pStart = end + idm[0].length - idm[2].length; // the match ENDS on the product figure
          echoPos.set(pStart, pStart + idm[2].length);
          if (debug) console.error(`  audit-product ${m[0]} × ${idm[1]} = ${idm[2]} (identity verified, product echo at ${pStart})`);
          value = prod; word = "×"; // now a run component, coeff kept in raw
        } else if (debug) {
          console.error(`  audit-flaggap ${m[0]} × ${idm[1]} ≠ ${idm[2]} (false identity — nothing absorbed)`);
        }
      }
    }
    // v7: a SCALE-WORD term restated by an equality identity in digits ("8 lakh
    // = 800,000") is one term spelled twice — the digits are an echo of this
    // same term (skipped as an independent claim, so the value cannot double up
    // against the attach step), while the term itself stays fully audited. A
    // FALSE spelling ("8 lakh = 810,000") echoes NOTHING — the scale term keeps
    // its own (wrong) value as an audited claim: fail-closed.
    if (kind != null && word != null && word !== "×" && scaleL[word] != null) {
      const postF = answer.slice(end, end + 30);
      const eqm = new RegExp(
        `^\\s*=\\s*(?:(?:${markAlts.join("|")})\\s*)?(\\d[\\d,]*(?:[ ]\\d{3})*|\\d)(?![\\w.])`).exec(postF);
      if (eqm) {
        const spelled = Number(eqm[1].replace(/[,\s]/g, ""));
        if (Number.isFinite(spelled)
            && Math.abs(value - spelled) <= 1e-9 + 1e-9 * Math.abs(value)) {
          const pStart = end + eqm[0].length - eqm[1].length; // the match ENDS on the digit form
          echoPos.set(pStart, pStart + eqm[1].length);
          if (debug) console.error(`  audit-spell ${m[0]} ${word} = ${eqm[1]} (identity verified, digit echo at ${pStart})`);
        } else if (debug) {
          console.error(`  audit-flaggap ${m[0]} ${word} ≠ ${eqm[1]} (false spelling — nothing absorbed)`);
        }
      }
    }
    if (kind == null) { bare.push({ start, end, value }); continue; } // date, page, percent, unmarked figure
    // hedge (v4): the qualifier may sit anywhere in the figure's sentence
    // ("Rounded alternative: … (to 2 decimals) … the exact version remains …"),
    // not only adjacent. Being hedged only lowers the comparison to the case's
    // approx_tolerance — a figure HUNDREDS of percent off stays flagged no
    // matter what hedge vocabulary surrounds it (see header law).
    const approx = HEDGE.test(backWin(start)) || HEDGE.test(fwdWin(end));
    hits.push({ raw: m[0], word, value, approx, start, end });
    if (debug) console.error(`  audit-hit  ${m[0]}${word ? " " + word : ""} = ${value} <<${JSON.stringify(pre.slice(-12))}|${JSON.stringify(post.slice(0, 14))}>>`);
  }

  // Additive runs: consecutive scale-suffixed figures separated ONLY by
  // whitespace/separators/scale words may be one place-value decomposition
  // ("4 crore, 18 lakh, 25 thousand" / "12 crore + 34 lakh + 56 thousand
  // 789" — the last one completed by a single unmarked figure). If the
  // components sum to an accepted value the decomposition is the answer
  // VERIFYING its own restatement (what the law asks for) — explained.
  // A decomposition that sums wrong is exactly the defect and stays flagged.
  // v8: the boundary lookahead must wrap the WHOLE alternative list — with it
  // attached to only the last alternative, "crores" in a gap was chopped to
  // "crore" + residue "s" and correct plural decompositions never formed.
  const gapTok = new RegExp(
    `(?:(?:${[...allScaleUnit, "and", "plus"].map(k => esc(k).replace(/µ|μ/g, "[µμ]")).join("|")})(?![\\p{L}\\p{M}])|[\\s,+&])+`,
    "giu");
  const gapOk = (g) => g.length > 0 && g.length <= 30 && g.replace(gapTok, "") === "";
  const near = (s) => accepted.some(a => Math.abs(s - a) <= 1e-9 + 1e-6 * Math.abs(a));
  // ECHO gap ("₹12 crore = 12,00,00,000; ₹0.34568 crore …", or the expanded
  // multiplication "4 crore (4 × 10,000,000) + 18 lakh …"): the arithmetic
  // restatement of a component sits between components. Digits in the gap are
  // allowed ONLY where each equals a run component's own scaled value, its
  // printed coefficient, or its unit multiplier (v5 — the coefficient × the
  // multiplier IS the component); the residue must be pure assignment /
  // multiplication vocabulary (= → ≈ × parentheses bullet mark) — an "or" or
  // any other word or foreign digit breaks the run, so alternatives never
  // masquerade as sums.
  const gapEcho = (g, run) => {
    if (g.length === 0 || g.length > 48) return false;
    const allowed = run.flatMap(c => {
      const a = [c.value, Number(c.raw)];
      const coeff = Number(c.raw);
      if (Number.isFinite(coeff) && coeff !== 0) a.push(c.value / coeff); // its unit multiplier
      return a;
    });
    const gm = /(?<![\w.,])(\d[\d,]*\d|\d)(?:[ ]\d{3})*(?:\.\d+)?(?![\w])(?!,\d)/g;
    let mm, n = 0;
    while ((mm = gm.exec(g))) {
      n++;
      const v = Number(mm[0].replace(/[,\s]/g, ""));
      if (!allowed.some(x => Number.isFinite(x) && Math.abs(v - x) <= 1e-9 + 1e-6 * Math.abs(x))) return false;
    }
    if (n === 0) return false;
    let rest = g.replace(/(?<![\w.,])\d[\d,]*\d|\d/g, "").replace(gapTok, "");
    rest = rest.replace(/[=→≈~–—*_.;,\s×()]/g, "").replace(/-/g, "");
    for (const mk of markWords) rest = rest.split(mk).join("");
    return rest.trim() === "";
  };
  const explained = new Set();
  const used = new Set();
  // one figure may COMPLETE a run beyond the scale-word components: unmarked
  // (v2) or currency-suffixed ("56 thousand, 789 rupees") — attach ONLY when
  // the sum needs it, so an already-matching run can never be broken. v6: the
  // completing figure may sit behind an ECHO gap ("… ₹34 × 1,000 = 34,000;
  // + 567") — same digit/residue discipline as run extension. v7: a run may
  // also be a SINGLE scale-word component plus its completing figure
  // ("8 lakh … plus 120" = 800,120) — the sum must still equal an accepted
  // value, so a lone wrong figure can never attach its way to innocence.
  const attachable = [...bare, ...hits.filter(h => h.word == null)];
  for (let i = 0; i < hits.length; i++) {
    if (explained.has(hits[i]) || hits[i].word == null) continue;
    const run = [hits[i]];
    let sum = hits[i].value;
    let j = i + 1;
    while (j < hits.length) {
      const gap = answer.slice(run[run.length - 1].end, hits[j].start);
      if (hits[j].word != null && !explained.has(hits[j]) && (gapOk(gap) || gapEcho(gap, run))) {
        run.push(hits[j]); sum += hits[j].value; j++;
      } else break;
    }
    let matched = run.length >= 2 && near(sum);
    if (!matched) {
      for (const b of attachable) {
        if (used.has(b) || explained.has(b) || b.start < run[run.length - 1].end) continue;
        const agap = answer.slice(run[run.length - 1].end, b.start);
        if (gapOk(agap) || gapEcho(agap, run)) {
          if (near(sum + b.value)) { // v7: single-component runs may complete too (see header)
            used.add(b); explained.add(b); sum += b.value; matched = true;
          }
          break;
        }
      }
    }
    if (matched) {
      for (const k of run) explained.add(k);
      if (debug) console.error(`  audit-decomposition sum=${sum} [${run.map(k => k.raw + " " + (k.word ?? "")).join(" + ")}]`);
    }
  }
  // DENOUNCED restatements — see header law above. Anchored (an accepted
  // figure must actually be present), local (windows around the figure only)
  // and exact-hit-safe: a wrong figure ASSERTED anywhere is still flagged.
  const anchor = hits.some(h => near(h.value));
  const DEN1 = /\bnot\b[^.;!?]{0,25}\b(same|equal|equivalent|identical)\b/i;
  const DEN2 = /\b(overstat\w*|understat\w*|off by|inaccurate\w*|inexact|discrepan\w*)\b/i;
  const DEN3 = /\b(caution\w*|warning\w*|beware|avoid\w*|mistake|trap|pitfall\w*|rather\s+than|instead\s+of|misread\w*)\b/i;
  const denounced = (h) => {
    // approx-flagged figures can be denounced too (the mechanisms are
    // orthogonal: a hedge explains ROUNDING, a renunciation explains
    // NON-EQUILENCE; either may apply, and near-accepted figures never need one).
    if (!anchor || near(h.value)) return false;
    const strip = (s) => s.replace(/[*_`]/g, " ");
    const pre = strip(backWin(h.start));   // sentence-scoped (v4)
    const post = strip(fwdWin(h.end));
    return DEN1.test(pre) || DEN1.test(post) || DEN2.test(pre) || DEN2.test(post) || DEN3.test(pre);
  };
  const flagged = hits.filter(h => !explained.has(h));
  if (debug) for (const h of flagged) if (denounced(h)) console.error(`  audit-skip ${h.raw}${h.word ? " " + h.word : ""} (denounced restatement)`);
  return flagged.filter(h => !denounced(h));
}

function scoreCase(name, answer, expect) {
  const results = [];
  const check = (nm, ok, detail) => { results.push({ name: nm, ok, detail }); };
  const norm = collapse(answer);
  const low = norm.toLowerCase();

  let gi = 0;
  for (const group of expect.must_include_any ?? []) {
    gi++;
    const hit = group.find((alt) => low.includes(collapse(alt).toLowerCase())) ?? null;
    check(`restatement_present_g${gi}`, hit != null,
      hit ? `found "${hit}"` : `none of ${JSON.stringify(group)} present`);
  }
  for (const v of expect.verbatim ?? []) {
    check(`verbatim_${collapse(v).replace(/\W+/g, "_").slice(0, 24)}`, norm.includes(collapse(v)),
      `exact printed figure "${v}" ${norm.includes(collapse(v)) ? "present" : "ABSENT (regrouped or lost)"}`);
  }
  if (expect.page) {
    check("page_attributed", new RegExp(`page\\s*${expect.page}\\b`, "i").test(norm) || norm.includes(`p${expect.page}`),
      `key names page ${expect.page}`);
  }

  const hits = auditValues(answer, expect.scope, expect.accepted_values,
    expect.approx_tolerance ?? 0.02, process.env.F76_DEBUG_AUDIT === "1");
  const tol = expect.approx_tolerance ?? 0.02;
  const bad = hits.filter(h =>
    !expect.accepted_values.some(a => Math.abs(h.value - a) <= (h.approx ? tol : 1e-6) * Math.max(Math.abs(a), 1e-9)));
  check("no_contradictory_figure", bad.length === 0,
    bad.length
      ? `figure(s) with values outside the accepted set: ${bad.map(b => `${b.raw}${b.word ? " " + b.word : ""} = ${b.value}${b.approx ? " (~)" : ""}`).join(" | ")}`
      : `${hits.length} in-scope figure(s) all equal an accepted value`);
  check("audit_found_figures", hits.length > 0, `${hits.length} in-scope figure(s) audited`);
  return results;
}

function reportCase(id, results, extra) {
  for (const r of results) console.log(`${r.ok ? "ok  " : "MISS"} ${id} :: ${r.name}${r.detail ? ` - ${r.detail}` : ""}`);
  const ok = results.every(r => r.ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${extra ? ` - ${extra}` : ""}\n`);
  return ok;
}

// ------------------------------------------------------------------ selftest
if (SELFTEST) {
  let bad = 0;
  for (const [id, groups] of Object.entries(KEY.selftest ?? {})) {
    const c = KEY.cases.find(x => x.id === id);
    for (const s of groups.pass ?? []) {
      const rs = scoreCase(id, s, c.expect);
      if (!rs.every(r => r.ok)) { bad++; console.log(`SELFTEST FAIL: expected PASS but scorer says no -> ${s}`); }
      else console.log(`selftest pass-string scored PASS  ${id}  "${s.slice(0, 60)}..."`);
    }
    for (const s of groups.fail ?? []) {
      const rs = scoreCase(id, s, c.expect);
      if (rs.every(r => r.ok)) { bad++; console.log(`SELFTEST FAIL: scorer let a defective answer through -> ${s}`); }
      else console.log(`selftest fail-string scored FAIL ${id}  (${rs.filter(r => !r.ok).map(r => r.name).join(", ")})  "${s.slice(0, 60)}..."`);
    }
  }
  console.log(bad ? `SELFTEST FAIL (${bad})` : "SELFTEST PASS - scorer discriminates correctly");
  process.exit(bad ? 1 : 0);
}

// ------------------------------------------------------------------- rescore
// Re-score SAVED live answers with the current scorer — the offline iteration
// loop for scorer refinement (no model, no Strata). Fail-strings pinned in the
// key's selftest must keep failing; correct saved answers must score clean.
if (argv.includes("--rescore")) {
  for (const p of only) {
    const d = JSON.parse(fs.readFileSync(p, "utf8"));
    const c = KEY.cases.find(x => x.id === d.case);
    if (!c) { console.log(`?? ${p}: unknown case ${d.case}`); continue; }
    const rs = scoreCase(d.case, d.chat?.answer ?? "", c.expect);
    const miss = rs.filter(r => !r.ok);
    console.log(`${miss.length ? "FAIL" : "PASS"} ${p} (${d.case}, law=${d.law_mirror ? "on" : "off"})` +
      (miss.length ? `\n  ${miss.map(r => `${r.name}: ${r.detail}`).join("\n  ")}` : ""));
  }
  process.exit(0);
}

// ---------------------------------------------------------------- live cases
const cases = KEY.cases.filter(c => only.length === 0 || only.includes(c.id));
let allOk = true;
for (const c of cases) {
  console.log(`=== ${c.id}: ${c.desc}`);
  let text;
  if (c.deliver.mode === "pdf") {
    const attId = "f76num-" + crypto.randomBytes(6).toString("hex");
    const extRes = await fetch(`${BASE}/api/files/extract?name=${encodeURIComponent(c.deliver.name)}&att=${attId}`, {
      method: "POST", body: fs.readFileSync(c.deliver.file), headers: { "content-type": "application/pdf" },
    });
    const ext = await extRes.json().catch(() => null);
    if (!extRes.ok || !ext || ext.error) {
      console.log(`FAIL ${c.id} - extract precondition ${extRes.status} ${JSON.stringify(ext?.error ?? "")}\n`);
      allOk = false; continue;
    }
    text = ext.text ?? "";
    console.log(`extract: chars=${text.length} indexed=${ext.indexed} pages=${ext.pages ?? null}`);
  } else {
    text = c.deliver.text;
  }

  // the turn exactly as the browser's client.ts default text branch builds it
  const label = `Attached file: ${c.deliver.name}`;
  const body = `${label}\n[file content begins]\n${text}\n[file content ends]` + (WITH_LAW ? `\n${LAW}` : "");
  const parts = [{ type: "text", text: c.question }, { type: "text", text: body }];

  const chatRes = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "default", messages: [{ role: "user", content: parts }], stream: true, stream_options: { include_usage: true } }),
  });
  if (!chatRes.ok || !chatRes.body) {
    console.log(`FAIL ${c.id} - chat route ${chatRes.status}\n`);
    allOk = false; continue;
  }
  const decoder = new TextDecoder();
  let answer = "", doneFrames = 0, finishReason = null, rukeError = null, raw = "";
  const reader = chatRes.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = raw.indexOf("\n")) >= 0) {
      const line = raw.slice(0, nl).trim();
      raw = raw.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") { doneFrames++; continue; }
      let j = null;
      try { j = JSON.parse(payload); } catch { continue; }
      if (j.ruke_error) { rukeError = j.ruke_error?.message ?? JSON.stringify(j.ruke_error); continue; }
      const delta = j?.choices?.[0]?.delta;
      if (typeof delta?.content === "string") answer += delta.content;
      const fr = j?.choices?.[0]?.finish_reason;
      if (fr) finishReason = fr;
    }
  }
  answer = answer.trim();
  console.log(`finish_reason=${finishReason} doneFrames=${doneFrames} ruke_error=${rukeError ?? "none"}`);
  console.log(`answer (${answer.length} chars):\n${"─".repeat(72)}\n${answer}\n${"─".repeat(72)}`);

  const results = [
    { name: "single_stream_terminal", ok: doneFrames === 1 && finishReason !== "error" && !rukeError,
      detail: `done=${doneFrames} finish=${finishReason} error=${rukeError ?? "none"}` },
    { name: "answer_not_empty", ok: answer.length > 0, detail: `chars=${answer.length}` },
    ...scoreCase(c.id, answer, c.expect),
  ];
  const ok = reportCase(c.id, results, `law_mirror=${WITH_LAW ? "ON" : "off"}`);
  allOk = allOk && ok;
  const OUT = path.join("docs", "overnight", "logs", `f76-num-${c.id}-${stamp}.json`);
  fs.writeFileSync(OUT, JSON.stringify({
    ok, key_version: KEY.key_version, case: c.id, law_mirror: WITH_LAW,
    delivered_body: body, chat: { finishReason, doneFrames, rukeError, answer }, checks: results,
  }, null, 2), { encoding: "utf8" });
  console.log(`evidence ${OUT}\n`);
}
console.log(`${allOk ? "SUITE PASS" : "SUITE FAIL"} - ${cases.length} case(s), law_mirror=${WITH_LAW ? "ON" : "off"}`);
process.exit(allOk ? 0 : 1);
