import type { LanguageRegistration } from "shiki";

/**
 * Central language registry: canonical Shiki ids, display labels, and
 * alias resolution. Every fenced block resolves through here, so the
 * header label is always honest — unknown languages stay "plain text"
 * and never get mislabelled as something else.
 *
 * Loaders are per-language dynamic imports so webpack emits one lazy
 * chunk per grammar; a grammar is only fetched when a block uses it.
 */

/** Grammar modules default-export an array (a grammar may ship injections). */
export type LangLoader = () => Promise<{ default: LanguageRegistration | LanguageRegistration[] }>;

const LANG_LOADERS: Record<string, LangLoader> = {
  // ── Programming languages ───────────────────────────────────────────
  ada: () => import("@shikijs/langs/ada"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  objectivec: () => import("@shikijs/langs/objective-c"),
  objectivecpp: () => import("@shikijs/langs/objective-cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  fsharp: () => import("@shikijs/langs/fsharp"),
  vb: () => import("@shikijs/langs/vb"),
  crystal: () => import("@shikijs/langs/crystal"),
  d: () => import("@shikijs/langs/d"),
  dart: () => import("@shikijs/langs/dart"),
  elixir: () => import("@shikijs/langs/elixir"),
  elm: () => import("@shikijs/langs/elm"),
  erlang: () => import("@shikijs/langs/erlang"),
  fennel: () => import("@shikijs/langs/fennel"),
  fortran: () => import("@shikijs/langs/fortran-free-form"),
  gleam: () => import("@shikijs/langs/gleam"),
  go: () => import("@shikijs/langs/go"),
  haskell: () => import("@shikijs/langs/haskell"),
  haxe: () => import("@shikijs/langs/haxe"),
  java: () => import("@shikijs/langs/java"),
  javascript: () => import("@shikijs/langs/javascript"),
  julia: () => import("@shikijs/langs/julia"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  lean4: () => import("@shikijs/langs/lean4"),
  coq: () => import("@shikijs/langs/coq"),
  lua: () => import("@shikijs/langs/lua"),
  matlab: () => import("@shikijs/langs/matlab"),
  nim: () => import("@shikijs/langs/nim"),
  odin: () => import("@shikijs/langs/odin"),
  ocaml: () => import("@shikijs/langs/ocaml"),
  pascal: () => import("@shikijs/langs/pascal"),
  perl: () => import("@shikijs/langs/perl"),
  php: () => import("@shikijs/langs/php"),
  prolog: () => import("@shikijs/langs/prolog"),
  purescript: () => import("@shikijs/langs/purescript"),
  python: () => import("@shikijs/langs/python"),
  r: () => import("@shikijs/langs/r"),
  raku: () => import("@shikijs/langs/raku"),
  ruby: () => import("@shikijs/langs/ruby"),
  rust: () => import("@shikijs/langs/rust"),
  scala: () => import("@shikijs/langs/scala"),
  scheme: () => import("@shikijs/langs/scheme"),
  smalltalk: () => import("@shikijs/langs/smalltalk"),
  solidity: () => import("@shikijs/langs/solidity"),
  swift: () => import("@shikijs/langs/swift"),
  tcl: () => import("@shikijs/langs/tcl"),
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  jsx: () => import("@shikijs/langs/jsx"),
  v: () => import("@shikijs/langs/v"),
  vala: () => import("@shikijs/langs/vala"),
  zig: () => import("@shikijs/langs/zig"),
  clojure: () => import("@shikijs/langs/clojure"),
  commonlisp: () => import("@shikijs/langs/common-lisp"),
  cobol: () => import("@shikijs/langs/cobol"),

  // ── Web / templating ────────────────────────────────────────────────
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  sass: () => import("@shikijs/langs/sass"),
  less: () => import("@shikijs/langs/less"),
  postcss: () => import("@shikijs/langs/postcss"),
  vue: () => import("@shikijs/langs/vue"),
  vuehtml: () => import("@shikijs/langs/vue-html"),
  svelte: () => import("@shikijs/langs/svelte"),
  astro: () => import("@shikijs/langs/astro"),
  marko: () => import("@shikijs/langs/marko"),
  angularhtml: () => import("@shikijs/langs/angular-html"),
  angularts: () => import("@shikijs/langs/angular-ts"),
  handlebars: () => import("@shikijs/langs/handlebars"),
  twig: () => import("@shikijs/langs/twig"),
  haml: () => import("@shikijs/langs/haml"),
  pug: () => import("@shikijs/langs/pug"),
  liquid: () => import("@shikijs/langs/liquid"),
  jinja: () => import("@shikijs/langs/jinja-html"),
  erb: () => import("@shikijs/langs/erb"),

  // ── Docs / markup / math ────────────────────────────────────────────
  markdown: () => import("@shikijs/langs/markdown"),
  mdx: () => import("@shikijs/langs/mdx"),
  rst: () => import("@shikijs/langs/rst"),
  asciidoc: () => import("@shikijs/langs/asciidoc"),
  latex: () => import("@shikijs/langs/latex"),
  typst: () => import("@shikijs/langs/typst"),

  // ── Shell / scripting / build ───────────────────────────────────────
  shellscript: () => import("@shikijs/langs/shellscript"),
  shellsession: () => import("@shikijs/langs/shellsession"),
  powershell: () => import("@shikijs/langs/powershell"),
  bat: () => import("@shikijs/langs/bat"),
  fish: () => import("@shikijs/langs/fish"),
  awk: () => import("@shikijs/langs/awk"),
  nix: () => import("@shikijs/langs/nix"),
  just: () => import("@shikijs/langs/just"),
  make: () => import("@shikijs/langs/make"),
  cmake: () => import("@shikijs/langs/cmake"),
  gnuplot: () => import("@shikijs/langs/gnuplot"),

  // ── Data / config ───────────────────────────────────────────────────
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  json5: () => import("@shikijs/langs/json5"),
  jsonl: () => import("@shikijs/langs/jsonl"),
  jsonnet: () => import("@shikijs/langs/jsonnet"),
  hjson: () => import("@shikijs/langs/hjson"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  ini: () => import("@shikijs/langs/ini"),
  properties: () => import("@shikijs/langs/properties"),
  xml: () => import("@shikijs/langs/xml"),
  xsl: () => import("@shikijs/langs/xsl"),
  csv: () => import("@shikijs/langs/csv"),
  tsv: () => import("@shikijs/langs/tsv"),
  graphql: () => import("@shikijs/langs/graphql"),
  cue: () => import("@shikijs/langs/cue"),
  protobuf: () => import("@shikijs/langs/proto"),
  docker: () => import("@shikijs/langs/docker"),
  dotenv: () => import("@shikijs/langs/dotenv"),
  gitcommit: () => import("@shikijs/langs/git-commit"),
  gitrebase: () => import("@shikijs/langs/git-rebase"),
  sshconfig: () => import("@shikijs/langs/ssh-config"),

  // ── Databases ───────────────────────────────────────────────────────
  postgresql: () => import("@shikijs/langs/sql"),
  plsql: () => import("@shikijs/langs/plsql"),
  prisma: () => import("@shikijs/langs/prisma"),
  cypher: () => import("@shikijs/langs/cypher"),
  sparql: () => import("@shikijs/langs/sparql"),
  codeql: () => import("@shikijs/langs/codeql"),

  // ── Infra / hardware ────────────────────────────────────────────────
  hcl: () => import("@shikijs/langs/hcl"),
  terraform: () => import("@shikijs/langs/terraform"),
  verilog: () => import("@shikijs/langs/verilog"),
  systemverilog: () => import("@shikijs/langs/system-verilog"),
  vhdl: () => import("@shikijs/langs/vhdl"),
  riscv: () => import("@shikijs/langs/riscv"),
  asm: () => import("@shikijs/langs/asm"),
  wasm: () => import("@shikijs/langs/wasm"),

  // ── Graphics / shaders ──────────────────────────────────────────────
  glsl: () => import("@shikijs/langs/glsl"),
  wgsl: () => import("@shikijs/langs/wgsl"),
  hlsl: () => import("@shikijs/langs/hlsl"),
  shaderlab: () => import("@shikijs/langs/shaderlab"),
  gdscript: () => import("@shikijs/langs/gdscript"),
  gdshader: () => import("@shikijs/langs/gdshader"),

  // ── Meta / protocol / diagram sources ───────────────────────────────
  diff: () => import("@shikijs/langs/diff"),
  http: () => import("@shikijs/langs/http"),
  mermaid: () => import("@shikijs/langs/mermaid"),
  jison: () => import("@shikijs/langs/jison"),
  powerquery: () => import("@shikijs/langs/powerquery"),
};

/**
 * Grammars that other grammars embed via `embeddedLangs` (cpp embeds
 * regexp/glsl/cpp-macro, vue embeds vue-directives, typst embeds tex…) but
 * that users almost never fence directly. Shiki resolves embedded references
 * by canonical grammar name, so these load under their real names and are
 * never re-keyed. Names here are the exact union of every `embeddedLangs`
 * entry across @shikijs/langs that is not already a registry key.
 */
const GRAMMAR_DEP_LOADERS: Record<string, LangLoader> = {
  "angular-expression": () => import("@shikijs/langs/angular-expression"),
  "angular-html": () => import("@shikijs/langs/angular-html"),
  "angular-inline-style": () => import("@shikijs/langs/angular-inline-style"),
  "angular-inline-template": () => import("@shikijs/langs/angular-inline-template"),
  "angular-let-declaration": () => import("@shikijs/langs/angular-let-declaration"),
  "angular-template": () => import("@shikijs/langs/angular-template"),
  "angular-template-blocks": () => import("@shikijs/langs/angular-template-blocks"),
  bibtex: () => import("@shikijs/langs/bibtex"),
  coffee: () => import("@shikijs/langs/coffee"),
  "cpp-macro": () => import("@shikijs/langs/cpp-macro"),
  "es-tag-css": () => import("@shikijs/langs/es-tag-css"),
  "es-tag-glsl": () => import("@shikijs/langs/es-tag-glsl"),
  "es-tag-html": () => import("@shikijs/langs/es-tag-html"),
  "es-tag-sql": () => import("@shikijs/langs/es-tag-sql"),
  "es-tag-xml": () => import("@shikijs/langs/es-tag-xml"),
  "fortran-free-form": () => import("@shikijs/langs/fortran-free-form"),
  "git-commit": () => import("@shikijs/langs/git-commit"),
  "git-rebase": () => import("@shikijs/langs/git-rebase"),
  groovy: () => import("@shikijs/langs/groovy"),
  "html-derivative": () => import("@shikijs/langs/html-derivative"),
  "jinja-html": () => import("@shikijs/langs/jinja-html"),
  log: () => import("@shikijs/langs/log"),
  "markdown-nix": () => import("@shikijs/langs/markdown-nix"),
  "markdown-vue": () => import("@shikijs/langs/markdown-vue"),
  "nextflow-groovy": () => import("@shikijs/langs/nextflow-groovy"),
  "objective-c": () => import("@shikijs/langs/objective-c"),
  regexp: () => import("@shikijs/langs/regexp"),
  sdbl: () => import("@shikijs/langs/sdbl"),
  sql: () => import("@shikijs/langs/sql"),
  stylus: () => import("@shikijs/langs/stylus"),
  "system-verilog": () => import("@shikijs/langs/system-verilog"),
  tex: () => import("@shikijs/langs/tex"),
  turtle: () => import("@shikijs/langs/turtle"),
  "vue-directives": () => import("@shikijs/langs/vue-directives"),
  "vue-interpolations": () => import("@shikijs/langs/vue-interpolations"),
  "vue-sfc-style-variable-injection": () => import("@shikijs/langs/vue-sfc-style-variable-injection"),
};

/** Loader for an embedded dependency grammar, by canonical Shiki name. */
export function grammarDependencyLoader(name: string): LangLoader | null {
  return GRAMMAR_DEP_LOADERS[name] ?? LANG_LOADERS[name] ?? null;
}

/** Fenced-block info strings that mean "no highlighting". */
const PLAIN_IDS = new Set([
  "text", "plaintext", "plain", "txt", "raw", "", "none", "null", "undefined",
]);

/**
 * Common aliases → canonical registry key. Keys are lower-cased before
 * lookup. This is our own map (not Shiki's) so labels stay correct and
 * we can approximate grammars for languages without one (mysql → the
 * postgres grammar) while still showing the true label.
 */
const ALIASES: Record<string, string> = {
  // scripting / systems
  js: "javascript", mjs: "javascript", cjs: "javascript", node: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript",
  py: "python", py3: "python", python3: "python",
  rs: "rust", rb: "ruby", kt: "kotlin", kts: "kotlin",
  cs: "csharp", fs: "fsharp", fsx: "fsharp", vbnet: "vb",
  objc: "objectivec", "objective-c": "objectivec", objcpp: "objectivecpp", "objective-c++": "objectivecpp",
  "c++": "cpp", cxx: "cpp", cc: "cpp", hpp: "cpp", h: "cpp",
  hxx: "cpp", "c#": "csharp", "f#": "fsharp",
  golang: "go",
  ex: "elixir", exs: "elixir", erl: "erlang", hs: "haskell", ml: "ocaml",
  sc: "scala", clj: "clojure", lisp: "commonlisp", cl: "commonlisp",
  pl: "perl", pm: "perl",
  lua: "lua", nim: "nim", zig: "zig", odin: "odin", vlang: "v",
  sol: "solidity", lean: "lean4", coq: "coq",
  ps1: "powershell", pwsh: "powershell", psm1: "powershell",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", ksh: "shellscript",
  shell: "shellscript", console: "shellsession", shellsession: "shellsession",
  batch: "bat", dos: "bat", cmd: "bat",
  fish: "fish", awk: "awk", nix: "nix",
  makefile: "make", mk: "make", dockerfile: "docker",
  justfile: "just", gnuplot: "gnuplot",

  // web
  htm: "html", xhtml: "html", vue: "vue", svelte: "svelte", astro: "astro",
  hbs: "handlebars", hbsx: "handlebars", handlebars: "handlebars",
  md: "markdown", mdx: "mdx", rst: "rst", adoc: "asciidoc", asciidoc: "asciidoc",
  tex: "latex", latex: "latex", typ: "typst",
  scss: "scss", sass: "sass", less: "less", css: "css", postcss: "postcss",

  // data / config
  json: "json", jsonc: "jsonc", json5: "json5", jsonl: "jsonl", ndjson: "jsonl",
  jsonnet: "jsonnet", hjson: "hjson",
  yml: "yaml", yaml: "yaml",
  toml: "toml", ini: "ini", conf: "ini", cfg: "ini", dosini: "ini",
  properties: "properties", env: "dotenv",
  xml: "xml", xsl: "xsl", xslt: "xsl",
  csv: "csv", tsv: "tsv",
  gql: "graphql", graphql: "graphql",
  cue: "cue", proto: "protobuf", protobuf: "protobuf",
  gitcommit: "gitcommit", "git-commit": "gitcommit",
  gitrebase: "gitrebase", "git-rebase": "gitrebase",
  sshconfig: "sshconfig", ssh_config: "sshconfig",

  // databases
  sql: "postgresql", pgsql: "postgresql", postgres: "postgresql",
  mysql: "postgresql", mariadb: "postgresql", sqlite: "postgresql",
  plsql: "plsql", oracle: "plsql",
  prisma: "prisma", neo4j: "cypher", cypher: "cypher",
  sparql: "sparql", ql: "codeql",

  // infra
  tf: "terraform", terraform: "terraform", hcl: "hcl", nomad: "hcl",
  verilog: "verilog", sv: "systemverilog", systemverilog: "systemverilog",
  vhdl: "vhdl", riscv: "riscv", asm: "asm", x86: "asm", arm: "asm",
  wasm: "wasm", wat: "wasm",

  // graphics
  glsl: "glsl", frag: "glsl", vert: "glsl", shader: "glsl",
  wgsl: "wgsl", hlsl: "hlsl", cg: "hlsl",
  gdscript: "gdscript", gd: "gdscript", gdshader: "gdshader",

  // meta
  patch: "diff", udiff: "diff", http: "http", rest: "http",
  mermaid: "mermaid", mmd: "mermaid", jison: "jison",
  pq: "powerquery", m: "powerquery",
};

/** Display labels for canonical keys (header text). */
const LABELS: Record<string, string> = {
  ada: "Ada", c: "C", cpp: "C++", objectivec: "Objective-C", objectivecpp: "Objective-C++",
  csharp: "C#", fsharp: "F#", vb: "Visual Basic", crystal: "Crystal", d: "D",
  dart: "Dart", elixir: "Elixir", elm: "Elm", erlang: "Erlang", fennel: "Fennel",
  fortran: "Fortran", gleam: "Gleam", go: "Go", haskell: "Haskell", haxe: "Haxe",
  java: "Java", javascript: "JavaScript", julia: "Julia", kotlin: "Kotlin",
  lean4: "Lean 4", coq: "Coq", lua: "Lua", matlab: "MATLAB", nim: "Nim",
  odin: "Odin", ocaml: "OCaml", pascal: "Pascal", perl: "Perl", php: "PHP",
  prolog: "Prolog", purescript: "PureScript", python: "Python", r: "R",
  raku: "Raku", ruby: "Ruby", rust: "Rust", scala: "Scala",
  scheme: "Scheme", smalltalk: "Smalltalk", solidity: "Solidity", swift: "Swift",
  tcl: "Tcl", typescript: "TypeScript", tsx: "TSX", jsx: "JSX", v: "V",
  vala: "Vala", zig: "Zig", clojure: "Clojure", commonlisp: "Common Lisp",
  cobol: "COBOL",
  html: "HTML", css: "CSS", scss: "SCSS", sass: "Sass", less: "Less",
  postcss: "PostCSS", vue: "Vue", vuehtml: "Vue HTML", svelte: "Svelte",
  astro: "Astro", marko: "Marko", angularhtml: "Angular", angularts: "Angular TS",
  handlebars: "Handlebars", twig: "Twig", haml: "HAML",
  pug: "Pug", liquid: "Liquid", jinja: "Jinja", erb: "ERB",
  markdown: "Markdown", mdx: "MDX", rst: "reST", asciidoc: "AsciiDoc",
  latex: "LaTeX", typst: "Typst",
  shellscript: "Shell", shellsession: "Terminal", powershell: "PowerShell",
  bat: "Batch", fish: "Fish", awk: "Awk", nix: "Nix", just: "Just",
  make: "Makefile", cmake: "CMake", gnuplot: "Gnuplot",
  json: "JSON", jsonc: "JSONC", json5: "JSON5", jsonl: "JSON Lines",
  jsonnet: "Jsonnet", hjson: "HJSON", yaml: "YAML", toml: "TOML", ini: "INI",
  properties: "Properties", xml: "XML", xsl: "XSLT", csv: "CSV",
  tsv: "TSV", graphql: "GraphQL", cue: "CUE", protobuf: "Protobuf",
  docker: "Docker", dotenv: ".env",
  gitcommit: "Git Commit", gitrebase: "Git Rebase", sshconfig: "SSH Config",
  postgresql: "SQL", plsql: "PL/SQL", prisma: "Prisma",
  cypher: "Cypher", sparql: "SPARQL", codeql: "CodeQL",
  hcl: "HCL", terraform: "Terraform", verilog: "Verilog",
  systemverilog: "SystemVerilog", vhdl: "VHDL", riscv: "RISC-V", asm: "Assembly",
  wasm: "WebAssembly", glsl: "GLSL", wgsl: "WGSL", hlsl: "HLSL",
  shaderlab: "ShaderLab", gdscript: "GDScript", gdshader: "GDShader",
  diff: "Diff", http: "HTTP", mermaid: "Mermaid", jison: "Jison",
  powerquery: "Power Query",
};

/** Per-language label overrides when we borrow a neighbouring grammar. */
const LABEL_OVERRIDES: Record<string, string> = {
  mysql: "MySQL", mariadb: "MariaDB", sqlite: "SQLite",
};

export interface ResolvedLanguage {
  /** Canonical registry key, or null when there is no grammar for it. */
  key: string | null;
  /** Text shown in the code-block header. */
  label: string;
  /** Lazy grammar loader, or null to render as plain text. */
  loader: LangLoader | null;
}

const PLAIN: ResolvedLanguage = { key: null, label: "Plain text", loader: null };

/**
 * Resolve a raw fence info string (e.g. "py", "C++", "ts") to a canonical
 * language. Unknown ids never guess: they fall back to plain text.
 */
export function resolveLanguage(raw: string | undefined | null): ResolvedLanguage {
  const info = (raw ?? "").trim().toLowerCase().split(/[:?\s]/)[0];
  if (PLAIN_IDS.has(info)) return PLAIN;

  const key = ALIASES[info] ?? (LANG_LOADERS[info] ? info : null);
  if (!key) return PLAIN;

  const loader = LANG_LOADERS[key] ?? null;
  const label = LABEL_OVERRIDES[info] ?? LABELS[key] ?? key;
  return { key, label, loader };
}

/** True when the fence info string names a language we can highlight. */
export function isHighlightable(raw: string | undefined | null): boolean {
  return resolveLanguage(raw).loader !== null;
}

/** Every canonical registry key — used by the all-languages validation test. */
export function languageKeys(): string[] {
  return Object.keys(LANG_LOADERS);
}
