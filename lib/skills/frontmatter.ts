/** Minimal YAML frontmatter reader for SKILL.md files (name + description). */

export interface SkillFrontmatter {
  name: string;
  description: string;
}

export function parseFrontmatter(markdown: string): SkillFrontmatter | null {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!block) return null;

  const fields = new Map<string, string>();
  let currentKey: string | null = null;
  for (const line of block[1].split(/\r?\n/)) {
    const keyValue = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (keyValue) {
      currentKey = keyValue[1].toLowerCase();
      fields.set(currentKey, keyValue[2].trim());
      continue;
    }
    // Indented continuation line (folded multi-line description).
    if (currentKey && /^\s+\S/.test(line)) {
      fields.set(currentKey, (fields.get(currentKey) ?? "") + " " + line.trim());
    }
  }
  return { name: fields.get("name") ?? "", description: fields.get("description") ?? "" };
}
