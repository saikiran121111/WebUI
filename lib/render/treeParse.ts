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

/** True when the fenced source reads as a directory tree rather than code. */
export function looksLikeTree(source: string): boolean {
  const lines = source.split("\n").filter(line => line.trim() !== "");
  if (lines.length < 3) return false;
  const branchLines = lines.filter(line => BRANCH.test(line)).length;
  // Allow up to two plain lines (a root, or a root plus a stray note).
  return branchLines >= 2 && branchLines >= lines.length - 2;
}

export function parseTree(source: string): TreeNode[] {
  const roots: TreeNode[] = [];
  const openDirs: Array<{ depth: number; node: TreeNode }> = [];

  for (const rawLine of source.split("\n")) {
    if (rawLine.trim() === "") continue;
    const branch = BRANCH.exec(rawLine);
    // Each nesting level is one 4-char guide group ("│   " / "    ").
    const depth = branch ? Math.floor(branch[1].length / 4) + 1 : 0;
    const node = toNode(branch ? branch[2] : rawLine);

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
