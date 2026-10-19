/**
 * Folder-structure fences: models emit box-drawing directory trees in plain
 * or `text` fences (the label is usually empty), so detection is content-
 * based. Parsing turns the source into nested nodes that TreeBlock renders
 * with icons and guide lines.
 */

export interface TreeNode {
  name: string;
  /** Trailing `# note` comment, shown muted. */
  note: string;
  isDir: boolean;
  children: TreeNode[];
}

const BRANCH = /^(.*?)(?:[├└]──|\|--|\\--)\s?(.*)$/;
/**
 * Lines carrying only guide/spacer characters: `│`, `│   │`, or a branch
 * caught mid-typing (`├`, `├─`). Large trees have many of them, so they are
 * neutral for detection and skipped while parsing — counting them as "plain"
 * was what made big trees fall back to a plain code block and flicker
 * between renderers while streaming.
 */
const GUIDE_ONLY = /^[\s│├└┬┴┤─|\\-]+$/;
/** `...` / `…` continuation lines belong to a tree, not to prose. */
const ELLIPSIS = /^(?:\.{3}|…)$/;

/** True when the fenced source reads as a directory tree rather than code. */
export function looksLikeTree(source: string): boolean {
  const lines = source.split("\n").filter(line => line.trim() !== "");
  if (lines.length < 3) return false;
  let branch = 0;
  let plain = 0;
  for (const line of lines) {
    if (BRANCH.test(line)) branch++;
    else if (!GUIDE_ONLY.test(line) && !ELLIPSIS.test(line.trim())) plain++;
  }
  // Allow up to two plain lines (a root, or a root plus a stray note);
  // guide-only spacers never count against the tree, so arbitrarily large
  // trees keep detecting as trees.
  return branch >= 2 && plain <= 2;
}

/**
 * Streaming fast-path: true the moment the first complete branch line has
 * arrived, so the fence becomes the interactive tree immediately instead of
 * starting as a code block and flipping once enough lines pile up. Monotonic
 * by construction — once true it stays true as more lines stream in, so the
 * renderer never toggles mid-generation.
 */
export function looksLikeTreeStart(source: string): boolean {
  const lines = source.split("\n").filter(line => line.trim() !== "");
  if (lines.length < 2 || !lines.some(line => BRANCH.test(line))) return false;
  const first = lines[0].trim();
  // The fence must open like a tree: a branch line, or a space-free root
  // (`my-app/`, `my_flask_app`). Prose fences open with sentences.
  return BRANCH.test(first) || !/\s/.test(first);
}

export function parseTree(source: string): TreeNode[] {
  const roots: TreeNode[] = [];
  const openDirs: Array<{ depth: number; node: TreeNode }> = [];

  for (const rawLine of source.split("\n")) {
    if (rawLine.trim() === "") continue;
    if (GUIDE_ONLY.test(rawLine)) continue; // spacer or half-typed branch
    const branch = BRANCH.exec(rawLine);
    // Each nesting level is one 4-char guide group ("│   " / "    ").
    const depth = branch ? Math.floor(branch[1].length / 4) + 1 : 0;
    const node = toNode(branch ? branch[2] : rawLine);
    // `├── ` with the name not typed yet (mid-stream) — skip, it re-parses
    // once the name arrives.
    if (branch && node.name === "" && node.note === "") continue;

    while (openDirs.length > 0 && openDirs[openDirs.length - 1].depth >= depth) openDirs.pop();
    if (openDirs.length === 0) roots.push(node);
    else openDirs[openDirs.length - 1].node.children.push(node);
    if (node.isDir) openDirs.push({ depth, node });
  }
  return roots;
}

function toNode(text: string): TreeNode {
  const hashIndex = text.indexOf("#");
  const rawName = (hashIndex >= 0 ? text.slice(0, hashIndex) : text).trim();
  const note = hashIndex >= 0 ? text.slice(hashIndex + 1).trim() : "";
  const name = rawName.replace(/\/+$/, "");
  // A trailing slash marks a folder; extension-less names (src, app,
  // tests, Makefile) are treated as folders too — the IDE convention.
  const isDir = rawName.endsWith("/") || !/\.\w+$/.test(name);
  return { name, note, isDir, children: [] };
}
