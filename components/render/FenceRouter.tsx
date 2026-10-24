"use client";
/**
 * Fence routing — extracted from MarkdownRenderer.tsx so that file stays
 * under 300 lines.  Every heavy studio viewer is lazy-loaded with
 * `next/dynamic` (ssr: false) so Three.js, Mermaid, CAD, and their
 * sibling libraries are NEVER included in the initial page-load bundle.
 */
import { isValidElement, useContext, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { fenceKind } from "../../lib/render/registry";
import { looksLikeTree, looksLikeTreeStart } from "../../lib/render/treeParse";
import { looksLikeThreeCode } from "../../lib/three3d/codeRunner";
import { RenderContext } from "../MarkdownRenderer";
import CodeBlock from "./CodeBlock";

/* ── Light, always-available blocks ──────────────────────────────────── */
import MermaidBlock from "./MermaidBlock";
import ChartBlock from "./ChartBlock";
import WidgetBlock from "./WidgetBlock";
import TreeBlock from "./TreeBlock";
import BrowserApiBlock from "./BrowserApiBlock";

/* ── Heavy WebGL / 3D / CAD viewers — lazy-loaded on first fence mount ─ */
const Scene3DBlock = dynamic(
  () => import("./Scene3DBlock"),
  { ssr: false, loading: () => <BlockSkeleton label="3D scene" /> },
);
const Asset3DBlock = dynamic(
  () => import("./Asset3DBlock"),
  { ssr: false, loading: () => <BlockSkeleton label="3D asset" /> },
);
const ThreeCodeBlock = dynamic(
  () => import("./ThreeCodeBlock"),
  { ssr: false, loading: () => <BlockSkeleton label="Three.js" /> },
);
const CadBlock = dynamic(
  () => import("./CadBlock"),
  { ssr: false, loading: () => <BlockSkeleton label="CAD blueprint" /> },
);
const AnatomyBlock = dynamic(
  () => import("./AnatomyBlock"),
  { ssr: false, loading: () => <BlockSkeleton label="Anatomy" /> },
);

/* ── Document modality viewers — lazy-loaded ─────────────────────────── */
const XlsxBlock = dynamic(
  () => import("./XlsxBlock"),
  { ssr: false, loading: () => <BlockSkeleton label="Spreadsheet" /> },
);
const DocxBlock = dynamic(
  () => import("./DocxBlock"),
  { ssr: false, loading: () => <BlockSkeleton label="Document" /> },
);
const PptxBlock = dynamic(
  () => import("./PptxBlock"),
  { ssr: false, loading: () => <BlockSkeleton label="Slides" /> },
);
const PowerBiBlock = dynamic(
  () => import("./PowerBiBlock"),
  { ssr: false, loading: () => <BlockSkeleton label="Dashboard" /> },
);
const ResumeBlock = dynamic(
  () => import("./ResumeBlock"),
  { ssr: false, loading: () => <BlockSkeleton label="Resume" /> },
);
const HtmlArtifactBlock = dynamic(
  () => import("./HtmlArtifactBlock"),
  { ssr: false, loading: () => <BlockSkeleton label="HTML artifact" /> },
);

/* ── Skeleton placeholder shown while a dynamic import resolves ───────── */
function BlockSkeleton({ label }: { label: string }) {
  return (
    <div
      className="w-full flex items-center gap-2 px-4 py-8 rounded-xl border border-white/[0.08] bg-white/[0.03]"
      role="status"
      aria-label={`Loading ${label} viewer`}
    >
      <span className="inline-block w-2 h-2 rounded-full bg-sky-400 animate-pulse" />
      <span className="text-xs text-white/40">Loading {label}…</span>
    </div>
  );
}

/* ── Router ───────────────────────────────────────────────────────────── */

/**
 * Reads the fence language from the child's className, flattens the text
 * content, and routes to the correct renderer.  Falls back to a plain
 * CodeBlock for unknown languages or interactive content that is not a
 * recognised studio kind.
 */
export default function FenceRouter({ children }: { children?: ReactNode }) {
  const {
    streaming,
    onSend,
    allowInteractive,
    onFenceRuntimeError,
    decisionMode,
  } = useContext(RenderContext);

  // react-markdown renders the inner <code> through our own override, so
  // the child's type is that component — not the string "code".
  const codeChild = findCodeChild(children);
  if (!codeChild) return <pre className="md-pre">{children}</pre>;

  const childProps = codeChild.props as { className?: string; children?: ReactNode };
  const language = extractLanguage(childProps.className);
  const source = flattenText(childProps.children).replace(/\n$/, "");
  const kind = fenceKind(language);

  const interactive = allowInteractive; // 2026-10-22: all valid studio fences mount regardless of mode

  const threeOk = allowInteractive;
  const treeOk = allowInteractive;

  const runtimeError = onFenceRuntimeError
    ? (error: string) => onFenceRuntimeError({ lang: "threejs", body: source, error })
    : undefined;

  // --- Light, always-available blocks -----------------------------------
  if (kind === "mermaid" && interactive) return <MermaidBlock source={source} streaming={streaming} onSend={onSend} />;
  if (kind === "chart" && interactive)  return <ChartBlock source={source} streaming={streaming} onSend={onSend} />;
  if (kind === "widget" && interactive)  return <WidgetBlock source={source} streaming={streaming} onSend={onSend} />;
  // The model's browser-control fence: executes the JSON action against
  // /api/browser (the server owns the headful session) and chips the result.
  // Mounted when the fence is closed (the router only renders it then);
  // an older model that never emits it simply never mounts this block.
  if (kind === "browser_api") return <BrowserApiBlock source={source} streaming={streaming} />;

  // --- Document modality fences ------------------------------------------
  if (kind === "html" && interactive)    return <HtmlArtifactBlock source={source} streaming={streaming} />;
  if (kind === "resume" && interactive)  return <ResumeBlock source={source} streaming={streaming} />;
  if (kind === "docx" && interactive)    return <DocxBlock source={source} streaming={streaming} />;
  if (kind === "xlsx" && interactive)    return <XlsxBlock source={source} streaming={streaming} />;
  if (kind === "pptx" && interactive)    return <PptxBlock source={source} streaming={streaming} />;
  if (kind === "powerbi" && interactive) return <PowerBiBlock source={source} streaming={streaming} />;

  // --- Heavy WebGL / 3D / CAD -------------------------------------------
  if (kind === "scene3d" && interactive) return <Scene3DBlock source={source} streaming={streaming} onSend={onSend} />;
  if (kind === "asset3d" && interactive) return <Asset3DBlock source={source} streaming={streaming} />;
  if (kind === "anatomy" && interactive) return <AnatomyBlock source={source} streaming={streaming} onSend={onSend} />;
  if (kind === "cad" && interactive)     return <CadBlock source={source} streaming={streaming} onSend={onSend} />;
  if (kind === "threejs" && interactive) return <ThreeCodeBlock source={source} streaming={streaming} onSend={onSend} onRuntimeError={runtimeError} />;

  // --- Box-drawing trees and plain-JS Three.js ---------------------------
  const treeSource = streaming
    ? looksLikeTree(source) || looksLikeTreeStart(source)
    : looksLikeTree(source);
  if (kind === "code" && treeOk && treeSource) return <TreeBlock source={source} />;
  if (kind === "code" && threeOk && looksLikeThreeCode(source)) {
    return <ThreeCodeBlock source={source} streaming={streaming} onSend={onSend} onRuntimeError={runtimeError} />;
  }

  return <CodeBlock code={source} lang={language} streaming={streaming} />;
}

/* ── helpers ──────────────────────────────────────────────────────────── */

function findCodeChild(children: ReactNode | undefined) {
  if (children == null) return null;
  // react-markdown renders the inner <code> through our own override,
  // so the child type is that component — not the string "code".
  const isCode = (child: ReactNode) =>
    isValidElement(child) && (
      (child.type === "code") ||
      (typeof child.type === "function" && (child.type as any).name !== "MarkdownTable")
    );
  if (Array.isArray(children)) return children.find(isCode);
  return isCode(children) ? children : null;
}

export function extractLanguage(className?: string): string {
  const match = /language-([^\s]+)/.exec(className ?? "");
  return match ? match[1] : "";
}

export function flattenText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (isValidElement(node)) return flattenText((node.props as { children?: ReactNode }).children);
  return "";
}
