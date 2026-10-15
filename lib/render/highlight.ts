import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { LanguageRegistration, ShikiTransformer } from "shiki/types";
import { darkTheme, lightTheme, DARK_THEME_NAME, LIGHT_THEME_NAME } from "./themes";
import { resolveLanguage, grammarDependencyLoader, type LangLoader } from "./languages";

/**
 * Shiki singleton: JS regex engine (no WASM), zero preloaded grammars —
 * each grammar is lazy-loaded on first use via its registry loader and
 * cached. Output uses dual-theme CSS variables so one HTML string works
 * for both palettes; the stylesheet decides which var wins.
 */

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLanguages = new Set<string>();

async function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      engine: createJavaScriptRegexEngine(),
      langs: [],
      themes: [darkTheme, lightTheme],
    }).catch(err => {
      highlighterPromise = null;
      throw err;
    });
  }
  return highlighterPromise;
}

async function ensureLanguage(key: string, loader: LangLoader): Promise<boolean> {
  if (loadedLanguages.has(key)) return true;
  try {
    const hl = await getHighlighter();
    const mod = await loader();
    // Shiki registers grammars under their own internal name; re-key them to
    // the registry key so codeToHtml({lang: key}) always resolves (e.g. the
    // "postgresql" key borrows the "sql" grammar). The old canonical name's
    // aliases must drop the new key or the alias points at itself — Shiki
    // throws "Circular alias" (proto → protobuf, lean → lean4).
    const registrations = normalizeRegistrations(mod).map(reg =>
      reg.name === key ? reg : { ...reg, name: key, aliases: (reg.aliases ?? []).filter(a => a !== key) },
    );
    await loadGrammarTree(hl, registrations);
    loadedLanguages.add(key);
    return true;
  } catch (err) {
    console.warn("[highlight] grammar load failed:", key, err);
    // A half-loaded grammar leaves unresolved embedded imports inside the
    // highlighter, and every later loadLanguage then re-validates them and
    // throws too — one bad grammar used to poison all the rest. Discard the
    // instance so the next language starts from a clean slate.
    highlighterPromise = null;
    loadedLanguages.clear();
    return false; // grammar failed to load → caller falls back to plain text
  }
}

function normalizeRegistrations(mod: {
  default: LanguageRegistration | LanguageRegistration[];
}): LanguageRegistration[] {
  return Array.isArray(mod.default) ? mod.default : [mod.default];
}

/**
 * TextMate grammars embed others (cpp embeds regexp/glsl/cpp-macro, vue
 * embeds vue-directives, typst embeds tex…). Shiki resolves those references
 * by canonical grammar name, so dependencies load first and keep their real
 * names — only the top-level grammar is re-keyed to the registry key.
 */
async function loadGrammarTree(hl: HighlighterCore, registrations: LanguageRegistration[]): Promise<void> {
  for (const reg of registrations) {
    for (const dep of reg.embeddedLangs ?? []) {
      if (hl.getLoadedLanguages().includes(dep)) continue;
      const depLoader = grammarDependencyLoader(dep);
      if (!depLoader) continue; // unknown internal grammar — tokenizing may still work
      const depRegs = normalizeRegistrations(await depLoader());
      await loadGrammarTree(hl, depRegs);
      await hl.loadLanguage(...depRegs);
    }
  }
  await hl.loadLanguage(...registrations);
}

/**
 * Shiki emits a "\n" text node between every .line span. Lines are block
 * elements (line numbers, diff tints and wrapping need that), so each raw
 * newline would also form an anonymous line box — the double spacing seen
 * between every code row. Strip them; copy uses the canonical source
 * string, never this HTML, so clipboard fidelity is untouched.
 */
const stripLineNewlines: ShikiTransformer = {
  name: "webui-strip-line-newlines",
  code(node) {
    node.children = node.children.filter(
      child => !(child.type === "text" && child.value === "\n"),
    );
  },
};

/** Marks +/-/@@ lines so the stylesheet can tint diff lines subtly. */
const diffLineClasses: ShikiTransformer = {
  name: "webui-diff-lines",
  line(node) {
    const text = lineText(node);
    if (text.startsWith("+")) addClass(node, "diff-add");
    else if (text.startsWith("-")) addClass(node, "diff-del");
    else if (text.startsWith("@@")) addClass(node, "diff-hunk");
  },
};

function lineText(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(lineText).join("");
  if (node && typeof node === "object") {
    // hast text nodes carry their characters in `value`, elements in `children`.
    const n = node as { value?: unknown; children?: unknown };
    if ("value" in n) return String(n.value ?? "");
    if ("children" in n) return lineText(n.children);
  }
  return "";
}

function addClass(node: unknown, cls: string) {
  if (!node || typeof node !== "object") return;
  // Shiki v4 line elements carry their class in `properties.class` (a plain
  // string), not hast `className` — appending there keeps one class attribute.
  const el = node as { properties?: { class?: string } };
  el.properties = el.properties ?? {};
  const existing = el.properties.class;
  el.properties.class = existing ? existing + " " + cls : cls;
}

export interface HighlightResult {
  html: string;
  label: string;
  langKey: string | null;
}

/** LRU cache: oldest entry evicted past CAP. Keyed by lang + exact code. */
const CACHE_CAP = 60;
const htmlCache = new Map<string, HighlightResult>();

export async function highlightCode(code: string, rawLang: string): Promise<HighlightResult | null> {
  const resolved = resolveLanguage(rawLang);
  if (!resolved.loader || !resolved.key) return null;

  const cacheKey = resolved.key + "\u0000" + code;
  const cached = htmlCache.get(cacheKey);
  if (cached) {
    htmlCache.delete(cacheKey);
    htmlCache.set(cacheKey, cached);
    return cached;
  }

  if (!(await ensureLanguage(resolved.key, resolved.loader))) return null;

  try {
    const hl = await getHighlighter();
    const html = await hl.codeToHtml(code, {
      lang: resolved.key,
      themes: { dark: DARK_THEME_NAME, light: LIGHT_THEME_NAME },
      defaultColor: false,
      transformers: resolved.key === "diff" ? [stripLineNewlines, diffLineClasses] : [stripLineNewlines],
    });
    const result: HighlightResult = { html, label: resolved.label, langKey: resolved.key };
    htmlCache.set(cacheKey, result);
    if (htmlCache.size > CACHE_CAP) {
      const oldest = htmlCache.keys().next().value;
      if (oldest !== undefined) htmlCache.delete(oldest);
    }
    return result;
  } catch (err) {
    console.warn("[highlight] codeToHtml failed:", resolved.key, err);
    return null;
  }
}
