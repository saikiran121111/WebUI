import type { ThemeRegistration } from "shiki/types";

/**
 * Hand-tuned dual theme matched to the app's dark palette.
 * Dark: lavender keywords, green strings, blue functions, cyan types,
 * amber numbers, gray comments. Light parity kept ready for a future
 * light mode; the app currently renders dark via CSS variable switching.
 */

const darkTokens: ThemeRegistration["tokenColors"] = [
  { settings: { foreground: "#cdd3de", background: "#00000000" } },
  { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#6f737d", fontStyle: "italic" } },
  { scope: ["string", "punctuation.definition.string"], settings: { foreground: "#94c67a" } },
  { scope: ["constant.character.escape", "string.regexp"], settings: { foreground: "#e0a3a3" } },
  { scope: ["constant.numeric", "constant.language", "variable.language.this", "constant.other"], settings: { foreground: "#d9a05f" } },
  { scope: ["keyword", "keyword.control", "storage.type", "storage.modifier", "punctuation.definition.keyword"], settings: { foreground: "#b8a1e3" } },
  { scope: ["entity.name.function", "meta.function-call entity.name.function", "support.function", "variable.function"], settings: { foreground: "#6ea8e0" } },
  { scope: ["entity.name.type", "entity.name.class", "support.type", "support.class", "entity.name.namespace", "entity.type.name"], settings: { foreground: "#58c0c8" } },
  { scope: ["entity.name.tag", "meta.tag"], settings: { foreground: "#7fb2e5" } },
  { scope: ["entity.other.attribute-name"], settings: { foreground: "#d9a05f" } },
  { scope: ["variable", "variable.parameter", "meta.object.member"], settings: { foreground: "#cdd3de" } },
  { scope: ["constant.other.property", "support.variable.property", "meta.property-name"], settings: { foreground: "#9db4d0" } },
  { scope: ["operator", "punctuation.accessor"], settings: { foreground: "#98a0ab" } },
  { scope: ["punctuation", "meta.brace", "punctuation.separator", "punctuation.terminator"], settings: { foreground: "#828791" } },
  { scope: ["invalid"], settings: { foreground: "#e0a3a3", fontStyle: "underline" } },
  { scope: ["markup.heading", "entity.name.section"], settings: { foreground: "#6ea8e0", fontStyle: "bold" } },
  { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
  { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
  { scope: ["markup.list"], settings: { foreground: "#b8a1e3" } },
  { scope: ["markup.quote"], settings: { foreground: "#94c67a", fontStyle: "italic" } },
  { scope: ["markup.link", "string.other.link", "punctuation.definition.metadata"], settings: { foreground: "#6ea8e0" } },
  { scope: ["markup.raw", "markup.inline.raw"], settings: { foreground: "#94c67a" } },
  { scope: ["markup.inserted", "punctuation.definition.inserted"], settings: { foreground: "#94c67a" } },
  { scope: ["markup.deleted", "punctuation.definition.deleted"], settings: { foreground: "#e0a3a3" } },
  { scope: ["markup.changed"], settings: { foreground: "#d9a05f" } },
  { scope: ["diff.header", "meta.diff", "meta.diff.header"], settings: { foreground: "#6f737d", fontStyle: "italic" } },
];

const lightTokens: ThemeRegistration["tokenColors"] = [
  { settings: { foreground: "#3a4149", background: "#00000000" } },
  { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#7a828e", fontStyle: "italic" } },
  { scope: ["string", "punctuation.definition.string"], settings: { foreground: "#2f7d3a" } },
  { scope: ["constant.character.escape", "string.regexp"], settings: { foreground: "#b04a4a" } },
  { scope: ["constant.numeric", "constant.language", "variable.language.this", "constant.other"], settings: { foreground: "#a05a10" } },
  { scope: ["keyword", "keyword.control", "storage.type", "storage.modifier", "punctuation.definition.keyword"], settings: { foreground: "#6d4fa1" } },
  { scope: ["entity.name.function", "meta.function-call entity.name.function", "support.function", "variable.function"], settings: { foreground: "#1f6fb2" } },
  { scope: ["entity.name.type", "entity.name.class", "support.type", "support.class", "entity.name.namespace", "entity.type.name"], settings: { foreground: "#0e7490" } },
  { scope: ["entity.name.tag", "meta.tag"], settings: { foreground: "#1f6fb2" } },
  { scope: ["entity.other.attribute-name"], settings: { foreground: "#a05a10" } },
  { scope: ["variable", "variable.parameter", "meta.object.member"], settings: { foreground: "#3a4149" } },
  { scope: ["constant.other.property", "support.variable.property", "meta.property-name"], settings: { foreground: "#4a6a8a" } },
  { scope: ["operator", "punctuation.accessor"], settings: { foreground: "#5b6470" } },
  { scope: ["punctuation", "meta.brace", "punctuation.separator", "punctuation.terminator"], settings: { foreground: "#6b7280" } },
  { scope: ["invalid"], settings: { foreground: "#b04a4a", fontStyle: "underline" } },
  { scope: ["markup.heading", "entity.name.section"], settings: { foreground: "#1f6fb2", fontStyle: "bold" } },
  { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
  { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
  { scope: ["markup.list"], settings: { foreground: "#6d4fa1" } },
  { scope: ["markup.quote"], settings: { foreground: "#2f7d3a", fontStyle: "italic" } },
  { scope: ["markup.link", "string.other.link", "punctuation.definition.metadata"], settings: { foreground: "#1f6fb2" } },
  { scope: ["markup.raw", "markup.inline.raw"], settings: { foreground: "#2f7d3a" } },
  { scope: ["markup.inserted", "punctuation.definition.inserted"], settings: { foreground: "#2f7d3a" } },
  { scope: ["markup.deleted", "punctuation.definition.deleted"], settings: { foreground: "#b04a4a" } },
  { scope: ["markup.changed"], settings: { foreground: "#a05a10" } },
  { scope: ["diff.header", "meta.diff", "meta.diff.header"], settings: { foreground: "#7a828e", fontStyle: "italic" } },
];

export const DARK_THEME_NAME = "webui-dark";
export const LIGHT_THEME_NAME = "webui-light";

export const darkTheme: ThemeRegistration = {
  name: DARK_THEME_NAME,
  type: "dark",
  colors: { "editor.background": "#00000000" },
  tokenColors: darkTokens,
};

export const lightTheme: ThemeRegistration = {
  name: LIGHT_THEME_NAME,
  type: "light",
  colors: { "editor.background": "#00000000" },
  tokenColors: lightTokens,
};
