/**
 * Extension-based file classification — shared by the client (attachment
 * processing) and the server (extraction routes). MIME types are unreliable
 * (browsers report empty or wrong types for most code/config formats), so the
 * extension is the source of truth; MIME is only a fallback.
 */

export type FileCategory =
  | "text"      // read directly as UTF-8
  | "image"     // sent to the model as an image
  | "audio"     // transcribed server-side
  | "video"     // frames extracted server-side
  | "archive"   // text members extracted server-side
  | "office"    // docx/xlsx/pptx/odt/ods/odp/epub — ZIP+XML
  | "pdf"
  | "rtf"
  | "notebook"  // ipynb
  | "legacy"    // doc/xls/ppt/mat — recover printable strings from binary
  | "unknown";

const EXT_CATEGORY: Record<string, FileCategory> = {
  // text / code / markup / config
  txt: "text", csv: "text", tsv: "text", md: "text",
  json: "text", jsonl: "text", xml: "text", html: "text", htm: "text",
  yaml: "text", yml: "text", toml: "text", ini: "text", log: "text",
  py: "text", js: "text", jsx: "text", ts: "text", tsx: "text",
  java: "text", c: "text", cpp: "text", cc: "text", h: "text", hpp: "text",
  cs: "text", go: "text", rs: "text", php: "text", rb: "text",
  swift: "text", kt: "text", kts: "text", scala: "text",
  sh: "text", bash: "text", zsh: "text", ps1: "text", bat: "text", cmd: "text",
  sql: "text", r: "text", m: "text", tex: "text", bib: "text",
  diff: "text", patch: "text", env: "text", conf: "text", cfg: "text",
  properties: "text", graphql: "text", gql: "text", proto: "text",
  dockerfile: "text", makefile: "text", tf: "text", hcl: "text",
  vue: "text", svelte: "text", astro: "text", svg: "text",

  // images
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  bmp: "image", tif: "image", tiff: "image", heic: "image", heif: "image",
  avif: "image", ico: "image",

  // audio
  mp3: "audio", wav: "audio", m4a: "audio", aac: "audio", ogg: "audio", flac: "audio",

  // video
  mp4: "video", mpeg: "video", mpg: "video", mov: "video", avi: "video",
  mkv: "video", webm: "video", "3gp": "video",

  // archives
  zip: "archive", tar: "archive", gz: "archive", tgz: "archive",
  bz2: "archive", xz: "archive", "7z": "archive", rar: "archive",

  // office / document containers
  docx: "office", xlsx: "office", xlsm: "office", pptx: "office",
  odt: "office", ods: "office", odp: "office", epub: "office",

  pdf: "pdf",
  rtf: "rtf",
  ipynb: "notebook",

  // legacy binary formats — strings recovery
  doc: "legacy", xls: "legacy", ppt: "legacy", mat: "legacy",
};

/** Files known by bare name (no usable extension). */
const NAME_CATEGORY: Record<string, FileCategory> = {
  dockerfile: "text",
  makefile: "text",
  ".env": "text",
};

export function fileExtension(name: string): string {
  const i = name.lastIndexOf(".");
  if (i < 0) return "";
  // ".env" style dotfiles have no meaningful extension — handled by name.
  if (i === 0) return "";
  return name.slice(i + 1).toLowerCase();
}

export function classifyFile(name: string, mime?: string): FileCategory {
  const ext = fileExtension(name);
  if (ext && EXT_CATEGORY[ext]) return EXT_CATEGORY[ext];

  const base = name.toLowerCase();
  if (NAME_CATEGORY[base]) return NAME_CATEGORY[base];

  // MIME fallback for extension-less uploads.
  if (mime) {
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("audio/")) return "audio";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("text/")) return "text";
    if (mime === "application/pdf") return "pdf";
    if (mime === "application/json") return "text";
    if (mime === "application/xml" || mime.endsWith("+xml")) return "text";
    if (mime === "application/zip" || mime === "application/x-tar" ||
        mime === "application/gzip" || mime === "application/x-7z-compressed" ||
        mime === "application/vnd.rar") return "archive";
    if (mime.includes("officedocument") || mime.includes("opendocument") ||
        mime === "application/epub+zip") return "office";
  }
  return "unknown";
}

/**
 * How much extracted text one attachment may contribute to a prompt. Keeps a
 * stack of large files from blowing past the model's context window.
 */
export const TEXT_CHAR_LIMIT = 48000;

/** Largest file the UI will accept as an attachment. */
export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

/** True when the category's content can be shown to the model as text. */
export function isTextual(cat: FileCategory): boolean {
  return cat === "text" || cat === "notebook" || cat === "rtf";
}

/** The full accept-string for the file input, mirroring EXT_CATEGORY. */
export const ACCEPT_EXTENSIONS: string =
  Object.keys(EXT_CATEGORY).map(e => "." + e).join(",") + ",Dockerfile,Makefile";
