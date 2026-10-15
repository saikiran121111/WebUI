"use client";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle, Check, ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy,
  File, FileCode2, FileCog, FileJson, FileText, Folder, FolderOpen,
  type LucideIcon,
} from "lucide-react";
import { parseTree, type TreeNode } from "../../lib/render/treeParse";
import { copyText } from "../../lib/render/clipboard";

/**
 * Folder-structure fences render as an IDE-style tree: folder/file icons,
 * CSS guide lines, and click-to-collapse folders animated with a grid-rows
 * transition (the global prefers-reduced-motion rule disables motion).
 * Copy always uses the original fenced source, so pasted trees are exact.
 */

const CODE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "html", "css", "scss", "sass",
  "go", "rs", "java", "kt", "c", "h", "cpp", "hpp", "cs", "rb", "php", "swift",
  "lua", "sh", "ps1", "vue", "svelte", "astro", "dart", "zig", "ex", "exs",
  "erl", "hs", "ml", "r", "jl", "sql", "graphql", "proto", "glsl", "wgsl",
]);
const DOC_EXTS = new Set(["md", "mdx", "txt", "rst", "adoc", "tex", "typ"]);
const CONFIG_EXTS = new Set(["jsonc", "json5", "yaml", "yml", "toml", "ini", "env", "config", "lock", "xml", "xsl", "properties"]);

function fileIconFor(name: string): LucideIcon {
  const ext = /\.([\w+]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
  if (ext === "json") return FileJson;
  if (CODE_EXTS.has(ext)) return FileCode2;
  if (CONFIG_EXTS.has(ext)) return FileCog;
  if (DOC_EXTS.has(ext)) return FileText;
  return File;
}

function collectFolderPaths(nodes: TreeNode[], prefix = ""): string[] {
  const paths: string[] = [];
  nodes.forEach((node, index) => {
    const path = prefix === "" ? String(index) : `${prefix}/${index}`;
    if (node.isDir && node.children.length > 0) {
      paths.push(path);
      paths.push(...collectFolderPaths(node.children, path));
    }
  });
  return paths;
}

export default memo(function TreeBlock({ source }: { source: string }) {
  const roots = useMemo(() => parseTree(source), [source]);
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (statusTimer.current) clearTimeout(statusTimer.current);
  }, []);

  const toggleFolder = useCallback((path: string) => {
    setCollapsedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const folderPaths = useMemo(() => collectFolderPaths(roots), [roots]);
  const allCollapsed = folderPaths.length > 0 && folderPaths.every(path => collapsedPaths.has(path));
  const toggleAll = useCallback(() => {
    setCollapsedPaths(allCollapsed ? new Set() : new Set(folderPaths));
  }, [allCollapsed, folderPaths]);

  const handleCopy = useCallback(async () => {
    const ok = await copyText(source);
    setCopyStatus(ok ? "copied" : "failed");
    if (statusTimer.current) clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setCopyStatus("idle"), 2000);
  }, [source]);

  return (
    <div className="tree-block" data-testid="tree-block">
      <div className="code-block-header">
        <span className="code-block-lang">Structure</span>
        <div className="code-block-controls">
          <button
            onClick={toggleAll}
            className="code-block-ctl"
            aria-label={allCollapsed ? "Expand all folders" : "Collapse all folders"}
            title={allCollapsed ? "Expand all" : "Collapse all"}
          >
            {allCollapsed ? <ChevronsUpDown className="w-3.5 h-3.5" /> : <ChevronsDownUp className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={handleCopy}
            className="code-block-copy"
            aria-label="Copy structure"
            data-testid="tree-copy-btn"
          >
            {copyStatus === "copied" ? <Check className="w-3.5 h-3.5 text-emerald-400" />
              : copyStatus === "failed" ? <AlertCircle className="w-3.5 h-3.5 text-red-400" />
                : <Copy className="w-3.5 h-3.5" />}
            <span aria-live="polite" className="text-xs">
              {copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? "Failed" : "Copy"}
            </span>
          </button>
        </div>
      </div>
      <div className="tree-body">
        <ul className="tree-list" role="tree" aria-label="Project structure">
          {roots.map((node, index) => (
            <TreeRow
              key={index}
              node={node}
              path={String(index)}
              collapsedPaths={collapsedPaths}
              onToggle={toggleFolder}
            />
          ))}
        </ul>
      </div>
    </div>
  );
});

function TreeRow({ node, path, collapsedPaths, onToggle }: {
  node: TreeNode;
  path: string;
  collapsedPaths: ReadonlySet<string>;
  onToggle: (path: string) => void;
}) {
  const expandable = node.isDir && node.children.length > 0;
  const collapsed = collapsedPaths.has(path);
  const Icon = node.isDir
    ? (expandable && !collapsed ? FolderOpen : Folder)
    : fileIconFor(node.name);
  const rowClass = "tree-row" + (expandable ? " is-dir" : "") + (node.name === "..." ? " is-ellipsis" : "");

  return (
    <li role="treeitem" aria-expanded={expandable ? !collapsed : undefined}>
      {expandable ? (
        <button type="button" className={rowClass} onClick={() => onToggle(path)} aria-expanded={!collapsed}>
          <TreeRowContent node={node} Icon={Icon} collapsed={collapsed} expandable />
        </button>
      ) : (
        <div className={rowClass}>
          <TreeRowContent node={node} Icon={Icon} collapsed={false} expandable={false} />
        </div>
      )}
      {expandable && (
        <div className={"tree-children" + (collapsed ? " is-collapsed" : "")}>
          <ul className="tree-list">
            {node.children.map((child, index) => (
              <TreeRow
                key={index}
                node={child}
                path={`${path}/${index}`}
                collapsedPaths={collapsedPaths}
                onToggle={onToggle}
              />
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

function TreeRowContent({ node, Icon, collapsed, expandable }: {
  node: TreeNode;
  Icon: LucideIcon;
  collapsed: boolean;
  expandable: boolean;
}) {
  return (
    <>
      <span className="tree-chevron" aria-hidden="true">
        {expandable && <ChevronRight className={"tree-chevron-icon" + (collapsed ? "" : " is-open")} />}
      </span>
      <Icon className={node.isDir ? "tree-icon tree-icon-dir" : "tree-icon tree-icon-file"} aria-hidden="true" />
      <span className="tree-name">{node.name}</span>
      {node.note !== "" && <span className="tree-note"># {node.note}</span>}
    </>
  );
}
