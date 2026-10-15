import type { ThemeRegistration } from "shiki/types";

/**
 * Hand-tuned dual theme matched to the app's dark palette.
 * Dark: vivid lavender keywords, green strings, blue functions/tags, cyan
 * types, amber numbers and attributes, readable gray comments — One-Dark
 * level saturation without clashing with the app's slate-blue accent.
 * Light parity kept ready for a future light mode; the app currently
 * renders dark via CSS variable switching.
 */

const darkTokens: ThemeRegistration["tokenColors"] = [
  { settings: { foreground: "#d7dce5", background: "#00000000" } },
  { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#7d8493", fontStyle: "italic" } },
  { scope: ["string", "punctuation.definition.string"], settings: { foreground: "#8fd478" } },
  { scope: ["constant.character.escape", "string.regexp"], settings: { foreground: "#ef8354" } },
  { scope: ["constant.numeric", "constant.language", "variable.language.this", "constant.other"], settings: { foreground: "#e6a35c" } },
  { scope: ["keyword", "keyword.control", "storage.type", "storage.modifier", "punctuation.definition.keyword"], settings: { foreground: "#c79bf5" } },
  { scope: ["entity.name.function", "meta.function-call entity.name.function", "support.function", "variable.function"], settings: { foreground: "#6cb8ff" } },
  { scope: ["entity.name.type", "entity.name.class", "support.type", "support.class", "entity.name.namespace", "entity.type.name"], settings: { foreground: "#4fd0dc" } },
  { scope: ["entity.name.tag", "meta.tag"], settings: { foreground: "#6cb8ff" } },
  { scope: ["entity.other.attribute-name"], settings: { foreground: "#e6a35c" } },
  { scope: ["variable", "variable.parameter", "meta.object.member"], settings: { foreground: "#d7dce5" } },
  { scope: ["constant.other.property", "support.variable.property", "meta.property-name"], settings: { foreground: "#a9c9ec" } },
  { scope: ["operator", "punctuation.accessor"], settings: { foreground: "#9aa4b2" } },
  { scope: ["punctuation", "meta.brace", "punctuation.separator", "punctuation.terminator"], settings: { foreground: "#8d95a3" } },
  { scope: ["invalid"], settings: { foreground: "#f07f7f", fontStyle: "underline" } },
  { scope: ["markup.heading", "entity.name.section"], settings: { foreground: "#6cb8ff", fontStyle: "bold" } },
  { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
  { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
  { scope: ["markup.list"], settings: { foreground: "#c79bf5" } },
  { scope: ["markup.quote"], settings: { foreground: "#8fd478", fontStyle: "italic" } },
  { scope: ["markup.link", "string.other.link", "punctuation.definition.metadata"], settings: { foreground: "#6cb8ff" } },
  { scope: ["markup.raw", "markup.inline.raw"], settings: { foreground: "#8fd478" } },
  { scope: ["markup.inserted", "punctuation.definition.inserted"], settings: { foreground: "#8fd478" } },
  { scope: ["markup.deleted", "punctuation.definition.deleted"], settings: { foreground: "#f07f7f" } },
  { scope: ["markup.changed"], settings: { foreground: "#e6a35c" } },
  { scope: ["diff.header", "meta.diff", "meta.diff.header"], settings: { foreground: "#7d8493", fontStyle: "italic" } },
];

const lightTokens: ThemeRegistration["tokenColors"] = [
  { settings: { foreground: "#333b45", background: "#00000000" } },
  { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#6e7785", fontStyle: "italic" } },
  { scope: ["string", "punctuation.definition.string"], settings: { foreground: "#1a7f37" } },
  { scope: ["constant.character.escape", "string.regexp"], settings: { foreground: "#c2410c" } },
  { scope: ["constant.numeric", "constant.language", "variable.language.this", "constant.other"], settings: { foreground: "#b45309" } },
  { scope: ["keyword", "keyword.control", "storage.type", "storage.modifier", "punctuation.definition.keyword"], settings: { foreground: "#6d28d9" } },
  { scope: ["entity.name.function", "meta.function-call entity.name.function", "support.function", "variable.function"], settings: { foreground: "#0969da" } },
  { scope: ["entity.name.type", "entity.name.class", "support.type", "support.class", "entity.name.namespace", "entity.type.name"], settings: { foreground: "#0e7490" } },
  { scope: ["entity.name.tag", "meta.tag"], settings: { foreground: "#0969da" } },
  { scope: ["entity.other.attribute-name"], settings: { foreground: "#b45309" } },
  { scope: ["variable", "variable.parameter", "meta.object.member"], settings: { foreground: "#333b45" } },
  { scope: ["constant.other.property", "support.variable.property", "meta.property-name"], settings: { foreground: "#3f6488" } },
  { scope: ["operator", "punctuation.accessor"], settings: { foreground: "#525c68" } },
  { scope: ["punctuation", "meta.brace", "punctuation.separator", "punctuation.terminator"], settings: { foreground: "#5f6a76" } },
  { scope: ["invalid"], settings: { foreground: "#cf222e", fontStyle: "underline" } },
  { scope: ["markup.heading", "entity.name.section"], settings: { foreground: "#0969da", fontStyle: "bold" } },
  { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
  { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
  { scope: ["markup.list"], settings: { foreground: "#6d28d9" } },
  { scope: ["markup.quote"], settings: { foreground: "#1a7f37", fontStyle: "italic" } },
  { scope: ["markup.link", "string.other.link", "punctuation.definition.metadata"], settings: { foreground: "#0969da" } },
  { scope: ["markup.raw", "markup.inline.raw"], settings: { foreground: "#1a7f37" } },
  { scope: ["markup.inserted", "punctuation.definition.inserted"], settings: { foreground: "#1a7f37" } },
  { scope: ["markup.deleted", "punctuation.definition.deleted"], settings: { foreground: "#cf222e" } },
  { scope: ["markup.changed"], settings: { foreground: "#b45309" } },
  { scope: ["diff.header", "meta.diff", "meta.diff.header"], settings: { foreground: "#6e7785", fontStyle: "italic" } },
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

/**
 * Obsidian Luminous series palette — eye-friendly on pure black, ordered so
 * adjacent chart series stay distinguishable. Shared by ChartBlock, the
 * Scene3D default mesh colors and any future generative surface.
 */
export const OBSIDIAN_SERIES_COLORS = [
  "#38BDF8", "#A78BFA", "#34D399", "#FBBF24",
  "#FB7185", "#818CF8", "#2DD4BF", "#FB923C",
] as const;

/** Mermaid `theme: "base"` variables tuned to the Obsidian black palette. */
export const OBSIDIAN_MERMAID_THEME: Record<string, string> = {
  background: "transparent",
  primaryColor: "#0d0d12",
  primaryBorderColor: "#3d4c5e",
  primaryTextColor: "#F4F4F6",
  lineColor: "#64748B",
  secondaryColor: "#161a22",
  tertiaryColor: "#0d0d12",
  mainBkg: "#0d0d12",
  nodeBorder: "#3d4c5e",
  clusterBkg: "rgba(255,255,255,0.02)",
  edgeLabelBackground: "#0d0d12",
  titleColor: "#F4F4F6",
  actorBkg: "#0d0d12",
  actorBorder: "#3d4c5e",
  actorTextColor: "#F4F4F6",
  signalColor: "#64748B",
  signalTextColor: "#F4F4F6",
  labelBoxBkgColor: "#0d0d12",
  labelBoxBorderColor: "#3d4c5e",
  labelTextColor: "#F4F4F6",
  loopTextColor: "#F4F4F6",
  noteBkgColor: "#161a22",
  noteTextColor: "#F4F4F6",
  noteBorderColor: "#3d4c5e",
  activationBkgColor: "#161a22",
  activationBorderColor: "#3d4c5e",
  sequenceNumberColor: "#F4F4F6",
  classText: "#F4F4F6",
  attributeBackgroundColorOdd: "#0d0d12",
  attributeBackgroundColorEven: "#161a22",
};
