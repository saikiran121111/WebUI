/**
 * Shared TS-interface extractor for the Part 9 contract-manifest pipeline
 * (`gen-contract-manifest.mjs` and `__tests__/rust-golden/contract-manifest.test.ts`).
 * Pure string parsing — no TS compiler — deterministic and dependency-free.
 * Extracts member name / optionality / nullability / inline-object field
 * lists from an `interface` declaration so both the generated manifest and
 * the drift tests read the SAME canonical TS source.
 */

export function stripTsComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Text of the `{...}` block whose declaration contains `declNeedle`. */
export function interfaceBlock(src, declNeedle) {
  const idx = src.indexOf(declNeedle);
  if (idx < 0) throw new Error(`declaration not found: ${declNeedle}`);
  const open = src.indexOf("{", idx);
  if (open < 0) throw new Error(`no '{' after: ${declNeedle}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces after: ${declNeedle}`);
}

/** Split an interface/inline-object body into top-level member strings. */
export function splitMembers(block) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of block) {
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    if (ch === ";" && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** First inline `{...}` object type inside a member type expression. */
function inlineObjectFields(typeExpr) {
  const open = typeExpr.indexOf("{");
  if (open < 0) return undefined;
  let depth = 0;
  for (let i = open; i < typeExpr.length; i++) {
    if (typeExpr[i] === "{") depth++;
    else if (typeExpr[i] === "}") {
      depth--;
      if (depth === 0) {
        const inner = typeExpr.slice(open + 1, i);
        return parseMembers(inner).map((m) => ({
          name: m.name,
          present: m.present,
          nullable: m.nullable,
          ...(m.fields ? { fields: m.fields } : {}),
        }));
      }
    }
  }
  return undefined;
}

function parseMembers(block) {
  const members = [];
  for (const raw of splitMembers(block)) {
    const m = raw.trim();
    if (!m) continue;
    const mm = /^(\w+)(\?)?\s*:\s*([\s\S]+)$/.exec(m);
    if (!mm) continue; // index signatures etc. — not named wire fields
    const type = mm[3].trim().replace(/;+$/, "");
    const member = {
      name: mm[1],
      present: mm[2] ? "optional-omit-when-absent" : "always-present",
      nullable: /(^|\|)\s*null\b/.test(type),
    };
    const nested = inlineObjectFields(type);
    if (nested) member.fields = nested;
    members.push(member);
  }
  return members;
}

/** Ordered field ledger for a TS interface (names, optionality, nullability, nested inline fields). */
export function extractInterface(src, declNeedle) {
  const clean = stripTsComments(src);
  return parseMembers(interfaceBlock(clean, declNeedle));
}
